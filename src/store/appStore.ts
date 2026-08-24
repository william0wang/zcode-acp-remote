import { create } from "zustand";
import { AcpConnection } from "../lib/acp";
import { HubApiError, HubClient } from "../lib/hub";
import {
  clearProfileStorage,
  loadLang,
  loadPending,
  loadProfile,
  saveLang,
  savePending,
  saveProfile as persistProfile,
  type Lang,
} from "../lib/storage";
import {
  contentDiffBlocks,
  contentText,
  type AccountUsageStats,
  type AttachmentDraft,
  type ChatMessage,
  type ChatPart,
  type ConfigOption,
  type ConnectionProfile,
  type ContextUsage,
  type FsListing,
  type GoUsageStats,
  type GoWindowEntry,
  type GlmUsageStats,
  type HubInstance,
  type HubUpgradeResult,
  type PromptDraft,
  type QuotaItem,
  type SessionUpdate,
  type SlashCommand,
  type ToolCallPart,
} from "../lib/types";

export type ConnState = "idle" | "connecting" | "open" | "reconnecting";

// Server-side tail replay (REMOTE-CLIENTS.md "Tail replay and history
// pagination"): attach ships only the last REPLAY_TAIL_LIMIT messages;
// older pages arrive via session/load_earlier.
const REPLAY_TAIL_LIMIT = 30;
const EARLIER_PAGE_LIMIT = 50;

interface ReplayMeta {
  cursor?: string;
  hasMore?: boolean;
  totalMessages?: number;
  // Bridge flag: a turn is still in flight for this session (someone else's
  // prompt, or one that survived our reconnect) — restore the running UI.
  turnActive?: boolean;
}

function readReplayMeta(result: unknown): ReplayMeta | null {
  if (typeof result !== "object" || result === null) return null;
  const meta = (result as { replayMeta?: unknown }).replayMeta;
  return typeof meta === "object" && meta !== null
    ? (meta as ReplayMeta)
    : null;
}

// Validates an account/usage_stats result into the combined GLM + Opencode
// Go shape; null when the payload doesn't fit (treated like a failed fetch).
function parseUsageStats(result: unknown): AccountUsageStats | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as { glm?: unknown; opencode?: unknown };
  if (typeof r.glm !== "object" || r.glm === null) return null;
  if (typeof r.opencode !== "object" || r.opencode === null) return null;

  const glm = r.glm as Partial<GlmUsageStats>;
  const go = r.opencode as Partial<GoUsageStats>;
  const items = Array.isArray(glm.items)
    ? glm.items.filter((it) => it && typeof it.usedPercent === "number")
    : undefined;
  const windows = Array.isArray(go.windows)
    ? go.windows.filter((w) => w && typeof w.usagePercent === "number")
    : undefined;

  return {
    glm: {
      kind: (
        ["success", "auth_error", "rate_limited", "unavailable"] as const
      ).includes(glm.kind as GlmUsageStats["kind"])
        ? (glm.kind as GlmUsageStats["kind"])
        : "unavailable",
      ...(typeof glm.level === "string" ? { level: glm.level } : {}),
      ...(items ? { items: items as QuotaItem[] } : {}),
    },
    opencode: {
      kind: (
        ["success", "not_configured", "auth_error", "unavailable"] as const
      ).includes(go.kind as GoUsageStats["kind"])
        ? (go.kind as GoUsageStats["kind"])
        : "unavailable",
      ...(windows ? { windows: windows as GoWindowEntry[] } : {}),
    },
  };
}

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

// Context resolved for the approval card. The request params alone carry
// almost nothing readable; the interesting text (plan, question) rides on the
// tool_call the bridge emits right before the request (ADR 0003).
export interface ApprovalContext {
  toolCallId?: string;
  toolName?: string;
  kind?: string;
  title?: string;
  // Plan text (ExitPlanMode) or question text (AskUserQuestion), from the
  // matched tool_call's content.
  detail?: string;
  plan?: string;
  rawInputText?: string;
}

export interface PendingPermission {
  requestId: number;
  sessionId: string;
  options: PermissionOption[];
  context?: ApprovalContext;
}

// One AskUserQuestion field parsed out of an elicitation/create form
// (bridge builds the schema: `q_<i>` enum/array + `q_<i>_other` free text).
export interface ElicitField {
  // Field key in requestedSchema (q_0, q_1, …) and its free-text companion.
  key: string;
  otherKey: string | null;
  question: string;
  multi: boolean;
  options: { value: string; label: string }[];
}

export interface PendingElicitation {
  requestId: number;
  sessionId: string;
  message: string;
  fields: ElicitField[];
}

// Per-session display state for the session list. Bridge broadcasts fan out
// across ALL sessions of the instance, so non-active sessions are tracked
// too. Not persisted: after a reconnect other sessions read as idle until the
// next broadcast event.
export interface SessionActivity {
  running: boolean;
  awaitingPermission: boolean;
  finishedAt?: number;
}

// One todo/plan entry; `status` is "pending" | "active" | "completed".
export interface PlanEntry {
  content: string;
  status?: string;
}

interface AppState {
  profile: ConnectionProfile | null;
  lang: Lang;
  instances: HubInstance[];
  instancesError: string | null;
  // Hub unreachable (editor exited — it re-spawns the hub on demand). Expected
  // state, rendered as a calm hint; polling continues until it returns.
  hubOffline: boolean;
  connState: ConnState;
  instanceId: string | null;
  activeSessionId: string | null;
  messages: ChatMessage[];
  planEntries: PlanEntry[] | null;
  isRunning: boolean;
  // Follow-ups typed while a turn is running or a replay is still loading;
  // flushed in order the moment the prompt settles / the session attaches.
  // Keyed by sessionId and persisted — drafts survive session switches and
  // app restarts.
  pendingPrompts: Record<string, PromptDraft[]>;
  permission: PendingPermission | null;
  // AskUserQuestion via elicitation/create (the bridge's preferred channel
  // once ANY client advertises elicitation.form — capabilities OR-merge).
  elicitation: PendingElicitation | null;
  notice: string | null;
  // Pagination state from the attach response's replayMeta.
  replayCursor: string | null;
  hasMore: boolean;
  totalMessages: number | null;
  loadingEarlier: boolean;
  // Session config (model/mode/thought) + context usage, from the attach
  // response and config_option_update / current_mode_update / usage_update.
  configOptions: ConfigOption[];
  currentModeId: string | null;
  usage: ContextUsage | null;
  // Slash commands from available_commands_update (overwrite semantics),
  // driving the "/" completion menu in the composer.
  availableCommands: SlashCommand[];
  // Account-level quota (account/usage_stats): the combined GLM + Opencode
  // Go structure mirroring the zcode-quota CLI card, pulled after connect.
  usageStats: AccountUsageStats | null;
  // Epoch ms of the last successful quota fetch — shown so the user can tell
  // whether a refresh actually landed.
  usageStatsAt: number | null;
  // Per-session running/permission state from bridge-wide broadcasts.
  sessionStates: Record<string, SessionActivity>;
  // Last quota fetch failed — keep the section header + Refresh visible so a
  // long-lived connection can still retry (REMOTE-CLIENTS: hide data, retry later).
  quotaUnavailable: boolean;
  // Bridge advertised session file access (initialize agentCapabilities
  // `_meta.zcode.fs`, server 0.7.0+); gates the file browser entry (ADR-0005).
  fsCapable: boolean;
  loadingSession: boolean;

  init: () => void;
  connectToHub: (profile: ConnectionProfile) => void;
  forgetHub: () => void;
  setLang: (lang: Lang) => void;
  refreshInstances: (opts?: { probe?: boolean }) => Promise<void>;
  upgradeHub: () => Promise<HubUpgradeResult>;
  connectInstance: (
    instanceId: string,
    attachSessionId?: string,
  ) => Promise<void>;
  openSession: (instanceId: string, sessionId: string) => Promise<void>;
  // Foreground wake hook: proves the WS pipe is actually alive (Android deep
  // sleep leaves zombie sockets that never fire onclose) and reconnects if
  // not. Registered at module level via visibilitychange.
  wakeProbe: () => void;
  // Returns to the session list. The instance connection stays open so
  // bridge broadcasts keep the list's activity badges live (running state
  // is broadcast-only — the hub's REST discovery carries no such field);
  // re-entering a session on the same instance reuses the socket.
  closeSession: () => void;
  loadSession: (sessionId: string) => Promise<void>;
  // Retires a session from remote discovery via the hub's HTTP close
  // endpoint (ADR-0006). Close, not delete — editor-side-still-open
  // conversations self-heal back on their next use. Refused (409 notice)
  // while a turn runs.
  closeRemoteSession: (instanceId: string, sessionId: string) => Promise<void>;
  // Renames a session via the hub's HTTP rename endpoint (bridge 0.11.9).
  // The one-shot auto-title never revises a title; this is the manual path.
  // Updates the local list optimistically; the bridge broadcasts the change
  // to attached clients and the next discovery poll reconciles.
  renameSession: (
    instanceId: string,
    sessionId: string,
    title: string,
  ) => Promise<void>;
  loadEarlier: () => Promise<boolean>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  refreshUsageStats: () => Promise<void>;
  // Session Files (ADR-0005): read-only browse/view over hub REST, scoped to
  // the active instance + session. Null = not connected / request failed.
  fsList: (path: string) => Promise<FsListing | null>;
  fsFileText: (
    path: string,
    line: number,
    limit: number,
  ) => Promise<{ firstLine: number; text: string } | null>;
  fsFileUrl: (path: string) => string | null;
  sendPrompt: (text: string, images?: AttachmentDraft[]) => Promise<void>;
  runPrompt: (draft: PromptDraft) => Promise<void>;
  // Interrupts the running turn so the queued follow-up goes out immediately.
  forceSendPending: () => void;
  discardPending: (index: number) => void;
  cancelTurn: () => void;
  answerPermission: (requestId: number, optionId: string) => void;
  // Resolves a pending elicitation form: content answers it (accept), null
  // declines. Same first-response-wins race as permissions.
  answerElicitation: (
    requestId: number,
    content: Record<string, string | string[]> | null,
  ) => void;
  dismissNotice: () => void;
  // Ephemeral UI feedback (copy confirmations etc.); auto-clears with the
  // existing notice banner.
  notify: (text: string) => void;
}

// Module singletons: connection + timers live outside React state.
let acp: AcpConnection | null = null;
// Events from superseded connections must be ignored (their async onclose
// can fire after a new connection to the SAME instance was started).
let connSeq = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let msgCounter = 0;
// Consecutive network-level discovery failures. A phone's network stack
// takes a moment after launch — the first failed poll means "not yet",
// not "hub down"; only DISCOVERY_FAIL_THRESHOLD in a row earn the banner.
let discoveryFailures = 0;
const DISCOVERY_FAIL_THRESHOLD = 3;

// Connection-level failures are transient by design: the reconnect loop
// (and its banner) own that story, and a successful reconnect replays the
// session back to freshness. Only settled failures deserve a notice.
function isTransientConnError(e: unknown): boolean {
  if (e instanceof HubApiError) return e.network;
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("connection closed") || msg.includes("connection not open")
  );
}

function stopReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export const useAppStore = create<AppState>((set, get) => {
  function hub(): HubClient | null {
    const p = get().profile;
    return p ? new HubClient(p.hubUrl, p.token) : null;
  }

  // True while a session/prompt WE sent is in flight. Turn-end notifications
  // ($/zcode/turnState) arrive before the prompt response; those turns flush
  // their queue in runPrompt's finally, so the notification path must not
  // double-flush (it only handles restored/foreign turns).
  let localPromptActive = false;

  // Single flush point for the pending queue: after a local turn settles,
  // after a restored (bridged) turn ends, and when an attach lands. The
  // check-then-run is synchronous, so concurrent callers stay safe.
  function flushPending(): void {
    const s = get();
    if (s.connState !== "open" || !s.activeSessionId) return;
    if (s.loadingSession || s.isRunning) return;
    const next = s.pendingPrompts[s.activeSessionId]?.[0];
    if (next == null) return;
    setQueue(s.activeSessionId, s.pendingPrompts[s.activeSessionId].slice(1));
    void get().runPrompt(next);
  }

  // Every queue mutation goes through here so state and localStorage stay in
  // sync (drafts must survive switches/restarts). Empty queues drop the key.
  function setQueue(sid: string, next: PromptDraft[]): void {
    set((state) => {
      const map = { ...state.pendingPrompts };
      if (next.length > 0) map[sid] = next;
      else delete map[sid];
      savePending(map);
      return { pendingPrompts: map };
    });
  }

  /**
   * The instance's workspace label from the hub list, or undefined when the
   * list is stale/missing this instance. Callers that must send a cwd
   * (session/load's SDK schema requires one) fall back to "/" — safe because
   * the bridge ignores the load cwd entirely: session roots are
   * backend-authoritative, never taken from the client.
   */
  function instanceWorkspace(): string | undefined {
    const s = get();
    const inst = s.instances.find((i) => i.id === s.instanceId);
    const ws = inst?.workspace;
    return ws && ws !== "/" ? ws : undefined;
  }

  function startPolling(): void {
    if (pollTimer) return;
    void get().refreshInstances();
    pollTimer = setInterval(() => void get().refreshInstances(), 4000);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---- session/update -> chat model ----

  function ensureMessage(
    msgs: ChatMessage[],
    role: "user" | "assistant",
  ): { messages: ChatMessage[]; message: ChatMessage } {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) return { messages: msgs, message: last };
    const message: ChatMessage = {
      id: `m${++msgCounter}`,
      role,
      parts: [],
      createdAt: Date.now(),
    };
    return { messages: [...msgs, message], message };
  }

  function appendTextPart(
    message: ChatMessage,
    text: string,
    partType: "text" | "thought",
  ): ChatMessage {
    const lastPart = message.parts[message.parts.length - 1];
    if (lastPart && lastPart.type === partType) {
      const parts = [
        ...message.parts.slice(0, -1),
        { type: partType, text: lastPart.text + text } as ChatPart,
      ];
      return { ...message, parts };
    }
    return {
      ...message,
      parts: [...message.parts, { type: partType, text } as ChatPart],
    };
  }

  // With a messageId, chunks group into that exact message (backend ids are
  // stable and dedupe across replay pages; thought ids carry a `thought_`
  // prefix and form their own stream). Without one, fall back to merging
  // into the trailing same-role message.
  function appendChunkMessage(
    msgs: ChatMessage[],
    u: SessionUpdate,
    role: "user" | "assistant",
    text: string,
    partType: "text" | "thought",
  ): ChatMessage[] {
    const mid =
      typeof u.messageId === "string" && u.messageId ? u.messageId : null;
    if (mid) {
      const i = msgs.findIndex((m) => m.id === mid);
      if (i >= 0)
        return patchMessage(msgs, i, appendTextPart(msgs[i], text, partType));
      return [
        ...msgs,
        {
          id: mid,
          role,
          parts: [{ type: partType, text } as ChatPart],
          createdAt: Date.now(),
        },
      ];
    }
    const ensured = ensureMessage(msgs, role);
    return ensured.messages.map((m) =>
      m.id === ensured.message.id ? appendTextPart(m, text, partType) : m,
    );
  }

  function patchMessage(
    msgs: ChatMessage[],
    i: number,
    m: ChatMessage,
  ): ChatMessage[] {
    return msgs.slice(0, i).concat(m, msgs.slice(i + 1));
  }

  // `_meta.zcode.collapsed` on a replayed user chunk (context handoff and
  // similar harness blocks) — the UI renders those behind an expand control.
  function isCollapsedMeta(meta: unknown): boolean {
    if (typeof meta !== "object" || meta === null) return false;
    const zcode = (meta as { zcode?: { collapsed?: unknown } }).zcode;
    return (
      typeof zcode === "object" && zcode !== null && zcode.collapsed === true
    );
  }

  // Applies one update; returns a partial state patch, or null when nothing
  // changed. Message kinds operate on the given array; session-level kinds
  // (config/usage) carry their own values.
  function applyOne(
    msgs: ChatMessage[],
    u: SessionUpdate,
    meta?: unknown,
  ): {
    messages?: ChatMessage[];
    planEntries?: PlanEntry[] | null;
    configOptions?: ConfigOption[];
    currentModeId?: string;
    usage?: ContextUsage;
    availableCommands?: SlashCommand[];
  } | null {
    const kind = u.sessionUpdate;

    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      const text = contentText(u.content);
      if (!text) return null;
      let next = appendChunkMessage(msgs, u, role, text, "text");
      if (role === "user" && isCollapsedMeta(meta)) {
        const mid = typeof u.messageId === "string" ? u.messageId : "";
        const i = next.findIndex((m) => m.id === mid && !m.collapsed);
        if (i >= 0)
          next = patchMessage(next, i, { ...next[i], collapsed: true });
      }
      return { messages: next };
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(u.content);
      if (!text) return null;
      return {
        messages: appendChunkMessage(msgs, u, "assistant", text, "thought"),
      };
    }
    if (kind === "tool_call") {
      const updateMeta = u._meta as
        | {
            claudeCode?: { toolName?: unknown };
            zcode?: { collapsed?: unknown; kind?: unknown };
          }
        | undefined;
      const meta = updateMeta?.claudeCode;
      // Replay harness folds (server 0.6.0): handoff summaries and rewritten
      // tool transcripts arrive as completed tool_calls flagged in _meta.zcode.
      const fold =
        updateMeta?.zcode?.collapsed === true &&
        typeof updateMeta.zcode.kind === "string"
          ? updateMeta.zcode.kind
          : null;
      // The bridge ships the plan/question text as the tool_call's initial
      // content — keep it in detail so approval cards can show it.
      const part = {
        type: "tool-call" as const,
        toolCallId: String(u.toolCallId ?? ""),
        toolName: String(u.title ?? "tool"),
        detail: contentText(u.content),
        status: String(u.status ?? "pending"),
        ...(typeof u.kind === "string" ? { kind: u.kind } : {}),
        ...(fold ? { foldKind: fold } : {}),
        ...(typeof meta?.toolName === "string"
          ? { rawName: meta.toolName }
          : {}),
        ...(() => {
          const diffs = contentDiffBlocks(u.content);
          return diffs.length ? { diffs } : {};
        })(),
      };
      const mid =
        typeof u.messageId === "string" && u.messageId ? u.messageId : null;
      // Dedupe on every insert (REPLAY-GUIDE contract): a reannounced
      // interaction (e.g. a still-pending plan approval) reuses its
      // toolCallId, and replay can deliver the same historical call again —
      // assistant-ui keys parts by toolCallId and throws on duplicates.
      // Replace the existing part in place instead of appending a second.
      const dupAt = findToolCallPartIndex(msgs, part.toolCallId);
      if (dupAt) {
        const { mi, pi } = dupAt;
        return {
          messages: patchMessage(msgs, mi, {
            ...msgs[mi],
            parts: msgs[mi].parts.map((p, j) => (j === pi ? part : p)),
          }),
        };
      }
      if (mid) {
        const i = msgs.findIndex((m) => m.id === mid);
        if (i >= 0) {
          return {
            messages: patchMessage(msgs, i, {
              ...msgs[i],
              parts: [...msgs[i].parts, part],
            }),
          };
        }
        return {
          messages: [
            ...msgs,
            {
              id: mid,
              role: "assistant",
              parts: [part],
              createdAt: Date.now(),
            },
          ],
        };
      }
      const ensured = ensureMessage(msgs, "assistant");
      return {
        messages: ensured.messages.map((m) =>
          m.id === ensured.message.id ? { ...m, parts: [...m.parts, part] } : m,
        ),
      };
    }
    if (kind === "tool_call_update") {
      const toolCallId = String(u.toolCallId ?? "");
      const chunk = contentText(u.content);
      const diffBlocks = contentDiffBlocks(u.content);
      // Terminal-channel Bash (enabled while an editor client is attached):
      // output streams as _meta.terminal_output.data deltas — append them so
      // the card keeps its output; the terminal_exit update then only closes.
      const termData = (
        u._meta as { terminal_output?: { data?: unknown } } | undefined
      )?.terminal_output?.data;
      const termText = typeof termData === "string" ? termData : null;
      // Non-terminal tools may carry a rawOutput string without content blocks.
      const rawOut = typeof u.rawOutput === "string" ? u.rawOutput : null;
      // An update carrying content blocks REPLACES the whole collection
      // (text and diffs); a status-only update leaves them untouched.
      const hasContent =
        u.content != null &&
        (!Array.isArray(u.content) || u.content.length > 0);
      const status = typeof u.status === "string" ? u.status : null;
      // Search backwards: the tool call may live in an earlier assistant
      // message when other clients' turns interleaved.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        if (
          !m.parts.some(
            (p) => p.type === "tool-call" && p.toolCallId === toolCallId,
          )
        ) {
          continue;
        }
        const patched = {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "tool-call" && p.toolCallId === toolCallId
              ? {
                  ...p,
                  detail: termText
                    ? p.detail + termText
                    : chunk || rawOut || p.detail,
                  status: status ?? p.status,
                  ...(hasContent
                    ? { diffs: diffBlocks.length ? diffBlocks : undefined }
                    : {}),
                }
              : p,
          ),
        };
        return {
          messages: msgs.slice(0, i).concat(patched, msgs.slice(i + 1)),
        };
      }
      return null;
    }
    if (kind === "plan") {
      // Plan updates are full snapshots; render the latest one as a live
      // status area outside the message stream.
      const raw = Array.isArray(u.entries) ? u.entries : [];
      const entries = raw
        .map((e) => {
          const entry = e as { content?: string; status?: string };
          return {
            content: entry.content ?? "",
            ...(typeof entry.status === "string"
              ? { status: entry.status }
              : {}),
          } satisfies PlanEntry;
        })
        .filter((e) => e.content);
      return { planEntries: entries.length ? entries : null };
    }
    if (kind === "config_option_update") {
      const opts = Array.isArray(u.configOptions)
        ? (u.configOptions as ConfigOption[])
        : null;
      return opts ? { configOptions: opts } : null;
    }
    if (kind === "current_mode_update") {
      return typeof u.currentModeId === "string"
        ? { currentModeId: u.currentModeId }
        : null;
    }
    if (kind === "usage_update") {
      const used = typeof u.used === "number" ? u.used : null;
      const size = typeof u.size === "number" ? u.size : null;
      return used != null && size != null ? { usage: { used, size } } : null;
    }
    if (kind === "available_commands_update") {
      // Full snapshot, overwrite semantics — the bridge re-sends it after
      // each session/load, so keep the latest list.
      const list = Array.isArray(u.availableCommands)
        ? u.availableCommands
        : null;
      if (!list) return null;
      const commands = list.filter(
        (c): c is SlashCommand =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as SlashCommand).name === "string",
      );
      return { availableCommands: commands };
    }
    // Unknown kinds (additive-only contract): ignore.
    return null;
  }

  // Replay bursts hundreds of updates in one go; batching them into a single
  // store write keeps render cost O(bursts) instead of O(chunks).
  let updateQueue: { sessionId: string; u: SessionUpdate; meta?: unknown }[] =
    [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // While a session/load_earlier request is in flight its updates must be
  // PREPENDED, not appended — buffer them until the request resolves.
  let collectingEarlier = false;
  let earlierBuffer: { sessionId: string; u: SessionUpdate; meta?: unknown }[] =
    [];

  function dropQueuedUpdates(): void {
    updateQueue = [];
    collectingEarlier = false;
    earlierBuffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function applyUpdate(
    sessionId: string,
    u: SessionUpdate,
    meta?: unknown,
  ): void {
    updateQueue.push({ sessionId, u, meta });
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = updateQueue;
      updateQueue = [];
      set((state) => {
        let messages = state.messages;
        let planEntries = state.planEntries;
        let configOptions = state.configOptions;
        let currentModeId = state.currentModeId;
        let usage = state.usage;
        let availableCommands = state.availableCommands;
        for (const { sessionId: sid, u: upd, meta } of batch) {
          if (state.activeSessionId !== sid) continue;
          const r = applyOne(messages, upd, meta);
          if (!r) continue;
          if (r.messages) messages = r.messages;
          if (r.planEntries !== undefined) planEntries = r.planEntries;
          if (r.configOptions) configOptions = r.configOptions;
          if (r.currentModeId !== undefined) currentModeId = r.currentModeId;
          if (r.usage) usage = r.usage;
          if (r.availableCommands) availableCommands = r.availableCommands;
        }
        return {
          messages,
          planEntries,
          configOptions,
          currentModeId,
          usage,
          availableCommands,
        };
      });
    }, 120);
  }

  // ---- connection lifecycle ----

  // Bridge-wide broadcasts keep per-session activity for the session list
  // (awaiting confirmation > running > just finished > idle).
  function setActivity(
    sessionId: string,
    patch:
      | Partial<SessionActivity>
      | ((prev: SessionActivity) => Partial<SessionActivity>),
  ): void {
    set((state) => {
      const prev: SessionActivity = state.sessionStates[sessionId] ?? {
        running: false,
        awaitingPermission: false,
      };
      const next = {
        ...prev,
        ...(typeof patch === "function" ? patch(prev) : patch),
      };
      if (
        next.running === prev.running &&
        next.awaitingPermission === prev.awaitingPermission &&
        next.finishedAt === prev.finishedAt
      ) {
        return {};
      }
      return { sessionStates: { ...state.sessionStates, [sessionId]: next } };
    });
  }

  // Locates the tool_call part the bridge emits right before an interaction
  // request; its content holds the plan/question text (ADR 0003).
  function findToolCallPart(
    msgs: ChatMessage[],
    toolCallId: string,
  ): ToolCallPart | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p.type === "tool-call" && p.toolCallId === toolCallId) return p;
      }
    }
    return null;
  }

  // Same lookup, but returns message/part indices so the caller can replace
  // the part in place (tool_call dedup on insert).
  function findToolCallPartIndex(
    msgs: ChatMessage[],
    toolCallId: string,
  ): { mi: number; pi: number } | null {
    if (!toolCallId) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p.type === "tool-call" && p.toolCallId === toolCallId)
          return { mi: i, pi: j };
      }
    }
    return null;
  }

  function buildApprovalContext(
    params: Record<string, unknown>,
  ): ApprovalContext | undefined {
    const tc = (params.toolCall ?? null) as {
      toolCallId?: unknown;
      rawInput?: unknown;
    } | null;
    if (!tc || typeof tc !== "object") return undefined;
    const toolCallId =
      typeof tc.toolCallId === "string" && tc.toolCallId
        ? tc.toolCallId
        : undefined;
    const part = toolCallId
      ? findToolCallPart(get().messages, toolCallId)
      : null;
    const rawInput = tc.rawInput;
    const plan =
      rawInput &&
      typeof rawInput === "object" &&
      typeof (rawInput as { plan?: unknown }).plan === "string"
        ? (rawInput as { plan: string }).plan
        : undefined;
    let rawInputText: string | undefined;
    if (rawInput != null) {
      try {
        rawInputText =
          typeof rawInput === "string"
            ? rawInput
            : JSON.stringify(rawInput, null, 2);
      } catch {
        rawInputText = String(rawInput);
      }
    }
    if (!toolCallId && rawInputText == null) return undefined;
    return {
      toolCallId,
      // Part fields first (richer); title = the wire title stored in toolName.
      toolName: part?.rawName ?? part?.toolName,
      kind: part?.kind,
      title: part?.toolName,
      detail: part?.detail,
      plan,
      rawInputText,
    };
  }

  // Parses an elicitation/create form (bridge's buildAskUserElicitationForm
  // shape) into renderable fields: `q_<i>` enum/array + `q_<i>_other`
  // free-text companion. The skip sentinel option is dropped — an unanswered
  // field IS the skip (the bridge's parser treats absent as skipped).
  function parseElicitationForm(params: Record<string, unknown>): {
    sessionId: string;
    message: string;
    fields: ElicitField[];
  } | null {
    const sessionId = String(params.sessionId ?? "");
    const message = typeof params.message === "string" ? params.message : "";
    const schema = params.requestedSchema as
      { properties?: Record<string, unknown> } | undefined;
    const props = schema?.properties;
    if (!sessionId || typeof props !== "object" || props === null) return null;
    const fields: ElicitField[] = [];
    for (const key of Object.keys(props)) {
      if (key.endsWith("_other")) continue;
      const prop = props[key] as
        | {
            type?: unknown;
            title?: unknown;
            oneOf?: Array<{ const?: unknown; title?: unknown }>;
            items?: { anyOf?: Array<{ const?: unknown; title?: unknown }> };
          }
        | undefined;
      if (!prop || typeof prop !== "object") continue;
      const variants = Array.isArray(prop.oneOf)
        ? prop.oneOf
        : Array.isArray(prop.items?.anyOf)
          ? (prop.items!.anyOf as Array<{ const?: unknown; title?: unknown }>)
          : null;
      if (!variants) continue; // not a question field (additive schema)
      const options = variants
        .filter((v) => typeof v.const === "string" && v.const !== "__skip__")
        .map((v) => ({
          value: v.const as string,
          label: typeof v.title === "string" ? v.title : (v.const as string),
        }));
      fields.push({
        key,
        otherKey:
          typeof props[`${key}_other`] === "object" ? `${key}_other` : null,
        question: typeof prop.title === "string" ? prop.title : key,
        multi: prop.type === "array",
        options,
      });
    }
    if (fields.length === 0) return null;
    return { sessionId, message, fields };
  }

  function scheduleReconnect(): void {
    const s = get();
    if (!s.profile || !s.instanceId) return;
    stopReconnect();
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
    set({ connState: "reconnecting" });
    reconnectTimer = setTimeout(() => void tryReconnect(), delay);
  }

  // Liveness probe for wake: the bridge's SDK answers unknown methods with an
  // immediate -32601, so ANY settle (even a rejection) within the timeout
  // proves the round-trip works. Only silence — or a locally-refused send —
  // means the socket is a zombie.
  function probeAlive(timeoutMs: number): Promise<boolean> {
    const conn = acp;
    if (!conn) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(alive);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      conn.request("$/zcode/ping").then(
        () => done(true),
        (e: Error) => done(e.message !== "connection not open"),
      );
    });
  }

  // Deep sleep on Android routinely kills the socket without ever delivering
  // onclose in the WebView: connState stays "open", every request silently
  // vanishes, and nothing schedules a reconnect. On foreground, probe the
  // pipe; a zombie is torn down exactly like an unexpected close so the
  // reconnect loop (and its replay) recover the session automatically.
  async function wakeProbe(): Promise<void> {
    const s = get();
    if (!s.profile || !s.instanceId || s.connState !== "open") return;
    if (await probeAlive(5000)) return;
    if (get().connState !== "open") return; // closed meanwhile — loop has it
    connSeq++;
    acp?.close();
    acp = null;
    pendingRespond = null;
    pendingElicitRespond = null;
    set({ permission: null, elicitation: null, sessionStates: {} });
    scheduleReconnect();
  }

  async function tryReconnect(): Promise<void> {
    const s = get();
    if (!s.profile || !s.instanceId) return;
    // Probe: a hard-killed bridge lingers in the heartbeat view for up to 30s,
    // which would keep the reconnect loop retrying a dead instance.
    await s.refreshInstances({ probe: true });
    // Re-read after the await: the hub/instance may have changed meanwhile.
    const cur = get();
    if (
      !cur.profile ||
      cur.profile !== s.profile ||
      cur.instanceId !== s.instanceId
    )
      return;
    // Hub unreachable or discovery failed (phone just woke, network not yet
    // ready): instance liveness is UNKNOWN, not "gone" — retry in place
    // instead of bouncing the user out of the session. Only a successful
    // listing that lacks the instance proves it gone.
    if (cur.hubOffline || cur.instancesError) {
      scheduleReconnect();
      return;
    }
    const still = cur.instances.some((i) => i.id === s.instanceId);
    if (!still) {
      // Instance gone: its sessions are gone too (contract).
      connSeq++;
      acp?.close();
      acp = null;
      dropQueuedUpdates();
      set({
        connState: "idle",
        instanceId: null,
        activeSessionId: null,
        messages: [],
        planEntries: null,
        permission: null,
        elicitation: null,
        notice: "notice.instanceGone",
        fsCapable: false,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        availableCommands: [],
        // usageStats stays (hub-level quota, not instance-scoped) — nothing
        // re-fetches it here, so clearing would blank the card until the
        // next app start.
        sessionStates: {},
        loadingSession: false,
        isRunning: false,
      });
      reconnectAttempt = 0;
      return;
    }
    await openConnection(cur.profile, cur.instanceId!);
  }

  async function openConnection(
    profile: ConnectionProfile,
    instanceId: string,
  ): Promise<void> {
    stopReconnect();
    const mySeq = ++connSeq;
    acp?.close();
    const stale = () => mySeq !== connSeq;
    const conn = new AcpConnection(profile.hubUrl, profile.token, instanceId, {
      onState: (state) => {
        if (stale()) return;
        if (state === "open") {
          reconnectAttempt = 0;
          // Activity is broadcast-only: a fresh connection knows nothing
          // until events arrive (active session's turnActive is restored by
          // loadSession's replay). Stale notices (e.g. from the dropped
          // connection's failed requests) die with it — the replay has
          // already superseded whatever they complained about.
          set({ connState: "open", sessionStates: {}, notice: null });
        } else if (state === "closed") {
          if (get().instanceId === instanceId) {
            // The pending permission/elicitation requests die with the
            // socket; don't leave dead dialogs that silently swallow taps.
            // Broadcast activity is equally untrustworthy now.
            pendingRespond = null;
            pendingElicitRespond = null;
            set({
              permission: null,
              elicitation: null,
              sessionStates: {},
            });
            scheduleReconnect();
          }
        }
      },
      onUpdate: (sessionId, update, meta) => {
        if (stale()) return;
        if (collectingEarlier && sessionId === get().activeSessionId) {
          earlierBuffer.push({ sessionId, u: update, meta });
          return;
        }
        applyUpdate(sessionId, update, meta);
      },
      onTurnState: (sessionId, running) => {
        if (stale()) return;
        setActivity(
          sessionId,
          running
            ? {
                running: true,
                awaitingPermission: false,
                finishedAt: undefined,
              }
            : {
                running: false,
                awaitingPermission: false,
                finishedAt: Date.now(),
              },
        );
        if (sessionId !== get().activeSessionId) return;
        if (running) {
          set({ isRunning: true });
          return;
        }
        // End-of-turn arrives BEFORE the prompt response for locally sent
        // turns (the bridge notifies in its finally, responds on return) —
        // those own their state in runPrompt's finally. Restored/foreign
        // turns have no local prompt in flight: settle here and flush.
        if (localPromptActive) return;
        set({ isRunning: false });
        flushPending();
      },
      onServerRequest: (req, respond) => {
        if (stale()) return;
        if (req.method === "session/request_permission") {
          const sessionId = String(req.params.sessionId ?? "");
          const options = Array.isArray(req.params.options)
            ? (req.params.options as PermissionOption[])
            : [];
          setActivity(sessionId, { awaitingPermission: true });
          set({
            permission: {
              requestId: req.id,
              sessionId,
              options: options.filter((o) => typeof o.optionId === "string"),
              context: buildApprovalContext(req.params),
            },
          });
          // respond is captured by answerPermission through the stored request id.
          pendingRespond = { id: req.id, respond };
        } else if (req.method === "elicitation/create") {
          // AskUserQuestion form (the bridge's preferred channel once any
          // client advertises elicitation.form — capabilities OR-merge, so
          // Zed's declaration routes OUR questions here too).
          const parsed = parseElicitationForm(req.params);
          if (parsed) {
            setActivity(parsed.sessionId, { awaitingPermission: true });
            set({ elicitation: { requestId: req.id, ...parsed } });
            pendingElicitRespond = { id: req.id, respond };
          } else {
            // Unparseable schema: decline rather than leave the request
            // dangling (first-response-wins; Zed may still answer).
            respond({ action: "decline" });
          }
        } else {
          // Other unsupported interaction. Deliberately NOT answered:
          // first-response-wins, and the primary editor client is always
          // attached (bridge lifetime = editor lifetime).
          set({ notice: "notice.unsupported" });
        }
      },
      onCancelRequest: (id) => {
        // We lost the Permission Race; drop the dialog(s).
        const lost = get().permission;
        if (lost?.requestId === id) {
          setActivity(lost.sessionId, { awaitingPermission: false });
          set({ permission: null });
          pendingRespond = null;
        }
        const lostForm = get().elicitation;
        if (lostForm?.requestId === id) {
          setActivity(lostForm.sessionId, { awaitingPermission: false });
          set({ elicitation: null });
          pendingElicitRespond = null;
        }
      },
    });
    acp = conn;
    try {
      const init = await conn.connect();
      if (stale()) return;
      set({ fsCapable: init.agentCapabilities?._meta?.zcode?.fs === true });
      const active = get().activeSessionId;
      if (active) {
        // Replay is the catch-up mechanism after any disconnect.
        await get().loadSession(active);
      }
    } catch {
      if (get().instanceId === instanceId) scheduleReconnect();
    }
  }

  let pendingRespond: {
    id: number;
    respond: (result: unknown) => void;
  } | null = null;
  let pendingElicitRespond: {
    id: number;
    respond: (result: unknown) => void;
  } | null = null;

  return {
    profile: null,
    lang: "en",
    instances: [],
    instancesError: null,
    hubOffline: false,
    connState: "idle",
    instanceId: null,
    activeSessionId: null,
    messages: [],
    pendingPrompts: loadPending(),
    planEntries: null,
    isRunning: false,
    permission: null,
    elicitation: null,
    notice: null,
    replayCursor: null,
    hasMore: false,
    totalMessages: null,
    loadingEarlier: false,
    configOptions: [],
    currentModeId: null,
    usage: null,
    availableCommands: [],
    usageStats: null,
    usageStatsAt: null,
    sessionStates: {},
    quotaUnavailable: false,
    fsCapable: false,
    loadingSession: false,

    init: () => {
      const profile = loadProfile();
      set({ profile, lang: loadLang() });
      if (profile) {
        startPolling();
        // Plain HTTP (no instance connection needed); slow-moving data.
        void get().refreshUsageStats();
      }
    },

    connectToHub: (profile) => {
      persistProfile(profile);
      discoveryFailures = 0;
      set({ profile, instances: [], instancesError: null, hubOffline: false });
      startPolling();
      void get().refreshUsageStats();
    },

    forgetHub: () => {
      stopPolling();
      stopReconnect();
      connSeq++; // invalidate any in-flight connection events
      acp?.close();
      acp = null;
      pendingRespond = null;
      reconnectAttempt = 0;
      dropQueuedUpdates();
      clearProfileStorage();
      savePending({});
      set({
        profile: null,
        instances: [],
        instancesError: null,
        hubOffline: false,
        connState: "idle",
        instanceId: null,
        activeSessionId: null,
        messages: [],
        pendingPrompts: {},
        planEntries: null,
        permission: null,
        elicitation: null,
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        availableCommands: [],
        usageStats: null,
        usageStatsAt: null,
        sessionStates: {},
        quotaUnavailable: false,
        loadingSession: false,
      });
    },

    setLang: (lang) => {
      saveLang(lang);
      set({ lang });
    },

    refreshInstances: async (opts?: { probe?: boolean }) => {
      const client = hub();
      if (!client) return;
      const profile = get().profile;
      try {
        const instances = await client.instances(opts?.probe === true);
        if (get().profile !== profile) return; // hub changed mid-flight
        discoveryFailures = 0;
        set({ instances, instancesError: null, hubOffline: false });
      } catch (e) {
        if (get().profile !== profile) return;
        if (e instanceof HubApiError && e.network) {
          // Hub unreachable is expected while no editor runs (bridges
          // re-spawn it on demand) — but only say so once it has STAYED
          // unreachable: early polls race the phone's network stack, and a
          // transient blip must not flash the banner (or blank the list).
          discoveryFailures++;
          if (discoveryFailures >= DISCOVERY_FAIL_THRESHOLD) {
            set({ instances: [], instancesError: null, hubOffline: true });
          }
          return;
        }
        const msg =
          e instanceof HubApiError
            ? e.message
            : `discovery failed: ${(e as Error).message}`;
        set({ instancesError: msg, hubOffline: false });
      }
    },

    // Trigger the hub's SELF-decided upgrade check (bridge 0.11.7): POST
    // /api/upgrade, and if the hub judged the on-disk code newer (it exits
    // ~500ms after replying, re-spawning onto the new dist), poll health
    // until the respawn answers, then refresh discovery. The restart
    // decision is entirely the hub's — this only triggers the check.
    upgradeHub: async () => {
      const client = hub();
      if (!client) throw new Error("not connected");
      const result = await client.upgrade();
      if (!result.restarting) return result;
      const deadline = Date.now() + 30_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await client.health();
          break;
        } catch {
          // Still down mid-respawn — keep polling until the deadline; the
          // 4s discovery poll heals the list even if we give up here.
          if (Date.now() > deadline) break;
        }
      }
      await get().refreshInstances({ probe: true });
      return result;
    },

    connectInstance: async (instanceId, attachSessionId) => {
      const s = get();
      if (!s.profile) return;
      stopReconnect();
      reconnectAttempt = 0;
      pendingRespond = null;
      pendingElicitRespond = null;
      dropQueuedUpdates();
      set({
        instanceId,
        connState: "connecting",
        activeSessionId: null,
        messages: [],
        planEntries: null,
        permission: null,
        elicitation: null,
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        availableCommands: [],
        fsCapable: false,
        // usageStats stays: quota is hub-level (/api/quota), not tied to the
        // instance connection — switching instances must not blank the card.
        sessionStates: {},
        loadingSession: false,
      });
      await openConnection(s.profile, instanceId);
      // Attach to the requested session, else the most recently updated one.
      if (get().connState === "open" && !get().activeSessionId) {
        const inst = get().instances.find((i) => i.id === instanceId);
        let target = attachSessionId ?? null;
        if (!target && inst?.sessions?.length) {
          target = [...inst.sessions].sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
          )[0].sessionId;
        }
        if (target) await get().loadSession(target);
      }
    },

    // One tap from the flat session list: may need to switch bridge instance
    // (new WS connection) before the session/load.
    openSession: async (instanceId, sessionId) => {
      const s = get();
      if (!s.profile) return;
      if (s.instanceId === instanceId && s.connState === "open") {
        if (s.activeSessionId !== sessionId) await get().loadSession(sessionId);
        return;
      }
      await get().connectInstance(instanceId, sessionId);
    },

    wakeProbe: () => {
      void wakeProbe();
    },

    closeRemoteSession: async (instanceId, sessionId) => {
      const client = hub();
      if (!client) return;
      try {
        await client.closeSession(instanceId, sessionId);
      } catch (e) {
        if (e instanceof HubApiError && e.status === 409) {
          set({ notice: "notice.sessionRunning" });
        } else {
          set({
            notice: `close session failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        }
        return;
      }
      // Drop the row locally; the heartbeat list aligns within ~10s.
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                sessions: (i.sessions ?? []).filter(
                  (s) => s.sessionId !== sessionId,
                ),
              }
            : i,
        ),
      }));
      // Closing the conversation we're looking at returns to the list
      // (connection stays, closeSession handles the session-scoped reset).
      if (
        get().instanceId === instanceId &&
        get().activeSessionId === sessionId
      ) {
        get().closeSession();
      }
      set({ notice: "notice.sessionClosed" });
    },

    renameSession: async (instanceId, sessionId, title) => {
      const trimmed = title.trim().slice(0, 80);
      if (!trimmed) return;
      const client = hub();
      if (!client) return;
      try {
        await client.renameSession(instanceId, sessionId, trimmed);
      } catch {
        set({ notice: "notice.sessionRenameFailed" });
        return;
      }
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                sessions: (i.sessions ?? []).map((s) =>
                  s.sessionId === sessionId ? { ...s, title: trimmed } : s,
                ),
              }
            : i,
        ),
      }));
      set({ notice: "notice.sessionRenamed" });
    },

    closeSession: () => {
      // Leave the open session but KEEP the instance connection: the list
      // screen renders live activity badges from sessionStates, which only
      // flow over the instance WS (broadcast-only, not in hub discovery).
      // Connection-level teardown (instance gone, forget hub) lives
      // elsewhere; this only resets session-scoped state. openSession's
      // fast path reuses the still-open socket.
      pendingRespond = null;
      pendingElicitRespond = null;
      dropQueuedUpdates();
      set({
        activeSessionId: null,
        messages: [],
        planEntries: null,
        permission: null,
        elicitation: null,
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        availableCommands: [],
        loadingSession: false,
        isRunning: false,
      });
    },

    loadSession: async (sessionId) => {
      if (!acp || get().connState !== "open") return;
      // Replay arrives as session/update notifications; reset first.
      dropQueuedUpdates();
      set({
        activeSessionId: sessionId,
        messages: [],
        planEntries: null,
        permission: null,
        elicitation: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        availableCommands: [],
        loadingSession: true,
      });
      try {
        const ws = instanceWorkspace();
        const result = await acp.request("session/load", {
          sessionId,
          // cwd is REQUIRED by the SDK's session/load schema (no default) —
          // omitting it fails with -32602 Invalid params, e.g. when the hub
          // list is still stale right after a wake reconnect. The bridge
          // ignores the value on load (roots are backend-authoritative), so
          // an unknown workspace sends a "/" placeholder.
          cwd: ws ?? "/",
          mcpServers: [],
          // Tail replay: the limit rides in _meta (top-level unknown keys are
          // stripped by the SDK schema). Counts messages, turn-aligned.
          _meta: { zcode: { limit: REPLAY_TAIL_LIMIT } },
        });
        const meta = readReplayMeta(result);
        const res = result as {
          modes?: { currentModeId?: string };
          configOptions?: ConfigOption[];
        } | null;
        set({
          replayCursor: meta?.cursor ?? null,
          hasMore: meta?.hasMore ?? false,
          totalMessages:
            typeof meta?.totalMessages === "number" ? meta.totalMessages : null,
          configOptions: Array.isArray(res?.configOptions)
            ? res!.configOptions!
            : [],
          currentModeId: res?.modes?.currentModeId ?? null,
          loadingSession: false,
          // A turn that survived the reconnect is still running on the bridge
          // (replayMeta.turnActive): restore the running UI instead of the
          // idle composer, which would let a prompt collide with the turn.
          isRunning: meta?.turnActive === true,
        });
        setActivity(sessionId, { running: meta?.turnActive === true });
        // History is live: send whatever queued while the replay streamed
        // (flushPending no-ops while a restored turn is running — its
        // turnState end event does the flushing then).
        flushPending();
      } catch (e) {
        set({
          // Transient connection failures stay quiet: the reconnect banner
          // owns them, and the post-reconnect replay supersedes this error.
          ...(isTransientConnError(e)
            ? null
            : { notice: `session/load failed: ${(e as Error).message}` }),
          loadingSession: false,
        });
      }
    },

    // Fetches one page of older history and prepends it. Returns true when a
    // page was applied (the UI re-anchors its scroll position on this).
    loadEarlier: async () => {
      const s = get();
      if (!acp || s.connState !== "open") return false;
      if (
        !s.activeSessionId ||
        !s.replayCursor ||
        !s.hasMore ||
        s.loadingEarlier
      )
        return false;
      const sessionId = s.activeSessionId;
      set({ loadingEarlier: true });
      collectingEarlier = true;
      earlierBuffer = [];
      try {
        const result = await acp.request("session/load_earlier", {
          sessionId,
          before: s.replayCursor,
          limit: EARLIER_PAGE_LIMIT,
        });
        const page = earlierBuffer;
        collectingEarlier = false;
        earlierBuffer = [];
        // Build the page as its own segment (oldest -> newest), then prepend.
        set((state) => {
          if (state.activeSessionId !== sessionId) return state;
          let segment: ChatMessage[] = [];
          for (const { sessionId: sid, u, meta } of page) {
            if (sid !== sessionId) continue;
            const r = applyOne(segment, u, meta);
            if (r?.messages) segment = r.messages;
            // plan/config/usage in old pages are stale: take messages only
          }
          let rest = state.messages;
          if (
            segment.length &&
            rest.length &&
            segment[segment.length - 1].id === rest[0].id
          ) {
            // Seam dedupe: the same message split across pages.
            const seam = segment[segment.length - 1];
            segment = segment.slice(0, -1);
            rest = [
              { ...seam, parts: [...seam.parts, ...rest[0].parts] },
              ...rest.slice(1),
            ];
          }
          const meta = readReplayMeta(result);
          return {
            messages: [...segment, ...rest],
            replayCursor: meta?.cursor ?? null,
            hasMore: meta?.hasMore ?? false,
            loadingEarlier: false,
          };
        });
        return true;
      } catch (e) {
        collectingEarlier = false;
        earlierBuffer = [];
        set({ loadingEarlier: false });
        const msg = (e as Error).message ?? "";
        if (msg.includes("cursor expired")) {
          // History shrank (compaction): rebuild from a fresh tail attach.
          await get().loadSession(sessionId);
        } else if (!isTransientConnError(e)) {
          set({ notice: `load_earlier failed: ${msg}` });
        }
        return false;
      }
    },

    // Model / mode / thought switching via the bridge's configOptions.
    setConfigOption: async (configId, value) => {
      const s = get();
      if (!acp || s.connState !== "open" || !s.activeSessionId) return;
      try {
        const result = await acp.request("session/set_config_option", {
          sessionId: s.activeSessionId,
          configId,
          value,
        });
        const opts = (result as { configOptions?: ConfigOption[] } | null)
          ?.configOptions;
        if (Array.isArray(opts)) set({ configOptions: opts });
        // The bridge also broadcasts config_option_update / current_mode_update
        // to every client (editor included) — the store picks those up too.
      } catch (e) {
        if (!isTransientConnError(e))
          set({ notice: `config change failed: ${(e as Error).message}` });
      }
    },

    // Combined quota via the hub's /api/quota (bridge 0.8.0, ADR-0005) — the
    // same payload the ACP account/usage_stats method returns, but plain
    // HTTP: no instance connection needed. Pull-only; fetched on hub connect
    // and on demand from the panels. 502/network failures land in the catch
    // (hide data, retry later). Per-provider failures arrive as section
    // `kind` strings (rendered like the CLI's status lines), not rejections.
    refreshUsageStats: async () => {
      const client = hub();
      const profile = get().profile;
      if (!client || !profile) return;
      try {
        const result = await client.quota();
        if (get().profile !== profile) return; // hub changed mid-flight
        set({
          usageStats: parseUsageStats(result),
          quotaUnavailable: false,
          usageStatsAt: Date.now(),
        });
      } catch {
        if (get().profile === profile)
          set({ usageStats: null, quotaUnavailable: true });
      }
    },

    // ---- Session Files (ADR-0005) ----

    fsList: async (path) => {
      const client = hub();
      const s = get();
      if (!client || !s.instanceId || !s.activeSessionId) return null;
      try {
        return await client.fsList(s.instanceId, s.activeSessionId, path);
      } catch {
        return null;
      }
    },

    fsFileText: async (path, line, limit) => {
      const client = hub();
      const s = get();
      if (!client || !s.instanceId || !s.activeSessionId) return null;
      try {
        return await client.fsFileText(
          s.instanceId,
          s.activeSessionId,
          path,
          line,
          limit,
        );
      } catch {
        return null;
      }
    },

    fsFileUrl: (path) => {
      const client = hub();
      const s = get();
      if (!client || !s.instanceId || !s.activeSessionId) return null;
      return client.fsFileUrl(s.instanceId, s.activeSessionId, path);
    },

    // Attach-only client: sessions are created in the editor, never here.
    // ACP allows one prompt at a time: while a turn is running or history is
    // still replaying, new text queues as pending instead — a prompt sent
    // mid-replay never reaches the session, so it must wait for the attach.
    sendPrompt: async (text, images) => {
      const s = get();
      if (!acp || s.connState !== "open") return;
      if (!s.activeSessionId) {
        set({ notice: "notice.noSession" });
        return;
      }
      const draft: PromptDraft = { text, images: images ?? [] };
      if (s.isRunning || s.loadingSession) {
        setQueue(s.activeSessionId, [
          ...(s.pendingPrompts[s.activeSessionId] ?? []),
          draft,
        ]);
        return;
      }
      await get().runPrompt(draft);
    },

    runPrompt: async (draft) => {
      const s = get();
      if (
        !acp ||
        s.connState !== "open" ||
        !s.activeSessionId ||
        s.loadingSession
      )
        return;
      // Live turns never echo the user's message back (only replay does), so
      // insert it optimistically; replay replaces the whole history anyway.
      set((state) => {
        const ensured = ensureMessage(state.messages, "user");
        return {
          messages: ensured.messages.map((m) => {
            if (m.id !== ensured.message.id) return m;
            let msg = m;
            if (draft.text) msg = appendTextPart(msg, draft.text, "text");
            for (const img of draft.images) {
              // Display form is the data URL; the wire block stays base64.
              msg = {
                ...msg,
                parts: [
                  ...msg.parts,
                  {
                    type: "image",
                    image: `data:${img.mimeType};base64,${img.data}`,
                  } as ChatPart,
                ],
              };
            }
            return msg;
          }),
        };
      });
      const sessionId = s.activeSessionId;
      set({ isRunning: true });
      localPromptActive = true;
      try {
        await acp.request("session/prompt", {
          sessionId,
          prompt: [
            ...(draft.text ? [{ type: "text", text: draft.text }] : []),
            ...draft.images.map((img) => ({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            })),
          ],
        });
      } catch (e) {
        // A dropped connection kills the in-flight prompt, but the reconnect
        // replay rebuilds the truth — stay quiet and let the banner speak.
        if (!isTransientConnError(e))
          set({ notice: `prompt failed: ${(e as Error).message}` });
      } finally {
        localPromptActive = false;
        set({ isRunning: false });
        // Auto-flush: the queue is FIFO, and each settled turn sends the next.
        // A concurrent re-attach defers to loadSession's own flush instead.
        flushPending();
      }
    },

    forceSendPending: () => {
      const s = get();
      const sid = s.activeSessionId;
      if (!sid) return;
      const queue = s.pendingPrompts[sid] ?? [];
      if (queue.length === 0) return;
      // During replay there is no turn to interrupt; the queue fires on load.
      if (s.loadingSession) return;
      if (s.isRunning) {
        // Cancelling settles the running prompt, which auto-flushes the queue.
        get().cancelTurn();
      } else {
        setQueue(sid, queue.slice(1));
        void get().runPrompt(queue[0]);
      }
    },

    discardPending: (index) => {
      const s = get();
      const sid = s.activeSessionId;
      if (!sid) return;
      const queue = s.pendingPrompts[sid] ?? [];
      if (index < 0 || index >= queue.length) return;
      setQueue(
        sid,
        queue.filter((_, i) => i !== index),
      );
    },

    cancelTurn: () => {
      const s = get();
      if (!acp || !s.activeSessionId) return;
      // session/cancel is a NOTIFICATION in ACP (no id, no response).
      acp.notify("session/cancel", { sessionId: s.activeSessionId });
    },

    answerPermission: (requestId, optionId) => {
      const entry = pendingRespond;
      if (!entry || entry.id !== requestId) return;
      const sid = get().permission?.sessionId;
      pendingRespond = null;
      entry.respond({ outcome: { outcome: "selected", optionId } });
      if (sid) setActivity(sid, { awaitingPermission: false });
      set({ permission: null });
    },

    answerElicitation: (requestId, content) => {
      const entry = pendingElicitRespond;
      if (!entry || entry.id !== requestId) return;
      const sid = get().elicitation?.sessionId;
      pendingElicitRespond = null;
      // Wire shape (elicitation/create): accept carries the form content,
      // anything else declines. Absent fields = skipped questions.
      entry.respond(
        content ? { action: "accept", content } : { action: "decline" },
      );
      if (sid) setActivity(sid, { awaitingPermission: false });
      set({ elicitation: null });
    },

    dismissNotice: () => set({ notice: null }),

    notify: (text) => set({ notice: text }),
  };
});

// Zombie-socket guard: deep-sleep wake is the one moment connState can lie
// ("open" socket that died mid-sleep without an onclose). Validate on every
// foreground return — the probe is one tiny round-trip on a healthy pipe.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      useAppStore.getState().wakeProbe();
  });
}

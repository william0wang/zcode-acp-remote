import { create } from "zustand";
import { AcpConnection } from "../lib/acp";
import { HubApiError, HubClient } from "../lib/hub";
import {
  clearProfileStorage,
  loadLang,
  loadProfile,
  saveLang,
  saveProfile as persistProfile,
  type Lang,
} from "../lib/storage";
import { contentText, type ChatMessage, type ChatPart, type ConnectionProfile, type HubInstance, type SessionUpdate } from "../lib/types";

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
}

function readReplayMeta(result: unknown): ReplayMeta | null {
  if (typeof result !== "object" || result === null) return null;
  const meta = (result as { replayMeta?: unknown }).replayMeta;
  return typeof meta === "object" && meta !== null ? (meta as ReplayMeta) : null;
}

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface PendingPermission {
  requestId: number;
  sessionId: string;
  options: PermissionOption[];
}

interface AppState {
  profile: ConnectionProfile | null;
  lang: Lang;
  instances: HubInstance[];
  instancesError: string | null;
  connState: ConnState;
  instanceId: string | null;
  activeSessionId: string | null;
  messages: ChatMessage[];
  planText: string | null;
  isRunning: boolean;
  permission: PendingPermission | null;
  notice: string | null;
  // Pagination state from the attach response's replayMeta.
  replayCursor: string | null;
  hasMore: boolean;
  totalMessages: number | null;
  loadingEarlier: boolean;

  init: () => void;
  connectToHub: (profile: ConnectionProfile) => void;
  forgetHub: () => void;
  setLang: (lang: Lang) => void;
  refreshInstances: () => Promise<void>;
  connectInstance: (instanceId: string, attachSessionId?: string) => Promise<void>;
  openSession: (instanceId: string, sessionId: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  loadEarlier: () => Promise<boolean>;
  sendPrompt: (text: string) => Promise<void>;
  cancelTurn: () => void;
  answerPermission: (requestId: number, optionId: string) => void;
  dismissNotice: () => void;
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

  // The ACP schema marks cwd + mcpServers as REQUIRED on session/new and
  // session/load; the instance workspace is the natural cwd.
  function instanceWorkspace(): string {
    const s = get();
    const inst = s.instances.find((i) => i.id === s.instanceId);
    return inst?.workspace ?? "/";
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
    return { ...message, parts: [...message.parts, { type: partType, text } as ChatPart] };
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
    const mid = typeof u.messageId === "string" && u.messageId ? u.messageId : null;
    if (mid) {
      const i = msgs.findIndex((m) => m.id === mid);
      if (i >= 0) return patchMessage(msgs, i, appendTextPart(msgs[i], text, partType));
      return [
        ...msgs,
        { id: mid, role, parts: [{ type: partType, text } as ChatPart], createdAt: Date.now() },
      ];
    }
    const ensured = ensureMessage(msgs, role);
    return ensured.messages.map((m) =>
      m.id === ensured.message.id ? appendTextPart(m, text, partType) : m,
    );
  }

  function patchMessage(msgs: ChatMessage[], i: number, m: ChatMessage): ChatMessage[] {
    return msgs.slice(0, i).concat(m, msgs.slice(i + 1));
  }

  // Applies one update to a messages array; returns null when nothing changed.
  function applyOne(
    msgs: ChatMessage[],
    u: SessionUpdate,
  ): { msgs: ChatMessage[]; planText?: string | null } | null {
    const kind = u.sessionUpdate;

    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      const text = contentText(u.content);
      if (!text) return null;
      return { msgs: appendChunkMessage(msgs, u, role, text, "text") };
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(u.content);
      if (!text) return null;
      return { msgs: appendChunkMessage(msgs, u, "assistant", text, "thought") };
    }
    if (kind === "tool_call") {
      const part = {
        type: "tool-call" as const,
        toolCallId: String(u.toolCallId ?? ""),
        toolName: String(u.title ?? "tool"),
        detail: "",
        status: String(u.status ?? "pending"),
      };
      const mid = typeof u.messageId === "string" && u.messageId ? u.messageId : null;
      if (mid) {
        const i = msgs.findIndex((m) => m.id === mid);
        if (i >= 0) {
          return { msgs: patchMessage(msgs, i, { ...msgs[i], parts: [...msgs[i].parts, part] }) };
        }
        return {
          msgs: [...msgs, { id: mid, role: "assistant", parts: [part], createdAt: Date.now() }],
        };
      }
      const ensured = ensureMessage(msgs, "assistant");
      return {
        msgs: ensured.messages.map((m) =>
          m.id === ensured.message.id ? { ...m, parts: [...m.parts, part] } : m,
        ),
      };
    }
    if (kind === "tool_call_update") {
      const toolCallId = String(u.toolCallId ?? "");
      const chunk = contentText(u.content);
      const status = typeof u.status === "string" ? u.status : null;
      // Search backwards: the tool call may live in an earlier assistant
      // message when other clients' turns interleaved. Content on the wire
      // REPLACES the collection, it does not append.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        if (!m.parts.some((p) => p.type === "tool-call" && p.toolCallId === toolCallId)) {
          continue;
        }
        const patched = {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "tool-call" && p.toolCallId === toolCallId
              ? { ...p, detail: chunk || p.detail, status: status ?? p.status }
              : p,
          ),
        };
        return { msgs: msgs.slice(0, i).concat(patched, msgs.slice(i + 1)) };
      }
      return null;
    }
    if (kind === "plan") {
      // Plan updates are full snapshots; render the latest one as a live
      // status area outside the message stream.
      const entries = Array.isArray(u.entries) ? u.entries : [];
      const lines = entries
        .map((e) => {
          const entry = e as { content?: string; status?: string };
          const mark = entry.status === "completed" ? "x" : entry.status === "active" ? ">" : " ";
          return `${mark} ${entry.content ?? ""}`;
        })
        .join("\n");
      return { msgs, planText: lines || null };
    }
    // Unknown kinds (additive-only contract): ignore.
    return null;
  }

  // Replay bursts hundreds of updates in one go; batching them into a single
  // store write keeps render cost O(bursts) instead of O(chunks).
  let updateQueue: { sessionId: string; u: SessionUpdate }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // While a session/load_earlier request is in flight its updates must be
  // PREPENDED, not appended — buffer them until the request resolves.
  let collectingEarlier = false;
  let earlierBuffer: { sessionId: string; u: SessionUpdate }[] = [];

  function dropQueuedUpdates(): void {
    updateQueue = [];
    collectingEarlier = false;
    earlierBuffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function applyUpdate(sessionId: string, u: SessionUpdate): void {
    updateQueue.push({ sessionId, u });
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = updateQueue;
      updateQueue = [];
      set((state) => {
        let msgs = state.messages;
        let planText = state.planText;
        for (const { sessionId: sid, u: upd } of batch) {
          if (state.activeSessionId !== sid) continue;
          const r = applyOne(msgs, upd);
          if (!r) continue;
          msgs = r.msgs;
          if (r.planText !== undefined) planText = r.planText;
        }
        return { messages: msgs, planText };
      });
    }, 120);
  }

  // ---- connection lifecycle ----

  function scheduleReconnect(): void {
    const s = get();
    if (!s.profile || !s.instanceId) return;
    stopReconnect();
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
    set({ connState: "reconnecting" });
    reconnectTimer = setTimeout(() => void tryReconnect(), delay);
  }

  async function tryReconnect(): Promise<void> {
    const s = get();
    if (!s.profile || !s.instanceId) return;
    await s.refreshInstances();
    // Re-read after the await: the hub/instance may have changed meanwhile.
    const cur = get();
    if (!cur.profile || cur.profile !== s.profile || cur.instanceId !== s.instanceId) return;
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
        planText: null,
        permission: null,
        notice: "notice.instanceGone",
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
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
          set({ connState: "open" });
        } else if (state === "closed") {
          if (get().instanceId === instanceId) {
            // The pending permission request dies with the socket; don't
            // leave a dead dialog that silently swallows taps.
            pendingRespond = null;
            set({ permission: null });
            scheduleReconnect();
          }
        }
      },
      onUpdate: (sessionId, update) => {
        if (stale()) return;
        if (collectingEarlier && sessionId === get().activeSessionId) {
          earlierBuffer.push({ sessionId, u: update });
          return;
        }
        applyUpdate(sessionId, update);
      },
      onServerRequest: (req, respond) => {
        if (stale()) return;
        if (req.method === "session/request_permission") {
          const sessionId = String(req.params.sessionId ?? "");
          const options = Array.isArray(req.params.options)
            ? (req.params.options as PermissionOption[])
            : [];
          set({
            permission: {
              requestId: req.id,
              sessionId,
              options: options.filter((o) => typeof o.optionId === "string"),
            },
          });
          // respond is captured by answerPermission through the stored request id.
          pendingRespond = { id: req.id, respond };
        } else {
          // Unsupported interaction (e.g. elicitation). Deliberately NOT
          // answered: first-response-wins, and the primary editor client is
          // always attached (bridge lifetime = editor lifetime).
          set({ notice: "notice.unsupported" });
        }
      },
      onCancelRequest: (id) => {
        // We lost the Permission Race; drop the dialog.
        if (get().permission?.requestId === id) {
          set({ permission: null });
          pendingRespond = null;
        }
      },
    });
    acp = conn;
    try {
      await conn.connect();
      const active = get().activeSessionId;
      if (active) {
        // Replay is the catch-up mechanism after any disconnect.
        await get().loadSession(active);
      }
    } catch {
      if (get().instanceId === instanceId) scheduleReconnect();
    }
  }

  let pendingRespond: { id: number; respond: (result: unknown) => void } | null = null;

  return {
    profile: null,
    lang: "en",
    instances: [],
    instancesError: null,
    connState: "idle",
    instanceId: null,
    activeSessionId: null,
    messages: [],
    planText: null,
    isRunning: false,
    permission: null,
    notice: null,
    replayCursor: null,
    hasMore: false,
    totalMessages: null,
    loadingEarlier: false,

    init: () => {
      const profile = loadProfile();
      set({ profile, lang: loadLang() });
      if (profile) startPolling();
    },

    connectToHub: (profile) => {
      persistProfile(profile);
      set({ profile, instances: [], instancesError: null });
      startPolling();
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
      set({
        profile: null,
        instances: [],
        instancesError: null,
        connState: "idle",
        instanceId: null,
        activeSessionId: null,
        messages: [],
        planText: null,
        permission: null,
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
      });
    },

    setLang: (lang) => {
      saveLang(lang);
      set({ lang });
    },

    refreshInstances: async () => {
      const client = hub();
      if (!client) return;
      const profile = get().profile;
      try {
        const instances = await client.instances();
        if (get().profile !== profile) return; // hub changed mid-flight
        set({ instances, instancesError: null });
      } catch (e) {
        if (get().profile !== profile) return;
        const msg = e instanceof HubApiError ? e.message : `discovery failed: ${(e as Error).message}`;
        set({ instancesError: msg });
      }
    },

    connectInstance: async (instanceId, attachSessionId) => {
      const s = get();
      if (!s.profile) return;
      stopReconnect();
      reconnectAttempt = 0;
      pendingRespond = null;
      dropQueuedUpdates();
      set({
        instanceId,
        connState: "connecting",
        activeSessionId: null,
        messages: [],
        planText: null,
        permission: null,
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
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

    loadSession: async (sessionId) => {
      if (!acp || get().connState !== "open") return;
      // Replay arrives as session/update notifications; reset first.
      dropQueuedUpdates();
      set({
        activeSessionId: sessionId,
        messages: [],
        planText: null,
        permission: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
      });
      try {
        const result = await acp.request("session/load", {
          sessionId,
          cwd: instanceWorkspace(),
          mcpServers: [],
          // Tail replay: the limit rides in _meta (top-level unknown keys are
          // stripped by the SDK schema). Counts messages, turn-aligned.
          _meta: { zcode: { limit: REPLAY_TAIL_LIMIT } },
        });
        const meta = readReplayMeta(result);
        set({
          replayCursor: meta?.cursor ?? null,
          hasMore: meta?.hasMore ?? false,
          totalMessages: typeof meta?.totalMessages === "number" ? meta.totalMessages : null,
        });
      } catch (e) {
        set({ notice: `session/load failed: ${(e as Error).message}` });
      }
    },

    // Fetches one page of older history and prepends it. Returns true when a
    // page was applied (the UI re-anchors its scroll position on this).
    loadEarlier: async () => {
      const s = get();
      if (!acp || s.connState !== "open") return false;
      if (!s.activeSessionId || !s.replayCursor || !s.hasMore || s.loadingEarlier) return false;
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
          for (const { sessionId: sid, u } of page) {
            if (sid !== sessionId) continue;
            const r = applyOne(segment, u);
            if (r) segment = r.msgs; // plan snapshots in old pages are stale: skip
          }
          let rest = state.messages;
          if (segment.length && rest.length && segment[segment.length - 1].id === rest[0].id) {
            // Seam dedupe: the same message split across pages.
            const seam = segment[segment.length - 1];
            segment = segment.slice(0, -1);
            rest = [{ ...seam, parts: [...seam.parts, ...rest[0].parts] }, ...rest.slice(1)];
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
        } else {
          set({ notice: `load_earlier failed: ${msg}` });
        }
        return false;
      }
    },

    // Attach-only client: sessions are created in the editor, never here.
    sendPrompt: async (text) => {
      const s = get();
      if (!acp || s.connState !== "open") return;
      if (!s.activeSessionId) {
        set({ notice: "notice.noSession" });
        return;
      }
      // Live turns never echo the user's message back (only replay does), so
      // insert it optimistically; replay replaces the whole history anyway.
      set((state) => {
        const ensured = ensureMessage(state.messages, "user");
        return {
          messages: ensured.messages.map((m) =>
            m.id === ensured.message.id ? appendTextPart(m, text, "text") : m,
          ),
        };
      });
      const sessionId = s.activeSessionId;
      set({ isRunning: true });
      try {
        await acp.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      } catch (e) {
        set({ notice: `prompt failed: ${(e as Error).message}` });
      } finally {
        set({ isRunning: false });
      }
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
      pendingRespond = null;
      entry.respond({ outcome: { outcome: "selected", optionId } });
      set({ permission: null });
    },

    dismissNotice: () => set({ notice: null }),
  };
});

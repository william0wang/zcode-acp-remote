import { create } from "zustand";
import { AcpConnection } from "../lib/acp";
import { HubApiError, HubClient } from "../lib/hub";
import {
  defaultServerName,
  loadFontSize,
  loadLang,
  loadPending,
  loadServerBook,
  loadUpdateChannel,
  newServerId,
  saveFontSize,
  saveLang,
  savePending,
  saveServerBook,
  saveUpdateChannel,
  type FontSize,
  type Lang,
  type UpdateChannel,
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
  type HubCreateInstanceResult,
  type HubInstance,
  type HubSessionInfo,
  type HubUpgradeResult,
  type OcWindowEntry,
  type OllamaUsageStats,
  type PromptDraft,
  type QuotaItem,
  type SavedServer,
  type SessionUpdate,
  type SlashCommand,
  type ToolCallPart,
  type AppUpdateState,
  type AgentUpsert,
  type Effect,
  type HookEntryPatch,
  type McpServerUpsert,
  type ModelUpsert,
  type ResetCardStatus,
  type SettingsAll,
  type SettingsUsage,
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

// zcode-acp-server version that started marking load_earlier page updates
// `_meta.zcode.earlierPage` — the floor for the marker-based page routing.
const PAGE_MARKER_BRIDGE_VERSION = "0.44.1";

// Semver-ish floor check on the bridge's advertised agentInfo.version.
// Unparseable versions read as NOT capable: the fallback (pre-marker
// buffer-everything collection) is the safe behavior on any bridge.
function bridgeSupportsPageMarker(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const parts = version.split(".");
  if (parts.length < 3) return false;
  const nums = parts.slice(0, 3).map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n))) return false;
  const [major, minor, patch] = nums;
  const floor = PAGE_MARKER_BRIDGE_VERSION.split(".").map((p) =>
    Number.parseInt(p, 10),
  ) as [number, number, number];
  if (major !== floor[0]) return major > floor[0];
  if (minor !== floor[1]) return minor > floor[1];
  return patch >= floor[2];
}

// Last-turn prompt-cache hit rate (percent) from a session/prompt response
// usage: cachedRead / (input + cachedRead + cachedWrite), the ACP de-facto
// convention. inputTokens is already cache-exclusive — the bridge normalizes
// the backend's OpenAI-style inclusive counts. Null when the turn reported
// no cache numbers at all (caller keeps the previous rate then).
function cacheHitRate(u: unknown): number | null {
  const v = u as {
    inputTokens?: unknown;
    cachedReadTokens?: unknown;
    cachedWriteTokens?: unknown;
  } | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.cachedReadTokens !== "number") return null;
  const input = typeof v.inputTokens === "number" ? v.inputTokens : 0;
  const write =
    typeof v.cachedWriteTokens === "number" ? v.cachedWriteTokens : 0;
  const denom = input + v.cachedReadTokens + write;
  return denom > 0 ? Math.round((v.cachedReadTokens / denom) * 100) : null;
}

// Validates an account/usage_stats result into the combined GLM + Opencode
// Go + Ollama Cloud shape; null when the payload doesn't fit (treated like a
// failed fetch). glm/opencode stay required, ollama is optional (older hubs).
function parseUsageStats(result: unknown): AccountUsageStats | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as {
    glm?: unknown;
    opencode?: unknown;
    ollama?: unknown;
  };
  if (typeof r.glm !== "object" || r.glm === null) return null;
  if (typeof r.opencode !== "object" || r.opencode === null) return null;

  const glm = r.glm as Partial<GlmUsageStats>;
  const go = r.opencode as Partial<GoUsageStats>;
  const oc =
    typeof r.ollama === "object" && r.ollama !== null
      ? (r.ollama as Partial<OllamaUsageStats>)
      : undefined;
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
    // Ollama section is optional — pre-0.41.0 bridges don't send it.
    ...(oc
      ? {
          ollama: {
            kind: (
              [
                "success",
                "not_configured",
                "auth_error",
                "unavailable",
              ] as const
            ).includes(oc.kind as OllamaUsageStats["kind"])
              ? (oc.kind as OllamaUsageStats["kind"])
              : "unavailable",
            ...(Array.isArray(oc.windows)
              ? {
                  windows: oc.windows.filter(
                    (w) => w && typeof w.usagePercent === "number",
                  ) as OcWindowEntry[],
                }
              : {}),
          },
        }
      : {}),
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
// (bridge builds the schema: `q_<i>` enum/array + `q_<i>_other` free text;
// the plan-approval form is a single `approval` enum field).
export interface ElicitField {
  // Field key in requestedSchema (q_0, q_1, …) and its free-text companion.
  key: string;
  otherKey: string | null;
  question: string;
  // Long-form markdown under the question — the plan-approval form (bridge
  // 0.33+) carries the COMPLETE plan here, rendered as a markdown pane.
  description?: string;
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
  // Multi-server book: every saved Hub URL + token pair and the active one.
  // `profile` mirrors the active entry (null when nothing is active).
  savedServers: SavedServer[];
  activeServerId: string | null;
  lang: Lang;
  fontSize: FontSize;
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
  // Pending permission/elicitation requests, keyed by the sessionId they
  // belong to (bridge 0.17.0 semantics: a request is only ever answered in
  // the session that raised it — dialogs render per-session, and a request
  // from session A must never appear in session B's view). One pending
  // request per session at a time: the bridge issues its interactions
  // sequentially within a turn.
  permissions: Record<string, PendingPermission>;
  // AskUserQuestion via elicitation/create (the bridge's preferred channel
  // once ANY client advertises elicitation.form — capabilities OR-merge).
  elicitations: Record<string, PendingElicitation>;
  notice: string | null;
  // Ephemeral one-shot feedback (downloads, copies, share results) with its
  // own auto-clear timer. Separate from `notice` because the banner only
  // renders on the picker/chat screens — toasts raised inside the z-50
  // full-screen overlays (FileBrowser/FileViewer) were invisible there,
  // which read as "download failed with no feedback at all".
  toast: { id: number; text: string } | null;
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
  // Last turn's prompt-cache hit rate (percent), from the session/prompt
  // response usage. Null until a turn reports cache numbers.
  cacheHit: number | null;
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
  // Bridge marks load_earlier page updates `_meta.zcode.earlierPage`
  // (zcode-acp-server 0.44.1+); gates the marker-based page routing. Against
  // an older bridge the unmarked pages fall back to the pre-marker
  // buffer-everything collection.
  pageMarkerCapable: boolean;
  loadingSession: boolean;

  // ---- ZCode configuration (ADR-0009) ----
  //
  // Machine-level state (one hub, one configuration), independent of any
  // session. `configSupported` is false once a settings route has answered
  // 404 — an older hub — so the screens say so instead of erroring.
  configOpen: boolean;
  // Which configuration section is open; null = the entry list.
  configSection: ConfigSection | null;
  configSupported: boolean | null;
  configLoading: boolean;
  configError: string | null;
  // The /settings/all snapshot: one request for a screen's first paint.
  configAll: SettingsAll | null;
  // Section payloads fetched on their own (models/skills/mcp/hooks/agents
  // carry shapes the snapshot compresses; usage and backups likewise).
  configModels: unknown;
  configSkills: unknown;
  configMcp: unknown;
  configHooks: unknown;
  configAgents: unknown;
  configUsage: SettingsUsage | null;
  // The range the LAST usage read asked for. Stored so a response that arrives
  // out of order (two taps, two in-flight reads) can be recognised as stale
  // and dropped rather than shown under the wrong range button.
  configUsageRange: string;
  configBackups: unknown;
  configAppUpdate: unknown;
  // Install progress for the app update, polled by the update screen.
  appUpdateInstall: AppUpdateState | null;
  // Reset cards (ADR-0009): the inventory plus which provider it belongs to.
  // `resetNonce` is what a spend must send back — it is tied to this read, and
  // so is `resetIdempotencyKey`: one key per GESTURE, minted alongside the
  // nonce, so every retry of that spend sends the same value.
  resetCards: ResetCardStatus["resetCards"] | null;
  resetProviderId: string | null;
  resetNonce: string | null;
  resetIdempotencyKey: string | null;
  // The provider ids the hub says could own cards, and whether the credential
  // store could be decrypted at all. Kept apart from `resetProviderId` (the
  // user's choice) because the list is a fact and the choice is not.
  resetEligible: string[];
  resetCredentials: boolean;
  resetBusy: boolean;
  // When a denied reset opportunity said to try again (epoch ms). Drives the
  // countdown on the plan-quota screen; null when there is nothing to count.
  resetNextTryAt: number | null;
  // True once this bridge has recorded a needs-restart write since its last
  // backend restart. Drives the restart affordance on the config screens.
  pendingRestart: boolean;
  // Which ZCode desktop release stream the update screen follows. Persisted:
  // a preview user who is silently checked against stable sees a version the
  // install then refuses.
  updateChannel: UpdateChannel;
  setUpdateChannel: (channel: UpdateChannel) => void;

  init: () => void;
  // Upserts by normalized hubUrl: an existing entry gets the new token and
  // becomes active; otherwise a new entry is appended (name defaults to the
  // URL host). Connecting NEVER drops the other saved servers.
  connectToHub: (input: {
    hubUrl: string;
    token: string;
    name?: string;
  }) => void;
  // Tears the connection down and clears the active selection; the saved
  // server list itself is kept (the manager screen lists them).
  disconnectHub: () => void;
  // Switches the active server: full connection teardown, then fresh polling
  // against the target entry. No health gate — the hubOffline banner covers
  // a down hub and polling heals when it comes back.
  switchServer: (id: string) => void;
  // In-place edit of one saved entry; editing the ACTIVE one reconnects.
  saveServer: (entry: SavedServer) => void;
  // Removes one entry; deleting the ACTIVE one disconnects to the manager.
  deleteServer: (id: string) => void;
  // Full-screen server manager overlay (opened from settings). Browsing and
  // editing happens WITHOUT dropping the current connection; switching or
  // adding a server closes it (the chosen hub's session list takes over).
  manageOpen: boolean;
  openServerManager: () => void;
  closeServerManager: () => void;
  setLang: (lang: Lang) => void;
  setFontSize: (size: FontSize) => void;
  refreshInstances: (opts?: { probe?: boolean }) => Promise<void>;
  upgradeHub: () => Promise<HubUpgradeResult>;
  connectInstance: (
    instanceId: string,
    attachSessionId?: string,
    opts?: { noAttach?: boolean },
  ) => Promise<void>;
  // Remote session-create (bridge 0.17.0, ADR-0014): create/reuse a headless
  // serve bridge for a known project and open a FRESH session in it.
  // Resolves true only when the session is actually the active one — callers
  // cannot infer it from a route swap (the sheet may open from inside a
  // session too, where nothing unmounts).
  createProjectSession: (workspacePath: string) => Promise<boolean>;
  // Resume a CLOSED session from the project history listing (bridge 0.19.0,
  // ADR-0015): create/reuse the workspace's serve bridge (usually reused:true
  // with the listing's instance), then attach and session/load the store id —
  // the normal connect path replays the history. Resolves true only on a
  // successful attach (see createProjectSession).
  resumeProjectSession: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<boolean>;
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
  // Terminates a remote-incubated bridge via the hub's instance shutdown
  // endpoint — the "close the session window" counterpart for app-created
  // instances. Editor-origin bridges are refused server-side (403).
  shutdownInstance: (instanceId: string) => Promise<void>;
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
  // Ephemeral UI feedback (download progress, copy confirmations); renders
  // above every overlay and auto-clears.
  notify: (text: string) => void;
  dismissToast: () => void;

  // ---- ZCode configuration (ADR-0009) ----
  // Opens/closes the configuration screen. `section` null = the entry list.
  openConfig: (section?: ConfigSection | null) => void;
  closeConfig: () => void;
  // Loads the /settings/all snapshot; a 404 marks the hub as too old.
  loadConfigAll: () => Promise<void>;
  // Loads one section's own endpoint. Called when its screen mounts; `arg`
  // carries a section-specific option (the usage range) so a screen can
  // refetch without the store having to know its controls.
  loadConfigSection: (
    section: ConfigSection,
    arg?: { range?: "7d" | "30d" | "all" },
  ) => Promise<void>;
  // Applies a write and reports its effect class. Destructive operations
  // (delete skill / mcp / agent, restore backup) confirm at the call site.
  applyConfigWrite: (
    label: string,
    write: () => Promise<Effect | undefined>,
    reload?: ConfigSection[],
  ) => Promise<boolean>;
  // ---- configuration writes ----
  //
  // Thin wrappers over the hub routes so a screen never builds a HubClient or
  // a URL itself. Each returns the write's effect class; failures throw, and
  // `applyConfigWrite` turns them into a toast.
  setProviderEnabled: (
    providerId: string,
    enabled: boolean,
  ) => Promise<Effect | undefined>;
  setSkillEnabled: (
    path: string,
    enable: boolean,
  ) => Promise<Effect | undefined>;
  copySkillToUser: (path: string) => Promise<Effect | undefined>;
  // POST /settings/models is an upsert: one route adds a model and edits its
  // rule (context window, reasoning levels), so one wrapper serves both forms.
  upsertModel: (body: ModelUpsert) => Promise<Effect | undefined>;
  setMcpEnabled: (name: string, enable: boolean) => Promise<Effect | undefined>;
  upsertMcp: (
    name: string,
    body: McpServerUpsert,
  ) => Promise<Effect | undefined>;
  setHooksEnabled: (enabled: boolean) => Promise<Effect | undefined>;
  // Edits ONE existing hook entry in place; there is deliberately no add or
  // remove through here (an insert shifts every later index and races a
  // concurrent edit of the same event).
  updateHookEntry: (
    eventName: string,
    matcherIndex: number,
    hookIndex: number,
    body: HookEntryPatch,
  ) => Promise<Effect | undefined>;
  setAgentEnabled: (
    name: string,
    enable: boolean,
  ) => Promise<Effect | undefined>;
  // A PUT on a missing personal agent creates it, so this one route serves
  // editing, creating, and the built-ins' model override.
  upsertAgent: (name: string, body: AgentUpsert) => Promise<Effect | undefined>;
  restoreBackup: (file: string, path: string) => Promise<Effect | undefined>;
  // Reset cards: read the inventory, ask for an opportunity, spend a card.
  // Both actions take the provider (and the spend its nonce) explicitly: a
  // gesture spans two round trips, and reading the store at entry time of the
  // SECOND one would let a provider switch mid-gesture spend the wrong card.
  loadResetCards: (providerId: string) => Promise<void>;
  requestResetOpportunity: (providerId: string) => Promise<boolean>;
  spendResetCard: (input: {
    providerId: string;
    nonce: string;
    resetType: "FIVE_HOUR" | "WEEK";
  }) => Promise<boolean>;
  markResetHistoryRead: () => Promise<void>;
  // App update: start an install and poll its progress.
  installAppUpdate: (input: {
    version: string;
    url: string;
    channel?: string;
  }) => Promise<void>;
  pollAppUpdate: () => Promise<void>;
  // Restarts the backend of the instance that owns the configuration, so
  // needs-restart writes take effect. Returns the interrupted-turn count.
  restartConfigBackend: () => Promise<number>;
}

/** The configuration sections the app can open. */
export type ConfigSection =
  | "models"
  | "skills"
  | "mcp"
  | "hooks"
  | "agents"
  | "quota"
  | "usage"
  | "backups"
  | "appUpdate";

// Module singletons: connection + timers live outside React state.
let acp: AcpConnection | null = null;
// Toast auto-clear; the id guards against a stale timer clearing a newer toast.
const TOAST_MS = 4000;
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
// Events from superseded connections must be ignored (their async onclose
// can fire after a new connection to the SAME instance was started).
let connSeq = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
// When the in-flight openConnection() attempt started (0 = none). wakeProbe
// uses it to recognize a connect attempt wedged past its 15s deadline.
let connectingSince = 0;
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

/**
 * Idempotency key for one reset-card GESTURE.
 *
 * A spent card is gone, so the backend keys a spend on this value: a retry
 * (dropped response, double tap) answers the same outcome instead of burning a
 * second card. Generate it ONCE per user gesture and reuse it on every retry —
 * a fresh key per attempt is exactly what defeats the protection.
 */
function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The release channel an app-update read must use.
 *
 * Kept in a module-local mirror rather than read from localStorage on every
 * call: `loadUpdateChannel` touches storage, and the check runs from a React
 * effect on a screen that also polls. `init()` seeds it from storage and
 * `setUpdateChannel` is the only other writer.
 */
let updateChannel: UpdateChannel = "stable";

function readAppUpdateChannel(): UpdateChannel {
  return updateChannel;
}

function stopReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Optimistically merge a just-created session into the discovery list: add
// it to its instance (creating the instance row if discovery hasn't seen it
// yet) so it renders before the first prompt promotes it.
function mergeCreatedSession(
  instances: HubInstance[],
  created: { instanceId: string; sessionId: string; workspace: string },
): HubInstance[] {
  const session: HubSessionInfo = {
    sessionId: created.sessionId,
    updatedAt: Date.now(),
  };
  const idx = instances.findIndex((i) => i.id === created.instanceId);
  if (idx === -1)
    return [
      ...instances,
      {
        id: created.instanceId,
        workspace: created.workspace,
        origin: "serve",
        sessions: [session],
      },
    ];
  const inst = instances[idx];
  if (inst.sessions.some((x) => x.sessionId === session.sessionId))
    return instances;
  const next = [...instances];
  next[idx] = {
    ...inst,
    workspace: inst.workspace ?? created.workspace,
    sessions: [...inst.sessions, session],
  };
  return next;
}

// The profile matching the book's active entry (first entry as fallback).
function activeProfile(
  servers: SavedServer[],
  activeId: string | null,
): ConnectionProfile | null {
  const s = servers.find((x) => x.id === activeId) ?? servers[0];
  return s ? { hubUrl: s.hubUrl, token: s.token } : null;
}

// Session/connection-scoped reset shared by disconnect, server switch and
// active-server delete. Quota data clears too — it belongs to the hub being
// left, not to the instance connection.
function connectionResetPatch(): Partial<AppState> {
  return {
    connState: "idle",
    instanceId: null,
    activeSessionId: null,
    messages: [],
    pendingPrompts: {},
    planEntries: null,
    permissions: {},
    elicitations: {},
    notice: null,
    replayCursor: null,
    hasMore: false,
    totalMessages: null,
    loadingEarlier: false,
    configOptions: [],
    currentModeId: null,
    usage: null,
    cacheHit: null,
    availableCommands: [],
    usageStats: null,
    usageStatsAt: null,
    sessionStates: {},
    quotaUnavailable: false,
    fsCapable: false,
    pageMarkerCapable: false,
    loadingSession: false,
    isRunning: false,
    // Configuration state describes ONE machine, so it is re-probed on the
    // next hub rather than carried across. Two things make that mandatory:
    // the in-flight install polling and the reset-card session name a provider
    // whose card may have changed underneath us, and `configSupported` only
    // re-probes while it is still null — a stale false from an older hub would
    // permanently report "no settings API" against one that has it.
    //
    // `pendingRestart` is the one that can do damage rather than mislead: it is
    // "THIS bridge owes a restart". Left set across a hub switch, the next
    // machine's screens offer a restart whose backend never had the write —
    // and accepting it cancels that machine's in-flight turns for nothing.
    appUpdateInstall: null,
    resetCards: null,
    resetProviderId: null,
    resetNonce: null,
    resetIdempotencyKey: null,
    resetEligible: [],
    resetCredentials: true,
    resetBusy: false,
    resetNextTryAt: null,
    pendingRestart: false,
    // The capability verdict and every payload are re-read from the NEXT hub,
    // not carried over from this one. `configSupported` matters most: a false
    // left behind by an older hub would make the entry screen report "this hub
    // has no settings API" against a hub that does, and the probe only runs
    // when the value is still null — so a stale false is permanent.
    configSupported: null,
    configLoading: false,
    configError: null,
    configAll: null,
    configModels: null,
    configSkills: null,
    configMcp: null,
    configHooks: null,
    configAgents: null,
    configUsage: null,
    configUsageRange: "7d",
    configBackups: null,
    configAppUpdate: null,
  };
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
    // The optimistic bubble inserted below must see every ARRIVED update:
    // a turn's trailing chunks precede its settle notification on the wire
    // but may still sit in applyUpdate's 120ms batch — inserting first
    // would land the queued message in the middle of the finished turn.
    flushUpdateBatch();
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

  // Shared connection teardown for the hub-level transitions (disconnect /
  // switch server / delete active server): everything those paths do besides
  // their own state reset.
  function teardownConnection(): void {
    stopPolling();
    stopReconnect();
    connSeq++; // invalidate any in-flight connection events
    acp?.close();
    acp = null;
    pendingResponds.clear();
    pendingElicitResponds.clear();
    reconnectAttempt = 0;
    dropQueuedUpdates();
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

  // `_meta.zcode.earlierPage` on session/load_earlier paged updates — the
  // bridge marks page replays so live-turn updates streaming while the page
  // request is in flight can be told apart (they must append, not ride the
  // prepend). Only consulted while pageMarkerCapable is true; older bridges
  // fall back to buffering everything during the collection window.
  function isEarlierPageMeta(meta: unknown): boolean {
    if (typeof meta !== "object" || meta === null) return false;
    const zcode = (meta as { zcode?: { earlierPage?: unknown } }).zcode;
    return (
      typeof zcode === "object" && zcode !== null && zcode.earlierPage === true
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
  // Page updates (marked earlierPage) arriving OUTSIDE the collection window
  // — the load_earlier response already landed. They are replay content by
  // construction, never live, so they must not fall into applyUpdate (that
  // lands them at the tail: older messages appended after the newest ones).
  // Hold them briefly so a burst coalesces into ONE prepended segment.
  let latePageBuffer: {
    sessionId: string;
    u: SessionUpdate;
    meta?: unknown;
  }[] = [];
  let latePageTimer: ReturnType<typeof setTimeout> | null = null;

  // Legacy bridges (< PAGE_MARKER_BRIDGE_VERSION) cannot mark page updates,
  // and any bridge's load_earlier response may overtake its own page
  // notifications on the wire (the bridge dispatches them fire-and-forget).
  // On a marker-capable bridge the marker alone routes the stragglers into
  // the late-page buffer (prepended). Without a marker the collection window
  // must survive the response and stay open until the page's burst goes
  // quiet — closing it on the response appends the rest of the page after the
  // newest message, which reads as a middle chunk of an old session landing
  // at the end.
  const EARLIER_WINDOW_QUIET_MS = 600;
  const EARLIER_WINDOW_CAP_MS = 20_000;
  let earlierStreamLastAt = 0;

  function dropQueuedUpdates(): void {
    updateQueue = [];
    collectingEarlier = false;
    earlierBuffer = [];
    latePageBuffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (latePageTimer) {
      clearTimeout(latePageTimer);
      latePageTimer = null;
    }
  }

  // Prepends whatever late page updates accumulated as its own oldest-first
  // segment, mirroring loadEarlier's assembly (messages only; same seam
  // dedupe against the current head). Stale sessions are dropped.
  function flushLatePage(): void {
    latePageTimer = null;
    const page = latePageBuffer;
    latePageBuffer = [];
    if (page.length === 0) return;
    set((state) => {
      const sid = state.activeSessionId;
      if (!sid) return {};
      let segment: ChatMessage[] = [];
      let mine = false;
      for (const { sessionId, u, meta } of page) {
        if (sessionId !== sid) continue;
        mine = true;
        const r = applyOne(segment, u, meta);
        if (r?.messages) segment = r.messages;
      }
      if (!mine || segment.length === 0) return {};
      let rest = state.messages;
      if (rest.length && segment[segment.length - 1].id === rest[0].id) {
        // Seam dedupe: the same message split across pages.
        const seam = segment[segment.length - 1];
        segment = segment.slice(0, -1);
        if (segment.length === 0) return {};
        rest = [
          { ...seam, parts: [...seam.parts, ...rest[0].parts] },
          ...rest.slice(1),
        ];
      }
      return { messages: [...segment, ...rest] };
    });
  }

  // Closes the legacy (unmarked-page) collection window once the update stream
  // has gone quiet, the hard cap fires, or our own prompt starts — the page is
  // over and anything still arriving is live content that must append. The
  // caller assembles the buffered page after this resolves.
  function settleEarlierWindow(): Promise<void> {
    return new Promise((resolve) => {
      const capAt = Date.now() + EARLIER_WINDOW_CAP_MS;
      const step = () => {
        const now = Date.now();
        if (
          now - earlierStreamLastAt >= EARLIER_WINDOW_QUIET_MS ||
          now >= capAt ||
          localPromptActive
        ) {
          collectingEarlier = false;
          resolve();
          return;
        }
        setTimeout(step, 200);
      };
      setTimeout(step, 200);
    });
  }

  // Applies (or re-applies) whatever arrived since the last batch. Called by
  // the 120ms coalescing timer and synchronously by flushPending, which must
  // not let the optimistic bubble overtake already-received turn content.
  function flushUpdateBatch(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = updateQueue;
    if (batch.length === 0) return;
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
      flushUpdateBatch();
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
      title?: unknown;
      content?: unknown;
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
    // Wire-provided popup fields (bridge 0.33+): title and content text
    // blocks carry the readable form of the input — prefer them over the
    // matched tool_call part and the INPUT_KEYS heuristic.
    const title =
      typeof tc.title === "string" && tc.title ? tc.title : undefined;
    let contentText: string | undefined;
    if (Array.isArray(tc.content)) {
      const texts = tc.content
        .map(
          (b) =>
            (b as { content?: { text?: unknown } } | null)?.content?.text ??
            null,
        )
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (texts.length > 0) contentText = texts.join("\n\n");
    }
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
    if (
      !toolCallId &&
      rawInputText == null &&
      title == null &&
      contentText == null
    )
      return undefined;
    return {
      toolCallId,
      // Part fields first (richer); title = the wire title stored in toolName.
      toolName: part?.rawName ?? part?.toolName,
      kind: part?.kind,
      title: title ?? part?.toolName,
      detail: contentText ?? part?.detail,
      plan,
      rawInputText,
    };
  }

  // Parses an elicitation/create form into renderable fields: the bridge's
  // buildAskUserElicitationForm shape (`q_<i>` enum/array + `q_<i>_other`
  // free-text companion) and the plan-approval form (single `approval` enum
  // field whose `description` carries the full plan markdown). The skip
  // sentinel option is dropped — an unanswered field IS the skip (the
  // bridge's parser treats absent as skipped).
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
            description?: unknown;
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
        description:
          typeof prop.description === "string" && prop.description.trim()
            ? prop.description
            : undefined,
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
  // Belt-and-braces for the same freeze in mid-(re)connect: an attempt wedged
  // past its deadline, or a "reconnecting" with no timer left, gets the same
  // teardown — without this the connect() timeout is the only way out.
  function teardownZombieConnection(): void {
    connSeq++;
    acp?.close();
    acp = null;
    connectingSince = 0;
    pendingResponds.clear();
    pendingElicitResponds.clear();
    set({ permissions: {}, elicitations: {}, sessionStates: {} });
    scheduleReconnect();
  }

  async function wakeProbe(): Promise<void> {
    const s = get();
    if (!s.profile || !s.instanceId) return;
    if (s.connState === "open") {
      if (await probeAlive(5000)) return;
      if (get().connState !== "open") return; // closed meanwhile — loop has it
      teardownZombieConnection();
      return;
    }
    if (
      (s.connState === "connecting" &&
        connectingSince > 0 &&
        Date.now() - connectingSince > 30_000) ||
      (s.connState === "reconnecting" && !reconnectTimer)
    ) {
      teardownZombieConnection();
    }
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
        permissions: {},
        elicitations: {},
        notice: "notice.instanceGone",
        fsCapable: false,
        pageMarkerCapable: false,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        cacheHit: null,
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
          connectingSince = 0;
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
            pendingResponds.clear();
            pendingElicitResponds.clear();
            set({
              permissions: {},
              elicitations: {},
              sessionStates: {},
            });
            scheduleReconnect();
          }
        }
      },
      onUpdate: (sessionId, update, meta) => {
        if (stale()) return;
        // Page updates ride the earlier buffer; live-turn updates streaming
        // during the page request append normally instead of being prepended
        // to the top with the page. On a marker-capable bridge (0.44.1+) the
        // bridge marks pages on the update's own _meta (same placement as the
        // tool-fold flags; notification-level meta as a fallback); an older
        // bridge sends unmarked pages, so everything buffers as before.
        // Marked updates arriving OUTSIDE the window are still replay, never
        // live — they take the late-page buffer (prepended), never the tail.
        const marked =
          isEarlierPageMeta((update as { _meta?: unknown })._meta) ||
          isEarlierPageMeta(meta);
        if (
          collectingEarlier &&
          sessionId === get().activeSessionId &&
          (!get().pageMarkerCapable || marked)
        ) {
          earlierBuffer.push({ sessionId, u: update, meta });
          earlierStreamLastAt = Date.now();
          return;
        }
        if (marked) {
          latePageBuffer.push({ sessionId, u: update, meta });
          if (!latePageTimer) {
            latePageTimer = setTimeout(() => {
              latePageTimer = null;
              flushLatePage();
            }, 120);
          }
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
          set((s) => ({
            permissions: {
              ...s.permissions,
              [sessionId]: {
                requestId: req.id,
                sessionId,
                options: options.filter((o) => typeof o.optionId === "string"),
                context: buildApprovalContext(req.params),
              },
            },
          }));
          // respond is captured by answerPermission through the stored request id.
          pendingResponds.set(req.id, respond);
        } else if (req.method === "elicitation/create") {
          // AskUserQuestion / plan-approval form — the bridge's preferred
          // channel once any client advertises elicitation.form, which we
          // now declare ourselves in initialize (see AcpConnection).
          const parsed = parseElicitationForm(req.params);
          if (parsed) {
            setActivity(parsed.sessionId, { awaitingPermission: true });
            set((s) => ({
              elicitations: {
                ...s.elicitations,
                [parsed.sessionId]: { requestId: req.id, ...parsed },
              },
            }));
            pendingElicitResponds.set(req.id, respond);
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
        // We lost the Permission Race; drop the dialog(s) for this request.
        const cleared: string[] = [];
        set((s) => {
          const permissions = { ...s.permissions };
          const elicitations = { ...s.elicitations };
          for (const [sid, p] of Object.entries(permissions)) {
            if (p.requestId === id) {
              delete permissions[sid];
              cleared.push(sid);
            }
          }
          for (const [sid, e] of Object.entries(elicitations)) {
            if (e.requestId === id) {
              delete elicitations[sid];
              cleared.push(sid);
            }
          }
          return { permissions, elicitations };
        });
        for (const sid of cleared)
          setActivity(sid, { awaitingPermission: false });
        pendingResponds.delete(id);
        pendingElicitResponds.delete(id);
      },
    });
    acp = conn;
    connectingSince = Date.now();
    try {
      const init = await conn.connect();
      if (stale()) return;
      connectingSince = 0;
      set({
        fsCapable: init.agentCapabilities?._meta?.zcode?.fs === true,
        pageMarkerCapable: bridgeSupportsPageMarker(
          (init.agentInfo as { version?: unknown } | undefined)?.version,
        ),
      });
      const active = get().activeSessionId;
      if (active) {
        // Replay is the catch-up mechanism after any disconnect.
        await get().loadSession(active);
      }
    } catch {
      connectingSince = 0;
      if (get().instanceId === instanceId) scheduleReconnect();
    }
  }

  const pendingResponds = new Map<number, (result: unknown) => void>();
  const pendingElicitResponds = new Map<number, (result: unknown) => void>();

  // Scales the whole UI: every Tailwind text/size class is rem-based, so
  // overriding the root font size is enough. "small" keeps the browser
  // default (16px) — i.e. the pre-setting look.
  const FONT_SIZE_PX = { small: "16px", medium: "17.5px", large: "19px" };
  function applyFontSize(size: FontSize) {
    document.documentElement.style.fontSize = FONT_SIZE_PX[size];
  }

  return {
    profile: null,
    savedServers: [],
    activeServerId: null,
    manageOpen: false,
    lang: "en",
    fontSize: "small" as FontSize,
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
    permissions: {},
    elicitations: {},
    notice: null,
    toast: null,
    replayCursor: null,
    hasMore: false,
    totalMessages: null,
    loadingEarlier: false,
    configOptions: [],
    currentModeId: null,
    usage: null,
    cacheHit: null,
    availableCommands: [],
    usageStats: null,
    usageStatsAt: null,
    sessionStates: {},
    quotaUnavailable: false,
    fsCapable: false,
    pageMarkerCapable: false,
    loadingSession: false,
    configOpen: false,
    configSection: null,
    configSupported: null,
    configLoading: false,
    configError: null,
    configAll: null,
    configModels: null,
    configSkills: null,
    configMcp: null,
    configHooks: null,
    configAgents: null,
    configUsage: null,
    configUsageRange: "7d",
    configBackups: null,
    configAppUpdate: null,
    appUpdateInstall: null,
    resetCards: null,
    resetProviderId: null,
    resetNonce: null,
    resetIdempotencyKey: null,
    resetEligible: [],
    resetCredentials: true,
    resetBusy: false,
    resetNextTryAt: null,
    pendingRestart: false,
    // Seeded from storage by init(), like every other persisted preference —
    // the initial state must stay free of storage calls so the node-environment
    // tests (which have no localStorage) can import the store.
    updateChannel: "stable",

    init: () => {
      const book = loadServerBook();
      const fontSize = loadFontSize();
      applyFontSize(fontSize);
      // Seed the channel mirror and the state together, so a stored "preview"
      // is in effect before the first app-update read.
      updateChannel = loadUpdateChannel();
      set({
        savedServers: book?.servers ?? [],
        activeServerId: book?.activeId ?? null,
        profile: book ? activeProfile(book.servers, book.activeId) : null,
        lang: loadLang(),
        fontSize,
        updateChannel,
      });
      if (book) {
        startPolling();
        // Plain HTTP (no instance connection needed); slow-moving data.
        void get().refreshUsageStats();
      }
    },

    connectToHub: (input) => {
      // Normalize before the upsert so "http://hub" and "http://hub/" land
      // on the same entry instead of duplicating it.
      const hubUrl = input.hubUrl.trim().replace(/\/+$/, "");
      const token = input.token.trim();
      const label = input.name?.trim();
      const servers = [...get().savedServers];
      const idx = servers.findIndex((x) => x.hubUrl === hubUrl);
      let activeId: string;
      if (idx >= 0) {
        // An empty name keeps the entry's own — reconnecting to a saved URL
        // must not clobber a custom display name with the host default.
        servers[idx] = {
          ...servers[idx],
          hubUrl,
          token,
          ...(label ? { name: label } : {}),
        };
        activeId = servers[idx].id;
      } else {
        const server: SavedServer = {
          id: newServerId(),
          name: label || defaultServerName(hubUrl),
          hubUrl,
          token,
        };
        servers.push(server);
        activeId = server.id;
      }
      saveServerBook({ servers, activeId });
      discoveryFailures = 0;
      set({
        savedServers: servers,
        activeServerId: activeId,
        profile: { hubUrl, token },
        instances: [],
        instancesError: null,
        hubOffline: false,
        manageOpen: false,
      });
      startPolling();
      void get().refreshUsageStats();
    },

    disconnectHub: () => {
      teardownConnection();
      saveServerBook({ servers: get().savedServers, activeId: null });
      savePending({});
      set({
        activeServerId: null,
        profile: null,
        instances: [],
        instancesError: null,
        hubOffline: false,
        manageOpen: false,
        ...connectionResetPatch(),
      });
    },

    switchServer: (id) => {
      const target = get().savedServers.find((x) => x.id === id);
      if (!target) return;
      teardownConnection();
      saveServerBook({ servers: get().savedServers, activeId: id });
      savePending({});
      discoveryFailures = 0;
      set({
        activeServerId: id,
        profile: { hubUrl: target.hubUrl, token: target.token },
        instances: [],
        instancesError: null,
        hubOffline: false,
        manageOpen: false,
        ...connectionResetPatch(),
      });
      startPolling();
      void get().refreshUsageStats();
    },

    saveServer: (entry) => {
      const s = get();
      const idx = s.savedServers.findIndex((x) => x.id === entry.id);
      if (idx === -1) return;
      const hubUrl = entry.hubUrl.trim().replace(/\/+$/, "");
      const servers = [...s.savedServers];
      servers[idx] = {
        ...entry,
        hubUrl,
        name: entry.name.trim() || defaultServerName(hubUrl),
      };
      saveServerBook({ servers, activeId: s.activeServerId });
      set({ savedServers: servers });
      if (entry.id === s.activeServerId) {
        // The live connection still points at the old URL/token — re-run the
        // switch path so the edit takes effect immediately.
        get().switchServer(entry.id);
      }
    },

    deleteServer: (id) => {
      const s = get();
      const servers = s.savedServers.filter((x) => x.id !== id);
      if (servers.length === s.savedServers.length) return;
      if (s.activeServerId !== id) {
        saveServerBook({ servers, activeId: s.activeServerId });
        set({ savedServers: servers });
        return;
      }
      // Deleting the active server: disconnect back to the manager screen.
      teardownConnection();
      saveServerBook({ servers, activeId: null });
      savePending({});
      set({
        savedServers: servers,
        activeServerId: null,
        profile: null,
        instances: [],
        instancesError: null,
        hubOffline: false,
        manageOpen: false,
        ...connectionResetPatch(),
      });
    },

    openServerManager: () => set({ manageOpen: true }),

    closeServerManager: () => set({ manageOpen: false }),

    setLang: (lang) => {
      saveLang(lang);
      set({ lang });
    },

    setFontSize: (size) => {
      saveFontSize(size);
      applyFontSize(size);
      set({ fontSize: size });
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

    connectInstance: async (instanceId, attachSessionId, opts) => {
      const s = get();
      if (!s.profile) return;
      stopReconnect();
      reconnectAttempt = 0;
      pendingResponds.clear();
      pendingElicitResponds.clear();
      dropQueuedUpdates();
      set({
        instanceId,
        connState: "connecting",
        activeSessionId: null,
        messages: [],
        planEntries: null,
        permissions: {},
        elicitations: {},
        notice: null,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        cacheHit: null,
        availableCommands: [],
        fsCapable: false,
        pageMarkerCapable: false,
        // usageStats stays: quota is hub-level (/api/quota), not tied to the
        // instance connection — switching instances must not blank the card.
        sessionStates: {},
        loadingSession: false,
      });
      await openConnection(s.profile, instanceId);
      // Attach to the requested session, else the most recently updated one.
      // noAttach (remote session-create): the caller opens a FRESH session
      // itself — never auto-attach a recycled instance's history.
      if (
        !opts?.noAttach &&
        get().connState === "open" &&
        !get().activeSessionId
      ) {
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

    // Remote session-create (bridge 0.17.0, ADR-0014): start a NEW CLI
    // session in one of the machine's known projects. Creates (or reuses) a
    // headless serve bridge for the workspace, connects it with noAttach,
    // and opens a fresh session whose cwd is the project directory. The new
    // conversation counts as "no activity" on the bridge until its first
    // prompt lands it in discovery — normal, not an error.
    createProjectSession: async (workspacePath) => {
      const client = hub();
      if (!client) return false;
      let created: HubCreateInstanceResult;
      try {
        created = await client.createInstance(workspacePath);
      } catch (e) {
        set({
          notice:
            e instanceof HubApiError && e.status === 403
              ? "notice.projectUnknown"
              : `create session failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        return false;
      }
      // Discovery refresh (best-effort) so the new instance shows in the
      // list; the connection itself does not depend on it.
      void get()
        .refreshInstances()
        .catch(() => undefined);
      await get().connectInstance(created.id, undefined, { noAttach: true });
      if (get().connState !== "open" || !acp) {
        // POST succeeded but the WS never opened (e.g. serve bridge died
        // between registration and connect); scheduleReconnect owns the
        // retry. Surface it or pick() silently restores its buttons.
        set({ notice: "create session failed: instance connection failed" });
        return false;
      }
      try {
        // cwd is REQUIRED by the ACP schema — a request without it is
        // rejected -32602 before the bridge's serve-mode handler (which
        // ignores the value in favor of the process cwd) ever runs.
        const result = (await acp.request("session/new", {
          cwd: workspacePath,
          mcpServers: [],
        })) as {
          sessionId: string;
          configOptions?: ConfigOption[];
          modes?: { currentModeId?: string };
        };
        set((s) => ({
          activeSessionId: result.sessionId,
          configOptions: result.configOptions ?? [],
          currentModeId: result.modes?.currentModeId ?? null,
          loadingSession: false,
          // Discovery skips the conversation until its first prompt — seed
          // it locally so the session list shows it right away.
          instances: mergeCreatedSession(s.instances, {
            instanceId: created.id,
            sessionId: result.sessionId,
            workspace: workspacePath,
          }),
        }));
        return true;
      } catch (e) {
        set({
          notice: `create session failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        return false;
      }
    },

    // Resume a closed session from the project history listing (bridge
    // 0.19.0, ADR-0015): the store id (`sess_…`) rides the POST body so the
    // hub incubates a resume TUI that boots straight into the session
    // (ADR-0017) — always a NEW instance, never the listing's live serve
    // bridge. The attach below then session/loads the same id on that
    // instance, sharing the bridge (and backend process) with the window.
    resumeProjectSession: async (workspacePath, sessionId) => {
      const client = hub();
      if (!client) return false;
      let created: HubCreateInstanceResult;
      try {
        created = await client.createInstance(workspacePath, sessionId);
      } catch (e) {
        set({
          notice:
            e instanceof HubApiError && e.status === 403
              ? "notice.projectUnknown"
              : `resume session failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        return false;
      }
      // Discovery refresh (best-effort) so the instance shows in the lists.
      void get()
        .refreshInstances()
        .catch(() => undefined);
      await get().connectInstance(created.id, sessionId);
      // The attach (session/load) sets activeSessionId synchronously before it
      // issues the request, so a non-null id is the same signal the old caller
      // used — kept explicit here rather than inferred from the route swap.
      if (get().connState !== "open" || !get().activeSessionId) {
        // POST succeeded but the WS never opened; scheduleReconnect owns the
        // retry. Surface it or pick() silently restores its buttons.
        set({ notice: "resume session failed: instance connection failed" });
        return false;
      }
      return true;
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

    shutdownInstance: async (instanceId) => {
      const client = hub();
      if (!client) return;
      try {
        await client.shutdownInstance(instanceId);
      } catch (e) {
        set({
          notice: `shutdown instance failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
        return;
      }
      // Drop the instance locally; the heartbeat list aligns within ~10s.
      set((state) => ({
        instances: state.instances.filter((i) => i.id !== instanceId),
      }));
      if (get().instanceId !== instanceId) {
        set({ notice: "notice.instanceShutdown" });
        return;
      }
      // We were connected to it: same teardown as tryReconnect's "instance
      // gone" branch — the sessions died with the bridge (contract).
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
        permissions: {},
        elicitations: {},
        notice: "notice.instanceShutdown",
        fsCapable: false,
        pageMarkerCapable: false,
        replayCursor: null,
        hasMore: false,
        totalMessages: null,
        loadingEarlier: false,
        configOptions: [],
        currentModeId: null,
        usage: null,
        cacheHit: null,
        availableCommands: [],
        // usageStats stays (hub-level quota, not instance-scoped).
        sessionStates: {},
        loadingSession: false,
        isRunning: false,
      });
      reconnectAttempt = 0;
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
      dropQueuedUpdates();
      const leaving = get().activeSessionId;
      // The leaving session's dialogs are gone — drop their respond handles
      // too (the bridge's race resolves elsewhere or dies with the turn).
      const leavingPerm = leaving ? get().permissions[leaving] : undefined;
      const leavingElicit = leaving ? get().elicitations[leaving] : undefined;
      if (leavingPerm) pendingResponds.delete(leavingPerm.requestId);
      if (leavingElicit) pendingElicitResponds.delete(leavingElicit.requestId);
      set((s) => {
        // Other sessions' pending dialogs stay: a request raised in session
        // A keeps waiting in the bridge's first-response-wins race, and the
        // awaitingPermission badge points the user back into A to answer.
        const permissions = { ...s.permissions };
        const elicitations = { ...s.elicitations };
        if (s.activeSessionId) {
          delete permissions[s.activeSessionId];
          delete elicitations[s.activeSessionId];
        }
        return {
          activeSessionId: null,
          messages: [],
          planEntries: null,
          permissions,
          elicitations,
          notice: null,
          replayCursor: null,
          hasMore: false,
          totalMessages: null,
          loadingEarlier: false,
          configOptions: [],
          currentModeId: null,
          usage: null,
          cacheHit: null,
          availableCommands: [],
          loadingSession: false,
          isRunning: false,
        };
      });
    },

    loadSession: async (sessionId) => {
      if (!acp || get().connState !== "open") return;
      // Replay arrives as session/update notifications; reset first. A stale
      // local dialog for THIS session dies here (a still-pending request is
      // re-sent by the bridge after the load and lands as a fresh entry);
      // other sessions' dialogs are untouched.
      dropQueuedUpdates();
      set((s) => {
        const permissions = { ...s.permissions };
        const elicitations = { ...s.elicitations };
        const oldPerm = permissions[sessionId];
        const oldElicit = elicitations[sessionId];
        if (oldPerm) pendingResponds.delete(oldPerm.requestId);
        if (oldElicit) pendingElicitResponds.delete(oldElicit.requestId);
        delete permissions[sessionId];
        delete elicitations[sessionId];
        return {
          activeSessionId: sessionId,
          messages: [],
          planEntries: null,
          permissions,
          elicitations,
          replayCursor: null,
          hasMore: false,
          totalMessages: null,
          loadingEarlier: false,
          configOptions: [],
          currentModeId: null,
          usage: null,
          cacheHit: null,
          availableCommands: [],
          loadingSession: true,
        };
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
        // Drop the in-flight batch AND the partially-applied replay: the
        // wire may have delivered half the tail notifications before the
        // failure, and flushing (or keeping) them paints a mid-conversation
        // stub that reads as reordered history until the next reload. The
        // reconnect replay is the only catch-up — until it lands, show
        // nothing rather than a half.
        dropQueuedUpdates();
        set((s) => ({
          // Transient connection failures stay quiet: the reconnect banner
          // owns them, and the post-reconnect replay supersedes this error.
          ...(isTransientConnError(e)
            ? null
            : { notice: `session/load failed: ${(e as Error).message}` }),
          loadingSession: false,
          ...(s.activeSessionId === sessionId ? { messages: [] } : {}),
        }));
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
      earlierStreamLastAt = Date.now();
      try {
        const result = await acp.request("session/load_earlier", {
          sessionId,
          before: s.replayCursor,
          limit: EARLIER_PAGE_LIMIT,
        });
        if (get().pageMarkerCapable) {
          // Marked bridges close the window on the response: stragglers carry
          // the marker and take the late-page buffer (still a prepend).
          collectingEarlier = false;
        } else {
          // Legacy bridge: unmarked page updates and a response that can
          // overtake them — hold the window until the burst settles so the
          // whole page prepends instead of its tail appending.
          await settleEarlierWindow();
        }
        const page = earlierBuffer;
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
        const result = (await acp.request("session/prompt", {
          sessionId,
          prompt: [
            ...(draft.text ? [{ type: "text", text: draft.text }] : []),
            ...draft.images.map((img) => ({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            })),
          ],
        })) as { usage?: unknown } | null;
        // Per-turn usage rides the prompt response (UNSTABLE ACP field).
        // Turns that report no cache numbers keep the previous rate.
        const hit = cacheHitRate(result?.usage);
        if (hit !== null)
          set((s) =>
            s.activeSessionId === sessionId ? { cacheHit: hit } : {},
          );
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
      const respond = pendingResponds.get(requestId);
      if (!respond) return;
      pendingResponds.delete(requestId);
      const cleared: string[] = [];
      set((s) => {
        const permissions = { ...s.permissions };
        for (const [sid, p] of Object.entries(permissions)) {
          if (p.requestId === requestId) {
            delete permissions[sid];
            cleared.push(sid);
          }
        }
        return { permissions };
      });
      for (const sid of cleared)
        setActivity(sid, { awaitingPermission: false });
      respond({ outcome: { outcome: "selected", optionId } });
    },

    answerElicitation: (requestId, content) => {
      const respond = pendingElicitResponds.get(requestId);
      if (!respond) return;
      pendingElicitResponds.delete(requestId);
      const cleared: string[] = [];
      set((s) => {
        const elicitations = { ...s.elicitations };
        for (const [sid, e] of Object.entries(elicitations)) {
          if (e.requestId === requestId) {
            delete elicitations[sid];
            cleared.push(sid);
          }
        }
        return { elicitations };
      });
      for (const sid of cleared)
        setActivity(sid, { awaitingPermission: false });
      // Wire shape (elicitation/create): accept carries the form content,
      // anything else declines. Absent fields = skipped questions.
      respond(content ? { action: "accept", content } : { action: "decline" });
    },

    dismissNotice: () => set({ notice: null }),

    notify: (text) => {
      const id = ++toastSeq;
      set({ toast: { id, text } });
      if (toastTimer) clearTimeout(toastTimer);
      // A newer toast (higher id) resets the timer; the stale one is a no-op.
      toastTimer = setTimeout(() => {
        toastTimer = null;
        set((s) => (s.toast?.id === id ? { toast: null } : s));
      }, TOAST_MS);
    },

    dismissToast: () => {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      set({ toast: null });
    },

    // ---- ZCode configuration (ADR-0009) ----

    setUpdateChannel: (channel) => {
      updateChannel = channel;
      saveUpdateChannel(channel);
      set({ updateChannel: channel });
      // The stored check is for the channel it was read with; switching without
      // a refetch would leave the screen showing the other stream's verdict.
      const section = get().configSection;
      if (section === "appUpdate") void get().loadConfigSection("appUpdate");
    },

    openConfig: (section = null) =>
      set({ configOpen: true, configSection: section }),

    closeConfig: () => set({ configOpen: false, configSection: null }),

    loadConfigAll: async () => {
      const client = hub();
      if (!client) return;
      set({ configLoading: true, configError: null });
      try {
        const all = await client.settingsAll();
        set({ configAll: all, configLoading: false, configSupported: true });
        // The snapshot carries usage and reset-card eligibility, so a section
        // screen that opens straight after the entry list needs no second
        // request for those two.
        if (all.usage) {
          set({ configUsage: all.usage, configUsageRange: all.usage.range });
        }
        if (all.resetCards) {
          const providers = all.resetCards.providers ?? [];
          // The hub reports the coding-plan provider ids that COULD own cards,
          // not the ones this account actually has — so there is usually more
          // than one and a picker is the norm. Remember the eligibility
          // verdict alongside: `credentials: false` means the store could not
          // be decrypted, which is a different (and non-fatal) state from
          // having no plan at all.
          set({
            resetCards: null,
            resetProviderId: null,
            resetEligible: providers,
            resetCredentials: all.resetCards.credentials !== false,
          });
        }
      } catch (e) {
        // 404 means this hub predates the settings API (bridge < 0.47.0). That
        // is a capability gap, not a failure — the screens explain it.
        if (e instanceof HubApiError && e.status === 404) {
          set({ configSupported: false, configLoading: false });
          return;
        }
        set({
          configError: e instanceof Error ? e.message : String(e),
          configLoading: false,
        });
      }
    },

    loadConfigSection: async (section, arg) => {
      const client = hub();
      if (!client) return;
      set({ configLoading: true, configError: null });
      try {
        switch (section) {
          case "models":
            set({ configModels: await client.settingsModels() });
            break;
          case "skills":
            set({ configSkills: await client.settingsSkills() });
            break;
          case "mcp":
            set({ configMcp: await client.settingsMcp() });
            break;
          case "hooks":
            set({ configHooks: await client.settingsHooks() });
            break;
          case "agents":
            set({ configAgents: await client.settingsAgents() });
            break;
          case "usage": {
            // The route wraps the payload: `{ok, usage}`. Storing the whole
            // response would make every `usage.available` read undefined and
            // the screen would show its "no data" empty state forever.
            const requestedRange = arg?.range ?? "7d";
            // Record the ask BEFORE awaiting: the guard below compares against
            // the newest request, and a read that lands first must not be able
            // to overwrite the record of one still in flight.
            set({ configUsageRange: requestedRange });
            const payload = (await client.settingsUsage(requestedRange)) as {
              usage?: SettingsUsage;
            };
            // Stale-response guard. The range buttons fire a fresh read each
            // tap, and nothing serializes them: tap "All" then "7d" on a slow
            // link and the All response can land AFTER the 7d one, leaving the
            // 7d button highlighting numbers computed for the whole history.
            // The snapshot carries the range it was computed for, so drop any
            // answer that no longer matches what the user asked for last.
            const answeredRange = payload.usage?.range ?? requestedRange;
            if (answeredRange !== get().configUsageRange) return;
            set({ configUsage: payload.usage ?? null });
            break;
          }
          case "backups":
            set({ configBackups: await client.settingsBackups() });
            break;
          case "appUpdate":
            set({
              configAppUpdate: await client.settingsAppUpdate(updateChannel),
            });
            break;
          case "quota":
            // The plan-quota screen reuses the hub-level quota the side panels
            // already show — one source of truth, so the numbers outside and
            // inside can never disagree.
            await get().refreshUsageStats();
            break;
        }
        set({ configLoading: false });
      } catch (e) {
        if (e instanceof HubApiError && e.status === 404) {
          set({ configSupported: false, configLoading: false });
          return;
        }
        set({
          configError: e instanceof Error ? e.message : String(e),
          configLoading: false,
        });
      }
    },

    applyConfigWrite: async (label, write, reload) => {
      try {
        const effect = await write();
        // The effect class is the whole point: an immediate write is done, a
        // needs-restart one has not landed yet and the user must know which.
        // `notice` (an i18n key the banner translates) for the outcome, `notify`
        // (plain English, like every other failure message here) for errors.
        //
        // An undefined effect means the write wrapper found no client — the
        // connection dropped while the screen was open, and NOTHING was sent.
        // Reporting that as success would show a toggle that moved on a machine
        // that never heard about it.
        if (effect === undefined) {
          get().notify(`${label} failed: not connected`);
          return false;
        }
        if (effect === "needs-restart") {
          set({ pendingRestart: true, notice: "notice.configNeedsRestart" });
        }
        for (const section of reload ?? []) {
          await get().loadConfigSection(section);
        }
        return true;
      } catch (e) {
        get().notify(
          `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },

    setProviderEnabled: async (providerId, enabled) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.updateProvider(providerId, { enabled });
      return res.effect;
    },

    setSkillEnabled: async (path, enable) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.setSkillEnabled({ path, enable });
      return res.effect;
    },

    copySkillToUser: async (path) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.copySkillToUser({ path });
      return res.effect;
    },

    upsertModel: async (body) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.addModel(body);
      return res.effect;
    },

    setMcpEnabled: async (name, enable) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.setMcpEnabled(name, enable);
      return res.effect;
    },

    upsertMcp: async (name, body) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.upsertMcpServer(name, body);
      return res.effect;
    },

    setHooksEnabled: async (enabled) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.setHooksEnabled(enabled);
      return res.effect;
    },

    updateHookEntry: async (eventName, matcherIndex, hookIndex, body) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.updateHook(
        eventName,
        matcherIndex,
        hookIndex,
        body,
      );
      return res.effect;
    },

    setAgentEnabled: async (name, enable) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.setAgentEnabled(name, enable);
      return res.effect;
    },

    upsertAgent: async (name, body) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.upsertAgent(name, body);
      return res.effect;
    },

    restoreBackup: async (file, path) => {
      const client = hub();
      if (!client) return undefined;
      const res = await client.restoreBackup({ file, path });
      // The effect follows the file: restoring cliConfig needs a restart,
      // restoring providerConfig is immediate. Report what the bridge said
      // rather than assuming one or the other.
      return res.effect;
    },

    loadResetCards: async (providerId) => {
      const client = hub();
      if (!client) return;
      // Drop the previous provider's inventory NOW, not when the new read
      // lands: while it is in flight the screen would still show provider A's
      // cards, and if this read FAILS it would keep showing them — with a
      // nonce the next spend then sends for a provider it is not looking at.
      set({
        resetBusy: true,
        resetProviderId: providerId,
        resetCards: null,
        resetNonce: null,
        resetIdempotencyKey: null,
      });
      try {
        const status = await client.resetCardStatus(providerId);
        // The provider picker can fire two reads in quick succession. Without
        // this guard the SLOWER one lands last and its nonce is stored
        // alongside the FASTER one's providerId — a spend then pairs a nonce
        // minted for a different provider, which the route always rejects with
        // 409, and the user sees a broken button with no cause to guess.
        if (get().resetProviderId !== providerId) return;
        set({
          resetCards: status.resetCards,
          resetNonce: status.resetCards.nonce,
          // Minted HERE, with the nonce it belongs to, so a spend's every retry
          // sends the same key. Generating it inside the spend instead gave a
          // fresh key per attempt — which is precisely what defeats the
          // backend's dedupe and can burn a second card after a timeout.
          resetIdempotencyKey: newIdempotencyKey(),
          resetBusy: false,
        });
      } catch (e) {
        // Same guard: an error from a read the user has already moved on from
        // must not surface as a toast about a provider they are not looking at.
        if (get().resetProviderId !== providerId) return;
        set({ resetBusy: false });
        get().notify(
          `reset card status failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },

    requestResetOpportunity: async (providerId) => {
      const client = hub();
      if (!client || !providerId) return false;
      // The provider is the caller's, captured when the gesture began. Reading
      // the store here would let a switch that landed while the request was in
      // flight redirect the spend at the new provider's card.
      if (get().resetProviderId && get().resetProviderId !== providerId)
        return false;
      set({ resetBusy: true });
      try {
        const res = await client.requestResetOpportunity({
          providerId,
          idempotencyKey: newIdempotencyKey(),
        });
        set({ resetBusy: false });
        if (!res.opportunity?.granted) {
          // A denial is a normal answer carrying when to try again — the screen
          // shows the countdown rather than an error.
          set({
            notice: "notice.configResetDenied",
            resetNextTryAt: res.opportunity?.nextTryAt ?? null,
          });
          return false;
        }
        set({ resetNextTryAt: null });
        return true;
      } catch (e) {
        set({ resetBusy: false });
        get().notify(
          `reset opportunity failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },

    spendResetCard: async ({ providerId, nonce, resetType }) => {
      const client = hub();
      if (!client || !providerId || !nonce) return false;
      // Same guard as the opportunity: if the user has switched provider since
      // the gesture began, this nonce belongs to another provider's inventory
      // and spending it now would burn the wrong card.
      if (get().resetProviderId && get().resetProviderId !== providerId)
        return false;
      set({ resetBusy: true });
      // The key minted with this nonce, NOT a fresh one. The backend keys the
      // spend on it, so a retry (the 502/504 the bridge answers when a spend
      // may already have been carried out) sends the same value and gets the
      // same outcome. Generating it here instead gave a new key per attempt,
      // which defeats the dedupe and can burn a second card.
      const idempotencyKey = get().resetIdempotencyKey ?? newIdempotencyKey();
      try {
        const res = await client.spendResetCard({
          providerId,
          resetType,
          nonce,
          idempotencyKey,
        });
        set({ resetBusy: false });
        const used = (res as { ok: boolean; used?: boolean }).used !== false;
        set({
          notice: used
            ? "notice.configResetSpent"
            : "notice.configResetSpendFailed",
        });
        // Refresh both surfaces: the card list (one fewer card) and the quota
        // (the window it cleared). A spend that shows no result reads as a
        // failure even when it worked. The refresh also issues the next nonce.
        await get().loadResetCards(providerId);
        await get().refreshUsageStats();
        return used;
      } catch (e) {
        set({ resetBusy: false });
        // 409 = the nonce is no longer the one the server issued (a newer status
        // read replaced it, or the user switched provider). Re-read the status to
        // mint a fresh one and say so: without this the button looks broken and
        // the only escape is finding the refresh control by trial and error.
        //
        // The route burns the nonce only AFTER the spend settles, so a request
        // that reached the server and failed on the way back is NOT a 409 — the
        // same nonce and key still work, which is the retry path this protects.
        if (e instanceof HubApiError && e.status === 409) {
          await get().loadResetCards(providerId);
          set({ notice: "notice.configResetStale" });
          return false;
        }
        get().notify(
          `reset card spend failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },

    markResetHistoryRead: async () => {
      const client = hub();
      const providerId = get().resetProviderId;
      if (!client || !providerId) return;
      try {
        await client.markResetHistoryRead(providerId);
        await get().loadResetCards(providerId);
      } catch {
        // Clearing an unread badge is cosmetic; a failure is not worth a toast.
      }
    },

    installAppUpdate: async (input) => {
      const client = hub();
      if (!client) return;
      try {
        // The channel must travel with the install: the route re-reads the
        // release manifest and refuses any version that is not the LATEST on
        // the channel it was told. A preview user whose install defaulted to
        // stable would be refused with "latest stable version is X, not Y" for
        // a version the check itself offered.
        await client.installAppUpdate({
          ...input,
          channel: input.channel ?? readAppUpdateChannel(),
        });
        // The download runs in the background on the bridge; progress arrives
        // by polling, which the update screen drives.
        await get().pollAppUpdate();
      } catch (e) {
        get().notify(
          `app update install failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },

    pollAppUpdate: async () => {
      const client = hub();
      if (!client) return;
      try {
        // Same channel as the check: a poll that answered for the other stream
        // would overwrite the install state with an unrelated manifest's.
        const res = (await client.settingsAppUpdate(updateChannel)) as {
          appUpdate?: { install?: AppUpdateState };
        };
        if (res.appUpdate?.install)
          set({ appUpdateInstall: res.appUpdate.install });
      } catch {
        // A poll failure is not worth a toast; the next one may succeed.
      }
    },

    restartConfigBackend: async () => {
      const client = hub();
      const s = get();
      // The restart is per-instance: the hub's own settings mount has no
      // backend, so the bridge to disturb must be named. With no session open
      // there is no instance to address, and the restart is unavailable.
      if (!client || !s.instanceId) return -1;
      try {
        const res = await client.restartBackend(s.instanceId);
        // `closed: false` means the old subprocess survived — the writes this
        // restart existed to apply did NOT take effect. Clearing the flag here
        // would hide the affordance the user needs, so it stays armed and the
        // notice says the restart failed rather than succeeded.
        if (res.closed) {
          set({ pendingRestart: false, notice: "notice.configRestarted" });
        } else {
          set({ notice: "notice.configRestartFailed" });
        }
        return res.cancelledTurns;
      } catch (e) {
        get().notify(
          `backend restart failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return -1;
      }
    },
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

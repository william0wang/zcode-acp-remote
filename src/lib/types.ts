// Hub discovery API types (REMOTE-CLIENTS.md contract; fields are additive-only).

export interface HubSessionInfo {
  sessionId: string;
  title?: string;
  updatedAt?: number;
  // Coarse heartbeat indicator (bridge 0.8.0, ADR-0005): "running" | "idle",
  // up to ~10s stale. The live WS broadcast (sessionStates) wins when a
  // connection exists; this is the no-connection fallback for the list.
  status?: string;
}

export interface HubInstance {
  id: string;
  port?: number;
  pid?: number;
  startedAt?: number;
  workspace?: string;
  sessions: HubSessionInfo[];
  [key: string]: unknown;
}

export interface ConnectionProfile {
  hubUrl: string;
  token: string;
}

// Session Files (bridge 0.7.0, ADR-0005): one directory level per call;
// entries sort dirs-first in byte order server-side.
export interface FsEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime?: number;
}

export interface FsListing {
  root: string;
  entries: FsEntry[];
  truncated: boolean;
}

// Session config (session/load result + config_option_update). Shape matches
// the bridge's buildConfigOptions output (id: model | mode | thought).
export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options?: { value: string; name: string }[];
}

// usage_update session/update payload — the editor's context bar data.
export interface ContextUsage {
  used: number;
  size: number;
}

// account/usage_stats (Proposal 0002) — the combined dual-provider quota
// behind the zcode-quota CLI: one GLM section plus one Opencode Go section.
// GLM items pass through verbatim (counts, reset timestamps, per-model
// details); Go windows carry the countdown resolved to absolute epoch ms.
export interface QuotaItem {
  key: string;
  label: string;
  usedPercent: number;
  usedCount?: number;
  totalCount?: number;
  nextResetTime?: number;
  detail?: { modelCode: string; usage: number }[];
}

export interface GlmUsageStats {
  kind: "success" | "auth_error" | "rate_limited" | "unavailable";
  level?: string;
  items?: QuotaItem[];
}

export interface GoWindowEntry {
  key: string;
  label: string;
  usagePercent: number;
  resetsAt: number;
}

export interface GoUsageStats {
  kind: "success" | "not_configured" | "auth_error" | "unavailable";
  windows?: GoWindowEntry[];
}

export interface AccountUsageStats {
  glm: GlmUsageStats;
  opencode: GoUsageStats;
}

// available_commands_update entry (ACP AvailableCommand shape): the bridge's
// slash commands, advertised per session after load (overwrite semantics).
export interface SlashCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

// ACP wire types. Deliberately permissive: unknown kinds/fields must be
// ignored. The SessionUpdate union is discriminated by `sessionUpdate`
// (per @agentclientprotocol schema), NOT by `kind`.

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpTextContent {
  type: "text";
  text: string;
}

// Edit/Write results ship structured diffs (old/new line sets reconstructed
// from the backend's patch — NOT a unified-diff string).
export interface AcpDiffContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

function isTextContent(c: unknown): c is AcpTextContent {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { type?: string }).type === "text"
  );
}

// The bridge wraps plain results as {type:"content", content:{type:"text"}}
// (Bash output, plan text, question text); unwrap those too.
function unwrapText(c: unknown): string | null {
  if (isTextContent(c)) return c.text;
  if (
    typeof c === "object" &&
    c !== null &&
    (c as { type?: string }).type === "content"
  ) {
    const inner = (c as { content?: unknown }).content;
    if (isTextContent(inner)) return inner.text;
  }
  return null;
}

function isDiffContent(c: unknown): c is AcpDiffContent {
  if (typeof c !== "object" || c === null) return false;
  const d = c as Partial<AcpDiffContent>;
  return (
    d.type === "diff" &&
    typeof d.newText === "string" &&
    typeof d.path === "string"
  );
}

// Chunk content is a SINGLE ContentBlock on the wire; tool_call_update
// content is an ARRAY of blocks. Accept both.
export function contentText(content: unknown): string {
  if (!content) return "";
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks
    .map(unwrapText)
    .filter((t): t is string => t !== null)
    .join("");
}

export function contentDiffBlocks(content: unknown): AcpDiffContent[] {
  if (!content) return [];
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks.filter(isDiffContent);
}

// Internal chat model, converted to assistant-ui ThreadMessageLike at render time.

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  detail: string;
  status: string;
  // ACP tool kind (execute/edit/read/search/fetch/switch_mode/other…) for
  // icon + colour mapping.
  kind?: string;
  // Raw backend tool name from `_meta.claudeCode.toolName` (e.g. "Bash"),
  // distinct from `toolName` which holds the wire title "Bash: npm test".
  rawName?: string;
  // Replay-only harness fold (`_meta.zcode.kind` on `histfold_` tool_calls,
  // server 0.6.0): "context-handoff" | "tool-transcript". The full plumbing
  // text rides `detail` behind the card's expand.
  foldKind?: string;
  diffs?: AcpDiffContent[];
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | ToolCallPart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
  createdAt: number;
  // Replay-only: harness-injected context handoff rendered collapsed instead
  // of as a wall of user text (`_meta.zcode.collapsed` on the update).
  collapsed?: boolean;
}

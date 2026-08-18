// Hub discovery API types (REMOTE-CLIENTS.md contract; fields are additive-only).

export interface HubSessionInfo {
  sessionId: string;
  title?: string;
  updatedAt?: number;
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

function isTextContent(c: unknown): c is AcpTextContent {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "text";
}

// Chunk content is a SINGLE ContentBlock on the wire; tool_call_update
// content is an ARRAY of blocks. Accept both.
export function contentText(content: unknown): string {
  if (!content) return "";
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks.filter(isTextContent).map((c) => c.text).join("");
}

// Internal chat model, converted to assistant-ui ThreadMessageLike at render time.

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  detail: string;
  status: string;
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

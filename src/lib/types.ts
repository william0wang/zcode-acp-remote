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
}

import type { SessionUpdate } from "./types";

export type AcpConnectionState = "connecting" | "open" | "closed";

export interface ServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface AcpHandlers {
  onState: (state: AcpConnectionState) => void;
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
  onServerRequest: (req: ServerRequest, respond: (result: unknown) => void) => void;
  onCancelRequest: (id: number) => void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// One AcpConnection owns one WebSocket, bound to one bridge instance for its
// whole lifetime (REMOTE-CLIENTS.md). Reconnection means building a new one.
export class AcpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private closedByUs = false;

  constructor(
    private readonly hubUrl: string,
    private readonly token: string,
    private readonly instanceId: string,
    private readonly handlers: AcpHandlers,
  ) {}

  // Resolves once the socket is open and `initialize` (protocolVersion MUST be
  // the number 1) has completed. Any non-open outcome rejects.
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.handlers.onState("connecting");
      const ws = new WebSocket(this.wsUrl());
      this.ws = ws;

      ws.onopen = () => {
        this.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        }).then(
          () => {
            settled = true;
            this.handlers.onState("open");
            resolve();
          },
          (err: Error) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
            this.close();
          },
        );
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket error (bad URL, token, or instance id)"));
        }
      };
      ws.onclose = () => {
        this.failAllPending(new Error("connection closed"));
        if (!settled) {
          settled = true;
          reject(new Error("connection closed before open"));
        }
        if (!this.closedByUs) this.handlers.onState("closed");
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.handleMessage(ev.data);
        // Binary frames are ignored per contract.
      };
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("connection not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // No timeout: session/prompt legitimately runs for minutes.
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respondServerRequest(id: number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  close(): void {
    this.closedByUs = true;
    this.failAllPending(new Error("connection closed"));
    this.ws?.close();
    this.ws = null;
  }

  private wsUrl(): string {
    const url = new URL(this.hubUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    // ws:/wss: pass through unchanged
    url.pathname = url.pathname.replace(/\/+$/, "") + "/acp";
    // Browsers cannot set WS headers, hence ?token= (per contract).
    url.searchParams.set("instance", this.instanceId);
    url.searchParams.set("token", this.token);
    return url.toString();
  }

  private send(msg: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private handleMessage(data: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // Server -> client request (permission / elicitation).
        this.handlers.onServerRequest(
          { id: msg.id, method: msg.method, params: msg.params ?? {} },
          (result) => this.respondServerRequest(msg.id as number, result),
        );
      } else if (msg.method === "session/update") {
        const p = msg.params as { sessionId?: string; update?: SessionUpdate } | undefined;
        if (p && typeof p.sessionId === "string" && p.update) {
          this.handlers.onUpdate(p.sessionId, p.update);
        }
      } else if (msg.method === "$/cancel_request") {
        const id = (msg.params as { id?: number } | undefined)?.id;
        if (typeof id === "number") this.handlers.onCancelRequest(id);
      }
      return;
    }

    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "JSON-RPC error"));
      else entry.resolve(msg.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}

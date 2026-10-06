// @vitest-environment node
// Regression: the replay cache snapshot must include update batches still
// sitting in the 120ms coalescing queue when the session/load response
// resolves. A replay's final chunks typically arrive <120ms before the
// response; snapshotting before the flush wrote them out of the cache while
// totalMessages (from the response meta) already counted them — a later
// wake-reconnect reconciles metadata-only, the count matches, and the cached
// transcript stays forever missing its last message (the live store keeps it,
// so only a cache-painted reattach shows the hole).
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { readSessionCache } from "../src/store/replay";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
}

// Minimal WS double from session-cache.test.ts: OPEN from birth, answers
// initialize; session/load is HELD until settleLoad answers it, so a test can
// queue replay notifications and then land the response while they are still
// inside the 120ms coalescing window.
class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Frame[] = [];
  private held: Array<number | undefined> = [];

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame.method === "initialize") {
      this.reply(frame.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "zcode-acp-server", version: "0.44.1" },
      });
    } else if (frame.method === "session/load") {
      this.held.push(frame.id);
    }
  }

  server(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  settleLoad(result: unknown): void {
    const id = this.held.shift();
    if (id !== undefined) this.reply(id, result);
  }

  loads(): Frame[] {
    return this.sent.filter((f) => f.method === "session/load");
  }

  loadLimit(frame: Frame): unknown {
    return (
      (frame.params?._meta as { zcode?: { limit?: unknown } } | undefined)
        ?.zcode?.limit ?? null
    );
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  private reply(id: number | undefined, result: unknown): void {
    if (id === undefined) return;
    this.server({ jsonrpc: "2.0", id, result });
  }
}

beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => void backing.clear(),
  };
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/api/instances")
      ? JSON.stringify([
          {
            id: "inst1",
            workspace: "/w",
            sessions: [{ sessionId: "sess_1", updatedAt: 1 }],
          },
        ])
      : url.includes("/api/quota")
        ? JSON.stringify({
            glm: { kind: "unavailable" },
            opencode: { kind: "not_configured" },
          })
        : "{}";
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

afterAll(() => {
  void import("../src/store/appStore").then((m) =>
    m.useAppStore.getState().disconnectHub(),
  );
});

const flush = () => new Promise((r) => setTimeout(r, 250));

function chunk(ws: FakeWebSocket, sessId: string, text: string): void {
  ws.server({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: sessId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        messageId: `m_${text}`,
      },
    },
  });
}

async function attach() {
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;
  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  await vi.waitFor(() => expect(store.getState().activeSessionId).toBe("sess_1"));
  return store;
}

test("a queued tail chunk when the load response lands still reaches the cache (and survives reconcile-equal)", async () => {
  const store = await attach();
  const ws = FakeWebSocket.current!;
  const has = (needle: string) =>
    store
      .getState()
      .messages.some((m) => JSON.stringify(m.parts).includes(needle));

  // First attach: full tail replay (limit 30), held. EARLY flushes through
  // the 120ms coalescer; FINAL is queued and the response lands immediately
  // after — inside FINAL's coalescing window.
  await vi.waitFor(() => expect(ws.loads().length).toBe(1));
  chunk(ws, "sess_1", "EARLY");
  await new Promise((r) => setTimeout(r, 200)); // EARLY past its flush tick
  chunk(ws, "sess_1", "FINAL"); // still queued when the response resolves
  ws.settleLoad({ replayMeta: { cursor: "c0", hasMore: false, totalMessages: 2 } });
  await vi.waitFor(() => expect(store.getState().loadingSession).toBe(false));
  await flush();

  // The live store applied FINAL through flushPending...
  expect(has("FINAL")).toBe(true);
  // ...and the cache (what a wake-reconnect paints) must agree with it.
  const cached = readSessionCache("sess_1");
  expect(cached).not.toBeNull();
  expect(
    cached!.messages.some((m) => JSON.stringify(m.parts).includes("FINAL")),
  ).toBe(true);

  // Wake-reconnect shape: cache paint + metadata-only reconcile that reports
  // the SAME totalMessages (it counted FINAL all along) — the painted view
  // must still show FINAL.
  void store.getState().loadSession("sess_1");
  expect(has("FINAL")).toBe(true); // painted from the cache
  await vi.waitFor(() => expect(ws.loads().length).toBe(2));
  expect(ws.loadLimit(ws.loads()[1])).toBe(0);
  ws.settleLoad({
    replayMeta: { cursor: "end", hasMore: false, totalMessages: 2, turnActive: false },
  });
  await vi.waitFor(() => expect(store.getState().loadingSession).toBe(false));
  await flush();
  expect(has("FINAL")).toBe(true);
});

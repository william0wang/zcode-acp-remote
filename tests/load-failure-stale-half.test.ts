// @vitest-environment node
// Regression test: a failed session/load must not leave a stale HALF replay.
//
// The bug: replay notifications stream in BEFORE the load response, and a
// disconnect mid-load (the phone's long first-open window makes this common)
// rejects the request via failAllPending while part of the tail may already
// sit in the 120ms batch — or have been flushed into `messages`. The old
// catch only cleared loadingSession, so the UI kept painting a
// mid-conversation stub that read as reordered history until the next
// reload. Re-entry replayed the full tail, which is why the symptom
// "wrong order on first restore, correct after re-enter" matched.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
}

// Minimal WS double: OPEN from birth, answers initialize, HOLDS session/load
// open forever (the slow first-open), then dies on demand.
class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    if (frame.method === "initialize") {
      this.reply(frame.id, { protocolVersion: 1, agentCapabilities: {} });
    }
    // session/load is deliberately never answered.
  }

  server(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  die(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  close(): void {
    this.readyState = 3;
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
    setItem: (k: string, v: string) => backing.set(k, String(v)),
    removeItem: (k: string) => backing.delete(k),
    clear: () => backing.clear(),
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
  // Stop the 4s discovery poll so the worker can exit.
  void import("../src/store/appStore").then((m) =>
    m.useAppStore.getState().disconnectHub(),
  );
});

test("a mid-load disconnect must not keep (or flush) the partial replay", async () => {
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;

  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  await vi.waitFor(() =>
    expect(store.getState().activeSessionId).toBe("sess_1"),
  );

  // The bridge streams part of the tail (three messages, four chunks each),
  // then the phone's link dies before the load response arrives.
  const ws = FakeWebSocket.current!;
  const chunk = (messageId: string, text: string) =>
    ws.server({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      },
    });
  for (let m = 1; m <= 3; m++) {
    for (let c = 1; c <= 4; c++) chunk(`msg_${m}`, `m${m}-chunk${c} `);
  }
  ws.die();

  // Let any armed 120ms coalescing timer fire — the exact window where the
  // stale half used to land. Reconnects back off, so none fires this fast.
  await new Promise((r) => setTimeout(r, 400));

  const msgs = store.getState().messages;
  expect(store.getState().loadingSession).toBe(false);
  // Nothing: the reconnect replay is the only catch-up. A stale half reads
  // as "conversation starts in the middle / reordered".
  expect(msgs.length).toBe(0);
});

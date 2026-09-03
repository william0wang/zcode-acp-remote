// @vitest-environment node
// Regression test: a queued follow-up (pendingPrompts) must appear AFTER the
// running turn's content once it is flushed — never inside it.
//
// The bug: session/update application is coalesced on a 120ms timer, while
// flushPending() inserts the queued draft's optimistic bubble synchronously
// the moment the turn settles. The turn's trailing chunks precede the settle
// notification on the wire but may still sit unapplied in the batch, so the
// bubble landed before them (and ensureMessage then opened a new assistant
// message after it — or merged the bubble into the previous user message).
// Replay on re-enter rebuilt the correct order, which is why the bug was
// display-only.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

// Minimal WS double: OPEN from birth, answers initialize/session/load,
// HOLDS session/prompt open (the bridge replies only after the turn ends).
class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private prompts: number[] = [];

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    if (frame.method === "initialize") {
      this.reply(frame.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (frame.method === "session/load") {
      this.reply(frame.id, {});
    } else if (frame.method === "session/prompt") {
      this.prompts.push(frame.id as number);
    }
  }

  server(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  settlePrompt(): void {
    const id = this.prompts.shift();
    if (id !== undefined) this.reply(id, {});
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
  // Stop the 4s discovery poll so the worker can exit.
  void import("../src/store/appStore").then((m) =>
    m.useAppStore.getState().forgetHub(),
  );
});

test("queued follow-up bubble must land AFTER the running turn's content", async () => {
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;

  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  // The picker's tap path: connect the instance, auto-attach its newest session.
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  await vi.waitFor(() =>
    expect(store.getState().activeSessionId).toBe("sess_1"),
  );

  // Turn A in flight (response held by the fake bridge).
  void store.getState().sendPrompt("A", []);
  await vi.waitFor(() => expect(store.getState().isRunning).toBe(true));

  // Queue B while the turn runs.
  void store.getState().sendPrompt("B", []);
  expect(store.getState().pendingPrompts["sess_1"]?.[0]?.text).toBe("B");

  const ws = FakeWebSocket.current!;
  // One wire burst — the bridge emits chunks, the turn-end notify, then the
  // prompt response back-to-back, all inside the store's 120ms batch window.
  const chunk = (text: string) =>
    ws.server({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  chunk("HEAD-OF-TURN-A");
  chunk("TAIL-OF-TURN-A");
  ws.server({
    jsonrpc: "2.0",
    method: "$/zcode/turnState",
    params: { sessionId: "sess_1", running: false },
  });
  ws.settlePrompt(); // A settles -> finally flushes the queue -> B is sent

  // Let a (broken) coalescing timer fire, then freeze B's turn.
  await new Promise((r) => setTimeout(r, 250));
  ws.settlePrompt();

  const msgs = store.getState().messages;
  const textOf = (m: (typeof msgs)[number]) => JSON.stringify(m.parts);
  const userA = msgs.findIndex(
    (m) => m.role === "user" && textOf(m).includes('"A"'),
  );
  const userB = msgs.findIndex(
    (m) => m.role === "user" && textOf(m).includes('"B"'),
  );
  const headA = msgs.findIndex(
    (m) => m.role === "assistant" && textOf(m).includes("HEAD-OF-TURN-A"),
  );
  const tailA = msgs.findIndex(
    (m) => m.role === "assistant" && textOf(m).includes("TAIL-OF-TURN-A"),
  );

  // B must be its own message (not merged into A's bubble), and it must come
  // after ALL of turn A's content.
  expect(userA).toBe(0);
  expect(userB).toBeGreaterThan(0);
  expect(headA).toBeGreaterThanOrEqual(0);
  expect(tailA).toBeGreaterThanOrEqual(0);
  expect(userB).toBeGreaterThan(headA);
  expect(userB).toBeGreaterThan(tailA);
});

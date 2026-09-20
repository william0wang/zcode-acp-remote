// @vitest-environment node
// Late page updates: session/load_earlier page notifications that arrive
// AFTER the response (collection window already closed) are still replay
// content, never live content — they must PREPEND, not fall into applyUpdate
// and land at the tail. The tail placement was the reported phone symptom:
// "conversation loads fine, then a bunch of earlier interactions appear at
// the end".
import { afterAll, beforeAll, expect, test, vi } from "vitest";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
}

type Mode = "ordered" | "response-first";

class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  // Drives the agentInfo version the app reads for pageMarkerCapable.
  static legacy = false;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  mode: Mode = "ordered";
  // Legacy "response-first": how long after the response the page's unmarked
  // frames land (the bridge dispatches replay fire-and-forget, so the
  // response can overtake them on the wire).
  holdDelayMs = 300;
  private held: (() => void)[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    if (frame.method === "initialize") {
      this.reply(frame.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: {
          name: "zcode-acp-server",
          version: FakeWebSocket.legacy ? "0.43.0" : "0.44.1",
        },
      });
    } else if (frame.method === "session/load") {
      this.tail();
      this.reply(frame.id, {
        sessionId: "sess_1",
        replayMeta: { cursor: "c_tail", hasMore: true, totalMessages: 10 },
      });
    } else if (frame.method === "session/load_earlier") {
      const page = this.page();
      const respond = () =>
        this.reply(frame.id, {
          replayMeta: { cursor: "c_page", hasMore: false, replayedMessages: 2 },
        });
      if (this.mode === "ordered") {
        for (const u of page) this.update(u);
        respond();
      } else {
        respond();
        this.held = page.map((u) => () => this.update(u));
        // Legacy bridges cannot mark the page, so the app must keep the
        // collection window open past the response for these frames.
        if (FakeWebSocket.legacy) {
          this.holdTimer = setTimeout(() => this.flushHeld(), this.holdDelayMs);
        }
      }
    }
  }

  // The older page: two exchanges (msg_a older than msg_b). Marked only on a
  // marker-capable bridge — a legacy one sends the page unmarked.
  private page() {
    const marked = (u: Record<string, unknown>) =>
      FakeWebSocket.legacy ? u : { ...u, _meta: { zcode: { earlierPage: true } } };
    return [
      marked({ sessionUpdate: "user_message_chunk", messageId: "msg_a", content: { type: "text", text: "old q " } }),
      marked({ sessionUpdate: "agent_message_chunk", messageId: "msg_a", content: { type: "text", text: "old a " } }),
      marked({ sessionUpdate: "user_message_chunk", messageId: "msg_b", content: { type: "text", text: "older q " } }),
      marked({ sessionUpdate: "agent_message_chunk", messageId: "msg_b", content: { type: "text", text: "older a " } }),
    ];
  }

  // The tail the phone loaded first: msg_x then msg_y (newest).
  private tail() {
    for (const [mid, role, text] of [
      ["msg_x", "user_message_chunk", "recent q "],
      ["msg_x", "agent_message_chunk", "recent a "],
      ["msg_y", "user_message_chunk", "latest q "],
      ["msg_y", "agent_message_chunk", "latest a "],
    ] as const) {
      this.update({ sessionUpdate: role, messageId: mid, content: { type: "text", text } });
    }
  }

  private update(u: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess_1", update: u },
      }),
    });
  }

  flushHeld(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    for (const f of this.held) f();
    this.held = [];
  }

  close(): void {
    this.readyState = 3;
  }

  private reply(id: number | undefined, result: unknown): void {
    if (id === undefined) return;
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
}

async function boot(legacy = false) {
  // Fresh module per test: the store holds module-level connection state and
  // the second connect cycle on a shared instance never re-reaches "open".
  vi.resetModules();
  FakeWebSocket.legacy = legacy;
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;
  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  await vi.waitFor(() =>
    expect(store.getState().messages.map((m) => m.id)).toEqual(["msg_x", "msg_y"]),
  );
  return store;
}

const ids = (store: { getState: () => { messages: { id: string }[] } }) =>
  store.getState().messages.map((m) => m.id);

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
  void import("../src/store/appStore").then((m) =>
    m.useAppStore.getState().disconnectHub(),
  );
});

test("ordered pages still work (notifications then response)", async () => {
  const store = await boot();
  const applied = await store.getState().loadEarlier();
  expect(applied).toBe(true);
  expect(ids(store)).toEqual(["msg_a", "msg_b", "msg_x", "msg_y"]);
});

test("late page updates prepend before the tail, never land at the end", async () => {
  const store = await boot();
  const ws = FakeWebSocket.current!;
  ws.mode = "response-first";
  const applied = await store.getState().loadEarlier();
  expect(applied).toBe(true);
  // Response-first: the page applied as empty (nothing collected in-window).
  expect(ids(store)).toEqual(["msg_x", "msg_y"]);

  // The page's marked updates arrive after the response — outside the
  // collection window. They must still PREPEND (older content, top), not
  // append after the newest messages.
  ws.flushHeld();
  await new Promise((r) => setTimeout(r, 400)); // past any coalescing timers
  expect(ids(store)).toEqual(["msg_a", "msg_b", "msg_x", "msg_y"]);
});

// Legacy bridges (< 0.44.1) send pages UNMARKED, and their load_earlier
// response can overtake the page's own notifications. Without a marker the
// app must keep collecting past the response until the burst settles —
// otherwise the whole page appends after the newest message, which is the
// reported symptom: a middle chunk of an old session landing at the end.
test("legacy bridge: unmarked page arriving after the response still prepends", async () => {
  const store = await boot(true);
  const ws = FakeWebSocket.current!;
  ws.mode = "response-first";
  const promise = store.getState().loadEarlier();
  // The response lands first; the page's frames follow 300ms later.
  await new Promise((r) => setTimeout(r, 60));
  await promise;
  // The settle window holds until the burst goes quiet, then prepends.
  expect(ids(store)).toEqual(["msg_a", "msg_b", "msg_x", "msg_y"]);
});

test("legacy bridge: ordered pages still prepend", async () => {
  const store = await boot(true);
  const applied = await store.getState().loadEarlier();
  expect(applied).toBe(true);
  expect(ids(store)).toEqual(["msg_a", "msg_b", "msg_x", "msg_y"]);
});

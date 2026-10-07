// @vitest-environment node
// Regression tests for the "stuck on 重连中 after wake" wedge.
//
// The bug: a phone waking from deep sleep can park fetch() on a socket that
// never delivers a byte. tryReconnect's first move is an await of exactly
// such a fetch, the reconnect timer that called it had already fired, and
// wakeProbe's "!reconnectTimer" belt-and-braces can't see a fired id — so
// the banner stuck on "reconnecting" until the user exited and re-entered
// from the list (connectInstance being the one path that resets the loop).
//
// The fix has two layers, each covered here: a header-level deadline on
// every hub fetch (turns the hang into a network error the loop already
// knows how to retry), and a watchdog that tears down any tryReconnect that
// outlives every legitimate budget (defense against future unbounded
// awaits the deadline cannot reach).
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { HubClient, HubApiError } from "../src/lib/hub";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
}

// Minimal WS double: OPEN from birth, answers initialize, records every
// sent frame, dies on demand. Everything else (session/load, $/zcode/ping)
// goes unanswered — an unanswered ping is exactly the zombie probe case.
class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Frame[] = [];

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame.method === "initialize") {
      this.reply(frame.id, { protocolVersion: 1, agentCapabilities: {} });
    }
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

// Discovery fetch behavior knobs. `hang` = never answers but honors the
// abort signal (what the 10s deadline converts into a network error);
// `zombie` = never answers and IGNORES the abort (the shape the watchdog
// exists for — any await that cannot be reached by a timeout).
let instancesHang = false;
let instancesZombie = false;
let probeCalls = 0;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const INSTANCE_LIST = [
  {
    id: "inst1",
    workspace: "/w",
    sessions: [{ sessionId: "sess_1", updatedAt: 1 }],
  },
];

beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => backing.set(k, String(v)),
    removeItem: (k: string) => backing.delete(k),
    clear: () => backing.clear(),
  };
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  (globalThis as Record<string, unknown>).fetch = (
    input: unknown,
    init?: { signal?: AbortSignal },
  ) => {
    const url = String(input);
    if (url.includes("/api/instances")) {
      if (url.includes("probe=1")) probeCalls++;
      if (instancesZombie) return new Promise<Response>(() => {});
      if (instancesHang)
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      return okJson(INSTANCE_LIST);
    }
    if (url.includes("/api/quota"))
      return okJson({
        glm: { kind: "unavailable" },
        opencode: { kind: "not_configured" },
      });
    return okJson({});
  };
});

afterEach(() => {
  vi.useRealTimers();
  instancesHang = false;
  instancesZombie = false;
});

afterAll(() => {
  // Stop the 4s discovery poll so the worker can exit.
  void import("../src/store/appStore").then((m) =>
    m.useAppStore.getState().disconnectHub(),
  );
});

async function freshSession() {
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;
  store.getState().disconnectHub();
  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  return store;
}

test("a hub fetch that never answers aborts into a network error", async () => {
  instancesHang = true;
  const client = new HubClient("http://hub", "t");
  vi.useFakeTimers();

  let rejected: HubApiError | null = null;
  const p = client.instances().then(
    () => null,
    (e: HubApiError) => {
      rejected = e;
      return e;
    },
  );
  // Still pending one tick before the deadline…
  await vi.advanceTimersByTimeAsync(9_999);
  expect(rejected).toBeNull();
  // …and settles as a network-level failure the moment it passes.
  await vi.advanceTimersByTimeAsync(1);
  await p;
  expect(rejected).toBeInstanceOf(HubApiError);
  expect(rejected!.network).toBe(true);
  expect(rejected!.message).toContain("no response within");
});

test("the reconnect loop survives a hung discovery fetch (the wake wedge)", async () => {
  const store = await freshSession();
  instancesHang = true;

  vi.useFakeTimers();
  FakeWebSocket.current!.die();
  await vi.advanceTimersByTimeAsync(1_000); // reconnect timer → tryReconnect → fetch hangs
  expect(store.getState().connState).toBe("reconnecting");
  // Pre-fix behavior: nothing else ever happens. Now the deadline fires…
  await vi.advanceTimersByTimeAsync(10_000);
  // …the abort becomes a network error, discovery keeps the stale list, and
  // the loop proceeds to a fresh connection attempt.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(store.getState().connState).toBe("open");
});

test("the watchdog tears down a tryReconnect wedged past every budget", async () => {
  const store = await freshSession();

  vi.useFakeTimers();
  instancesZombie = true;
  probeCalls = 0;
  FakeWebSocket.current!.die();
  await vi.advanceTimersByTimeAsync(1_000); // tryReconnect starts, await hangs
  expect(store.getState().connState).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(60_000); // far past fetch + WS deadlines
  // The wedge: the fired timer left no live retry, and the zombie await
  // ignores the fetch deadline. Exactly one probe call ever happened.
  expect(probeCalls).toBe(1);
  // The periodic probe (20s tick in the app; called directly here) sees an
  // attempt that outlived every legitimate budget and forces a teardown.
  store.getState().wakeProbe();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().connState).toBe("reconnecting");
  instancesZombie = false;
  await vi.advanceTimersByTimeAsync(1_000); // fresh-backoff retry fires
  expect(probeCalls).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(store.getState().connState).toBe("open");
});

test("streaming traffic suppresses the open-state liveness probe", async () => {
  const store = await freshSession();
  const ws = FakeWebSocket.current!;
  const sid = store.getState().activeSessionId!;

  // A live turn is streaming: wire activity proves the pipe.
  ws.server({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: sid,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_1",
        content: { type: "text", text: "still streaming " },
      },
    },
  });

  vi.useFakeTimers();
  store.getState().wakeProbe();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().connState).toBe("open");
  expect(ws.sent.filter((f) => f.method === "$/zcode/ping")).toHaveLength(0);

  // After 30s of silence the probe runs; an unanswered ping (5s budget)
  // tears the zombie down so the reconnect loop takes over.
  await vi.advanceTimersByTimeAsync(31_000);
  store.getState().wakeProbe();
  await vi.advanceTimersByTimeAsync(0);
  expect(ws.sent.filter((f) => f.method === "$/zcode/ping")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(store.getState().connState).toBe("reconnecting");
});

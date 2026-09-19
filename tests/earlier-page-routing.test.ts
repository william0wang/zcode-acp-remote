// @vitest-environment node
// Regression test: live-turn updates streaming while a session/load_earlier
// page request is in flight must APPEND, not ride the page's prepend. The
// bridge marks page updates `_meta.zcode.earlierPage: true` on the update
// (same placement as the tool-fold flags); only marked updates enter the
// earlier buffer.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

// Minimal WS double: OPEN from birth, answers initialize/session/load (with
// a pagination cursor), HOLDS session/load_earlier until the test settles it.
// The initialize answer advertises a marker-capable bridge (0.44.1) — the
// old-bridge fallback lives in tests/earlier-page-fallback.test.ts.
class FakeWebSocket {
  static OPEN = 1;
  static current: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Frame[] = [];
  private earlier: number[] = [];

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
      this.reply(frame.id, {
        replayMeta: { cursor: "c0", hasMore: true, totalMessages: 99 },
      });
    } else if (frame.method === "session/load_earlier") {
      this.earlier.push(frame.id as number);
    }
  }

  server(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  settleEarlier(result: unknown): void {
    const id = this.earlier.shift();
    if (id !== undefined) this.reply(id, result);
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
    m.useAppStore.getState().disconnectHub(),
  );
});

test("live updates during a page request append; only marked page updates prepend", async () => {
  const { useAppStore } = await import("../src/store/appStore");
  const store = useAppStore;

  store.getState().connectToHub({ hubUrl: "http://hub", token: "t" });
  await vi.waitFor(() => expect(store.getState().instances.length).toBe(1));
  void store.getState().connectInstance("inst1");
  await vi.waitFor(() => expect(store.getState().connState).toBe("open"));
  await vi.waitFor(() =>
    expect(store.getState().activeSessionId).toBe("sess_1"),
  );
  await vi.waitFor(() => expect(store.getState().hasMore).toBe(true));

  const ws = FakeWebSocket.current!;
  const chunk = (text: string, meta?: unknown) =>
    ws.server({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          messageId: `m_${text}`,
          ...(meta ? { _meta: meta } : {}),
        },
      },
    });

  // Seed one live message (applies normally, before any paging).
  chunk("SEED");
  await new Promise((r) => setTimeout(r, 250)); // flush the 120ms batch

  // Fire the page request; it stays in flight until settleEarlier.
  const applied = store.getState().loadEarlier();
  await vi.waitFor(() =>
    expect(
      ws.sent.some((f) => f.method === "session/load_earlier"),
    ).toBe(true),
  );

  // In flight: one MARKED page update + one UNMARKED live update. The live
  // one must NOT be captured into the page buffer (the pre-fix gate buffered
  // everything and prepended it on top of the running turn).
  chunk("OLD-PAGE", { zcode: { earlierPage: true } });
  chunk("LIVE-TAIL");

  ws.settleEarlier({ replayMeta: { cursor: "c1", hasMore: false } });
  await applied;
  await new Promise((r) => setTimeout(r, 250));

  const msgs = store.getState().messages;
  const idx = (needle: string) =>
    msgs.findIndex((m) => JSON.stringify(m.parts).includes(needle));
  expect(idx("OLD-PAGE")).toBeGreaterThanOrEqual(0);
  expect(idx("LIVE-TAIL")).toBeGreaterThanOrEqual(0);
  // The page lands on top; the live update stays at the bottom.
  expect(idx("OLD-PAGE")).toBeLessThan(idx("SEED"));
  expect(idx("LIVE-TAIL")).toBeGreaterThan(idx("SEED"));
});

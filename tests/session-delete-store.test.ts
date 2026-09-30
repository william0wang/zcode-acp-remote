// @vitest-environment node
// Store-side rules for deleteSession (server ADR-0031 tombstone): the POST
// names the instance + session, success resolves true with a confirmation
// notice, 409 (the conversation is still live somewhere) explains itself
// instead of surfacing a raw error, and any other failure resolves false
// carrying the wire message. Callers own their local row state.
import { beforeAll, beforeEach, expect, test } from "vitest";

let routes: Array<{ match: string; res: Response }> = [];

beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => backing.set(k, String(v)),
    removeItem: (k: string) => backing.delete(k),
    clear: () => backing.clear(),
  };
});

beforeEach(async () => {
  routes = [];
  (globalThis as Record<string, unknown>).fetch = async (
    input: unknown,
  ): Promise<Response> => {
    const url = String(input);
    // connectToHub's background polling — served outside the routes and the
    // request log, like the workflows-store harness.
    if (/\/api\/instances(\?|$)/.test(url) || url.includes("/api/quota")) {
      return Response.json([]);
    }
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`test bug: no scripted response for ${url}`);
    return hit.res;
  };
  const useAppStore = await store();
  useAppStore.getState().disconnectHub();
});

async function store() {
  const mod = await import("../src/store/appStore");
  return mod.useAppStore;
}

test("deleteSession POSTs the tombstone route and confirms", async () => {
  const useAppStore = await store();
  useAppStore.getState().connectToHub({ hubUrl: "http://hub/", token: "t" });
  routes.push({
    match: "/sessions/sessA/delete",
    res: Response.json({ ok: true, deleted: true }),
  });
  await expect(
    useAppStore.getState().deleteSession("i1", "sessA"),
  ).resolves.toBe(true);
  expect(useAppStore.getState().notice).toBe("notice.sessionDeleted");
});

test("a 409 — the conversation is still live — explains itself", async () => {
  const useAppStore = await store();
  useAppStore.getState().connectToHub({ hubUrl: "http://hub/", token: "t" });
  routes.push({
    match: "/sessions/sessLive/delete",
    res: new Response(
      JSON.stringify({ ok: false, error: "session is live on this bridge" }),
      { status: 409 },
    ),
  });
  await expect(
    useAppStore.getState().deleteSession("i1", "sessLive"),
  ).resolves.toBe(false);
  expect(useAppStore.getState().notice).toBe("notice.sessionDeleteLive");
});

test("other failures resolve false carrying the wire message", async () => {
  const useAppStore = await store();
  useAppStore.getState().connectToHub({ hubUrl: "http://hub/", token: "t" });
  routes.push({
    match: "/delete",
    res: new Response(
      JSON.stringify({ ok: false, error: "tasks index unavailable" }),
      { status: 503 },
    ),
  });
  await expect(
    useAppStore.getState().deleteSession("i1", "sessX"),
  ).resolves.toBe(false);
  expect(useAppStore.getState().notice).toBe(
    "delete session failed: tasks index unavailable",
  );
});

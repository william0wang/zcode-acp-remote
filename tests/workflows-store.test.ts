// @vitest-environment node
// Store-level rules for the dynamic-workflow screens (bridge 0.48.0, server
// ADR-0029): the scope guard on list reads, the launch memory a start must
// leave behind (the ONLY run→session join the app will ever have), the
// prefill contract with the composer, and the silent-degrade reads.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

let requested: Array<{ url: string; method: string; body?: unknown }> = [];
let routes: Array<{ match: string; res: FakeResponse }> = [];
let backing: Map<string, string> = new Map();

beforeAll(() => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => backing.set(k, String(v)),
    removeItem: (k: string) => backing.delete(k),
    clear: () => backing.clear(),
  };
});

function route(match: string, res: FakeResponse): void {
  routes = routes.filter((r) => r.match !== match);
  routes.push({ match, res });
}

beforeEach(async () => {
  requested = [];
  routes = [];
  backing = new Map();
  const useAppStore = await store();
  useAppStore.getState().disconnectHub();
  // The toast auto-clears on a 4s timer; a failure toast from the previous
  // test must not bleed into the next test's silence assertions.
  useAppStore.setState({ toast: null });
  (globalThis as Record<string, unknown>).fetch = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    const url = String(input);
    // connectToHub starts the background instance/quota polling. Serve it a
    // standing answer OUTSIDE the routes and the request log — the poll's
    // URLs contain "api/instances" and would otherwise win the longest-match
    // routing over the per-instance workflow calls under test.
    if (/\/api\/instances(\?|$)/.test(url) || url.includes("/api/quota")) {
      return Response.json([]) as unknown as Response;
    }
    requested.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const hit = routes
      .filter((r) => url.includes(r.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
    if (!hit) throw new Error(`test bug: no scripted response for ${url}`);
    return hit.res as unknown as Response;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body: unknown): FakeResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const refused = (status: number, body: unknown): FakeResponse => ({
  ok: false,
  status,
  json: async () => body,
});

const delayed = (res: FakeResponse, ms: number) => ({
  ok: res.ok,
  status: res.status,
  json: async () => {
    await new Promise((r) => setTimeout(r, ms));
    return (await res.json()) as unknown;
  },
});

async function store() {
  const mod = await import("../src/store/appStore");
  return mod.useAppStore;
}

async function connectedStore() {
  const useAppStore = await store();
  useAppStore.getState().connectToHub({ hubUrl: "http://hub/", token: "tok" });
  // The workflow routes are per-instance; without a bridge named they all
  // answer 409 from the hub's machine-level mount.
  useAppStore.setState({ instanceId: "1" });
  return useAppStore;
}

test("loadWorkflows stores the list for the scope asked", async () => {
  const useAppStore = await connectedStore();
  route(
    "settings/workflows",
    ok({ ok: true, workflows: [{ name: "deploy" }], invalid: [] }),
  );
  await useAppStore.getState().loadWorkflows("project");
  expect(useAppStore.getState().configWorkflows?.workflows).toEqual([
    { name: "deploy" },
  ]);
  expect(useAppStore.getState().configWorkflowScope).toBe("project");
});

test("a scope answer that lands after a newer ask is dropped, not painted", async () => {
  const useAppStore = await connectedStore();
  // Two taps, two in-flight reads: the slower (project) answer must not
  // repaint the list the user moved off of — same guard as the usage ranges.
  route(
    "settings/workflows?scope=project",
    delayed(ok({ ok: true, workflows: [{ name: "old" }], invalid: [] }), 20),
  );
  route(
    "settings/workflows?scope=global",
    ok({ ok: true, workflows: [{ name: "new" }], invalid: [] }),
  );
  const first = useAppStore.getState().loadWorkflows("project");
  await useAppStore.getState().loadWorkflows("global");
  await first;
  expect(useAppStore.getState().configWorkflows?.workflows).toEqual([
    { name: "new" },
  ]);
});

test("the gate verdict comes from the per-instance snapshot, not the machine-level one", async () => {
  const useAppStore = await connectedStore();
  // The machine-level /settings/all (what the entry list loads) reports no
  // `enabled` field at all — its mount has no backend. The probe must name
  // the instance, or the workflows entry can never appear on any hub.
  route(
    "/settings/all",
    ok({
      ok: true,
      workflow: { enabled: true, mode: "alwaysOn", source: "remote" },
    }),
  );
  await useAppStore.getState().loadWorkflowGate();
  expect(useAppStore.getState().configWorkflowGate).toEqual({
    enabled: true,
    mode: "alwaysOn",
    source: "remote",
  });
  const asked = requested.find((r) => r.url.includes("/settings/all"));
  expect(asked?.url).toContain("/api/instances/1/settings/all");
});

test("a refused gate probe leaves the entry hidden, not errored", async () => {
  const useAppStore = await connectedStore();
  route("/settings/all", refused(500, { ok: false, error: "boom" }));
  await useAppStore.getState().loadWorkflowGate();
  expect(useAppStore.getState().configWorkflowGate).toBeNull();
  expect(useAppStore.getState().configSupported).not.toBe(false);
  expect(useAppStore.getState().toast).toBeNull();
  // The 404 flavor — a hub re-learning its instances after a restart — must
  // not be read as "hub too old" either: that verdict would retire EVERY
  // config section on one transient answer, and reconnect does not revive it.
  route(
    "/settings/all",
    refused(404, { ok: false, error: "unknown instance" }),
  );
  await useAppStore.getState().loadWorkflowGate();
  expect(useAppStore.getState().configWorkflowGate).toBeNull();
  expect(useAppStore.getState().configSupported).toBeNull();
  expect(useAppStore.getState().toast).toBeNull();
});

test("a 404 on the workflows list is a retriable error, not 'unsupported'", async () => {
  const useAppStore = await connectedStore();
  route(
    "/settings/workflows",
    refused(404, { ok: false, error: "unknown instance" }),
  );
  await useAppStore.getState().loadWorkflows("project");
  const s = useAppStore.getState();
  expect(s.configSupported).toBeNull();
  expect(s.configError).toContain("unknown instance");
  expect(s.configLoading).toBe(false);
  expect(s.configWorkflows).toBeNull();
});

test("a start records the launch memory — the only run→session join there is", async () => {
  const useAppStore = await connectedStore();
  route(
    "/start",
    ok({ ok: true, acpSessionId: "acp-9", runId: "run-9", toolCallId: "tc" }),
  );
  const res = await useAppStore
    .getState()
    .startWorkflow({ scope: "project", name: "deploy", args: { env: "prod" } });
  expect(res?.acpSessionId).toBe("acp-9");
  const { lookupLaunch } = await import("../src/lib/workflow-launches");
  expect(lookupLaunch("run-9")).toMatchObject({
    acpSessionId: "acp-9",
    instanceId: "1",
    name: "deploy",
    scope: "project",
  });
  // The request carries the args — the only knob the launch has. (Found by
  // URL, not index: background polling shares the request log.)
  expect(requested.find((r) => r.url.includes("/start"))).toMatchObject({
    method: "POST",
    body: { args: { env: "prod" } },
  });
});

test("a refused start toasts the detail and leaves no launch memory", async () => {
  const useAppStore = await connectedStore();
  route(
    "/start",
    refused(422, {
      ok: false,
      error: "compile_failed",
      message: "line 3: unexpected token",
    }),
  );
  const res = await useAppStore
    .getState()
    .startWorkflow({ scope: "project", name: "broken" });
  expect(res).toBeNull();
  expect(useAppStore.getState().toast?.text).toContain(
    "line 3: unexpected token",
  );
  // No runId ever came back, so the honest assertion is on the storage the
  // refused start must NOT have written (launch memory is post-success only).
  expect(backing.has("zcode.workflowLaunches")).toBe(false);
});

test("composer prefill is nonce-keyed so the same text re-triggers", async () => {
  const useAppStore = await store();
  useAppStore.getState().setComposerPrefill("Help me design…");
  const first = useAppStore.getState().composerPrefill;
  useAppStore.getState().setComposerPrefill("Help me design…");
  const second = useAppStore.getState().composerPrefill;
  expect(first?.text).toBe("Help me design…");
  expect(second?.text).toBe("Help me design…");
  expect(second?.nonce).not.toBe(first?.nonce);
  useAppStore.getState().clearComposerPrefill();
  expect(useAppStore.getState().composerPrefill).toBeNull();
});

test("loadRunSummaries degrades silently for sessions the bridge forgot", async () => {
  const useAppStore = await connectedStore();
  route(
    "settings/workflow-runs?sessionId=dead",
    refused(404, { ok: false, error: "unknown_session" }),
  );
  route(
    "settings/workflow-runs?sessionId=live",
    ok({ ok: true, runs: [{ runId: "r", resumable: true }] }),
  );
  const out = await useAppStore.getState().loadRunSummaries(["dead", "live"]);
  expect(out["dead"]).toBeUndefined();
  expect(out["live"]?.[0]).toMatchObject({ runId: "r", resumable: true });
  // Silent by design: no toast for the forgotten session.
  expect(useAppStore.getState().toast).toBeNull();
});

test("workflowAction without an instance reports and resolves null", async () => {
  const useAppStore = await store();
  useAppStore.getState().connectToHub({ hubUrl: "http://hub/", token: "tok" });
  expect(useAppStore.getState().instanceId).toBeNull();
  const res = await useAppStore
    .getState()
    .workflowAction("start workflow", () => Promise.resolve({ ok: true }));
  expect(res).toBeNull();
  expect(useAppStore.getState().toast?.text).toContain("not connected");
  expect(requested).toHaveLength(0);
});

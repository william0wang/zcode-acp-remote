// @vitest-environment node
// REST-layer coverage for the ZCode configuration client (ADR-0009): the
// hub-level settings routes every screen reads, the write routes and their
// method/URL spelling, and the two contracts that are easy to get wrong —
// the reset-card nonce travelling with a spend, and the backend restart
// naming an instance because the hub's own mount has no backend to restart.
import { beforeEach, expect, test } from "vitest";
import { HubClient } from "../src/lib/hub";

let responses: Response[] = [];
let requested: Array<{ url: string; method: string; body?: unknown }> = [];

function install(): void {
  (globalThis as Record<string, unknown>).fetch = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    requested.push({
      url: String(input),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error("test bug: no scripted response left");
    return next;
  };
}

beforeEach(() => {
  responses = [];
  requested = [];
  install();
});

const client = () => new HubClient("http://hub/", "tok");

test("settingsAll reads the machine-level mount, not an instance", async () => {
  responses.push(Response.json({ ok: true, models: {}, skills: [] }));
  await client().settingsAll();
  expect(requested[0]!.url).toBe("http://hub/api/settings/all");
});

test("section reads hit their own routes with the usage range encoded", async () => {
  responses.push(Response.json({ ok: true }));
  responses.push(Response.json({ ok: true }));
  responses.push(Response.json({ ok: true }));
  await client().settingsModels();
  await client().settingsSkills();
  await client().settingsUsage("30d");
  expect(requested.map((r) => r.url)).toEqual([
    "http://hub/api/settings/models",
    "http://hub/api/settings/skills",
    "http://hub/api/settings/usage?range=30d",
  ]);
});

test("writes use the verb the route expects (PUT for upsert, DELETE for remove)", async () => {
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  responses.push(Response.json({ ok: true, effect: "immediate" }));

  await client().upsertMcpServer("ctx7", { command: "npx" });
  await client().removeMcpServer("ctx7");
  await client().setSkillEnabled("/s/SKILL.md", false);

  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/mcp/ctx7",
    method: "PUT",
  });
  expect(requested[1]).toMatchObject({
    url: "http://hub/api/settings/mcp/ctx7",
    method: "DELETE",
  });
  expect(requested[2]).toMatchObject({
    url: "http://hub/api/settings/skills/enable",
    method: "POST",
  });
});

test("a skill path is encoded so slashes survive the route", async () => {
  responses.push(Response.json({ ok: true }));
  await client().deleteSkill("/home/u/.zcode/skills/x/SKILL.md");
  expect(requested[0]!.url).toBe(
    "http://hub/api/settings/skills/%2Fhome%2Fu%2F.zcode%2Fskills%2Fx%2FSKILL.md",
  );
});

test("a model upsert POSTs provider and model with only the set rule fields", async () => {
  responses.push(Response.json({ ok: true, effect: "immediate" }));
  await client().addModel({
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "glm-4.6",
    enabled: true,
    contextWindow: 200000,
    reasoningLevels: ["high", "low"],
  });
  // One route serves add AND edit (an upsert): the body names the model and
  // the rule fields that changed, nothing else.
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/models",
    method: "POST",
    body: {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "glm-4.6",
      enabled: true,
      contextWindow: 200000,
      reasoningLevels: ["high", "low"],
    },
  });
});

test("an agent upsert PUTs nulls verbatim — clearing rides on them", async () => {
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  // A personal-agent patch: `model: null` means "remove the key", so the body
  // must carry the null, not drop it.
  await client().upsertAgent("mine", { description: "d", model: null });
  // A built-in override clear: BOTH keys null together, or the server calls
  // the request malformed.
  await client().upsertAgent("general-purpose", {
    providerId: null,
    modelId: null,
  });
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/agents/mine",
    method: "PUT",
    body: { description: "d", model: null },
  });
  expect(requested[1]).toMatchObject({
    url: "http://hub/api/settings/agents/general-purpose",
    method: "PUT",
    body: { providerId: null, modelId: null },
  });
});

test("a hook edit carries all three coordinates — two in the path, one in the body", async () => {
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  await client().updateHook("PostToolUse", 2, 1, { command: "echo hi" });
  // The route only takes two path segments, so the hook's index inside its
  // matcher group travels in the body. Sending `{event}/{index}` alone is a
  // 400 — and it is exactly the shape a reader would guess.
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/hooks/PostToolUse/2",
    method: "PUT",
    body: { command: "echo hi", hookIndex: 1 },
  });
});

test("the MCP enable route wants `enabled`, not `enable`", async () => {
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  await client().setMcpEnabled("ctx7", false);
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/mcp/enable",
    method: "POST",
    body: { name: "ctx7", enabled: false },
  });
});

test("a reset-card spend carries the nonce from the status read", async () => {
  responses.push(
    Response.json({
      ok: true,
      resetCards: {
        availableFiveHour: [{ expireAt: 1700000000000 }],
        availableWeek: [],
        latestFiveHour: null,
        latestWeek: null,
        hasUnreadHistory: false,
        nonce: "n-1",
      },
    }),
  );
  const status = await client().resetCardStatus(
    "account:bigmodel-individual-coding-plan",
  );
  expect(requested[0]!.url).toBe(
    "http://hub/api/settings/reset-cards?providerId=account%3Abigmodel-individual-coding-plan",
  );

  responses.push(Response.json({ ok: true, used: true }));
  await client().spendResetCard({
    providerId: "account:bigmodel-individual-coding-plan",
    resetType: "FIVE_HOUR",
    nonce: status.resetCards.nonce,
    idempotencyKey: "k-1",
  });
  expect(requested[1]).toMatchObject({
    url: "http://hub/api/settings/reset-cards/use",
    method: "POST",
    body: {
      nonce: "n-1",
      idempotencyKey: "k-1",
      resetType: "FIVE_HOUR",
    },
  });
});

test("a denied opportunity is data, not a throw", async () => {
  responses.push(
    Response.json({
      ok: true,
      opportunity: { granted: false, nextTryAt: 1700000000000 },
    }),
  );
  await expect(
    client().requestResetOpportunity({
      providerId: "account:bigmodel-individual-coding-plan",
      idempotencyKey: "k-1",
    }),
  ).resolves.toMatchObject({ opportunity: { granted: false } });
});

test("the backend restart names an instance — the hub mount has no backend", async () => {
  responses.push(Response.json({ cancelledTurns: 2 }));
  await expect(client().restartBackend("inst-1")).resolves.toEqual({
    cancelledTurns: 2,
  });
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/instances/inst-1/backend/restart",
    method: "POST",
  });
});

test("a backup restore sends the file and the backup path", async () => {
  responses.push(Response.json({ ok: true, effect: "needs-restart" }));
  await client().restoreBackup({
    file: "cliConfig",
    path: "/h/.zcode/cli/config.json.bak-20260922",
  });
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/backups/restore",
    method: "POST",
    body: {
      file: "cliConfig",
      path: "/h/.zcode/cli/config.json.bak-20260922",
    },
  });
});

test("an app-update install posts the version and artifact url", async () => {
  responses.push(
    Response.json({ ok: true, install: { stage: "downloading" } }),
  );
  await client().installAppUpdate({
    version: "3.14.2",
    url: "https://cdn/zcode.zip",
    channel: "stable",
  });
  expect(requested[0]).toMatchObject({
    url: "http://hub/api/settings/app-update/install",
    method: "POST",
    body: {
      version: "3.14.2",
      url: "https://cdn/zcode.zip",
      channel: "stable",
    },
  });
});

test("the install carries the channel the check was made with", async () => {
  // The install route re-reads the manifest for the channel it is TOLD and
  // refuses any version that is not the latest THERE (409 otherwise). A
  // preview user whose install defaulted to stable is refused a version the
  // check itself just offered — so the store fills the channel in.
  responses.push(Response.json({ ok: true }));
  await client().installAppUpdate({
    version: "3.14.3-preview.1",
    url: "https://cdn/zcode.zip",
    channel: "preview",
  });
  expect(requested[0]).toMatchObject({
    body: { version: "3.14.3-preview.1", channel: "preview" },
  });
});

test("the check reads the requested channel, not just stable", async () => {
  responses.push(Response.json({ ok: true }));
  await client().settingsAppUpdate("preview");
  expect(requested[0]!.url).toBe(
    "http://hub/api/settings/app-update?channel=preview",
  );
});

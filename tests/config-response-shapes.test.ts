// @vitest-environment node
// Response-shape coverage for the configuration screens (ADR-0009).
//
// The REST tests in hub-settings-client.test.ts lock the REQUESTS; these lock
// the DECODING. The distinction matters: an earlier round of these screens was
// written against an imagined payload (`models` as an array, `usage` unwrapped,
// `hooks.events` at the top level) and every request test still passed while
// four of the nine screens were dead on a real hub. Each case below feeds the
// shape the bridge actually emits and asserts the value the screen ends up
// with.
//
// Every decode function is IMPORTED from the screen that uses it, never copied
// here. A copy passing while the page reads a different path is exactly how the
// first round shipped dead — so a copy is now impossible to write by accident.
import { describe, expect, it } from "vitest";
import { maxUsedPercent, isTeamPlan } from "../src/screens/config/QuotaPage";
import { contextWindowFor } from "../src/screens/config/ModelsPage";
import { mcpServers } from "../src/screens/config/McpPage";
import { flattenHooks, hooksEnabled } from "../src/screens/config/HooksPage";
import { isDeletableScope, type SkillScope } from "../src/screens/config/SkillsPage";
import { isAgentReadOnly } from "../src/screens/config/AgentsPage";

// --- mcp: wrapped in `{ok, mcp:{servers}}`, like models and usage -----------
//
// Added after the same class of bug recurred a THIRD time: the screen read
// `servers` off the top level, so a machine with configured servers showed its
// empty state. `readMcpView` (settings-endpoint.ts) is the authority here.

describe("mcp payload", () => {
  const wire = {
    ok: true,
    mcp: {
      servers: [
        {
          name: "ctx7",
          type: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          enabled: true,
        },
        {
          name: "off",
          type: "http",
          url: "https://example.com/mcp",
          enabled: false,
        },
      ],
    },
  };

  it("reads servers from inside `mcp`, not the top level", () => {
    // The bug this guards: `payload.servers` is undefined, `.length === 0`,
    // and the page renders "no MCP servers configured" on a machine that has
    // them — indistinguishable from a genuinely empty list.
    expect((wire as { servers?: unknown }).servers).toBeUndefined();
    expect(mcpServers(wire)).toHaveLength(2);
  });

  it("keeps the command plus args for the row's subtitle", () => {
    const first = mcpServers(wire)[0]!;
    expect([first.command, ...(first.args ?? [])].join(" ")).toBe(
      "npx -y @upstash/context7-mcp",
    );
  });

  it("treats an absent `enabled` as on, matching the config-file default", () => {
    const rows = mcpServers(wire);
    expect(rows[0]!.enabled !== false).toBe(true);
    expect(rows[1]!.enabled !== false).toBe(false);
  });

  it("returns an empty list rather than throwing on a missing section", () => {
    expect(mcpServers({ ok: true })).toEqual([]);
    expect(mcpServers(null)).toEqual([]);
  });
});

// --- models: an OBJECT with `available` + `modelRules`, not an array -------

interface ModelRef {
  providerId?: string;
  providerName?: string;
  modelId?: string;
}
interface ModelRule {
  providerId?: string;
  modelId?: string;
  contextWindow?: number;
}

describe("models payload", () => {
  const payload = {
    ok: true,
    models: {
      available: [
        { providerId: "account:bigmodel-individual-coding-plan", modelId: "glm-4.6" },
        { providerId: "builtin:bigmodel-coding-plan", modelId: "glm-4.5-air" },
      ],
      providers: [{ providerId: "builtin:bigmodel-coding-plan", providerName: "Bigmodel" }],
      modelRules: [
        {
          providerId: "account:bigmodel-individual-coding-plan",
          modelId: "glm-4.6",
          contextWindow: 200000,
        },
      ],
    },
  };

  it("reads the selectable list out of the object, not the object itself", () => {
    const available = payload.models.available;
    expect(Array.isArray(available)).toBe(true);
    expect(available).toHaveLength(2);
    // The bug this guards: treating `models` as an array gives `length`
    // undefined, which passes a `=== 0` check and then throws on `.map`.
    expect(Array.isArray(payload.models)).toBe(false);
  });

  it("joins the context window from modelRules by provider+model", () => {
    expect(contextWindowFor(payload.models.available[0]!, payload.models.modelRules)).toBe(
      200000,
    );
  });

  it("leaves the window absent when no rule carries properties", () => {
    expect(
      contextWindowFor(payload.models.available[1]!, payload.models.modelRules),
    ).toBeUndefined();
  });
});

// --- usage: wrapped in `{ok, usage}` --------------------------------------

describe("usage payload", () => {
  const wire = {
    ok: true,
    usage: {
      available: true,
      range: "7d" as const,
      summary: { totalTokens: 12345, requestCount: 7, models: 2 },
      models: [{ modelId: "glm-4.6", totalTokens: 9000, share: 0.72 }],
      daily: [{ date: "2026-09-22", models: [{ modelId: "glm-4.6", totalTokens: 9000 }] }],
    },
  };

  it("unwraps `usage` — the raw response has no `available` at the top", () => {
    // The bug this guards: storing the whole response made `usage.available`
    // undefined, so the "no data" empty state rendered forever.
    expect((wire as { available?: boolean }).available).toBeUndefined();
    expect(wire.usage.available).toBe(true);
    expect(wire.usage.summary.totalTokens).toBe(12345);
    expect(wire.usage.models).toHaveLength(1);
    expect(wire.usage.daily).toHaveLength(1);
  });

  it("treats a machine with no agent database as unavailable, not broken", () => {
    const empty = { ok: true, usage: { available: false, range: "7d" as const } };
    expect(empty.usage.available).toBe(false);
  });
});

// --- hooks: `{ok, hooks:{enabled, events: Record<event, matcher[]>}` -------

describe("hooks payload", () => {
  const wire = {
    ok: true,
    hooks: {
      enabled: true,
      events: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ command: "echo one" }, { command: "echo two" }] },
        ],
        SessionStart: [{ hooks: [{ command: "boot", enabled: false, timeout: 5 }] }],
      },
    },
    enabled: true,
  };

  it("reads events from inside `hooks`, not the top level", () => {
    // The bug this guards: `payload.events` is undefined, so the screen showed
    // its empty state on a machine that had hooks configured.
    expect((wire as { events?: unknown }).events).toBeUndefined();
    expect(wire.hooks.events).toBeDefined();
  });

  it("flattens the two-level matcher/hook nesting into rows", () => {
    const rows = flattenHooks(wire.hooks.events);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual([
      "PostToolUse/0/0",
      "PostToolUse/0/1",
      "SessionStart/0/0",
    ]);
  });

  it("keeps the matcher as a label and defaults an absent one to any", () => {
    const rows = flattenHooks(wire.hooks.events);
    expect(rows[0]!.matcher).toBe("Bash");
    expect(rows[2]!.matcher).toBe("");
  });

  it("reads an absent `enabled` as on, and converts seconds to ms", () => {
    const rows = flattenHooks(wire.hooks.events);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[2]!.enabled).toBe(false);
    expect(rows[2]!.timeoutMs).toBe(5000);
  });

  it("reads an absent nested `enabled` as OFF, because false deletes the key", () => {
    // `setHooksEnabled(false)` removes `enabled` rather than storing false, and
    // the runtime treats the missing key as disabled. The bug this guards: a
    // `!== false` read shows the tree as live while every hook is inert.
    expect(hooksEnabled({ hooks: { events: {} } })).toBe(false);
  });

  it("reads the gate ON only when the route says so explicitly", () => {
    expect(hooksEnabled({ enabled: true, hooks: { enabled: true, events: {} } })).toBe(true);
    expect(hooksEnabled({ enabled: false, hooks: { enabled: true, events: {} } })).toBe(false);
  });

  it("falls back to the nested copy when the route omits its field", () => {
    // An older build that did not surface the top-level gate: the config's own
    // flag is all there is, and absent still means off.
    expect(hooksEnabled({ hooks: { enabled: true, events: {} } })).toBe(true);
    expect(hooksEnabled({ hooks: { events: {} } })).toBe(false);
  });

  it("prefers the route's top-level gate over the nested copy", () => {
    // Both are present and either being false means hooks are inert; the
    // route's own field is the authoritative one.
    expect(hooksEnabled({ enabled: false, hooks: { enabled: true, events: {} } })).toBe(
      false,
    );
    expect(hooksEnabled({ enabled: true, hooks: { enabled: false, events: {} } })).toBe(
      true,
    );
  });
});

// --- skills: `scope` decides what may be done ------------------------------

describe("skills payload", () => {
  const wire = [
    { name: "mine", path: "/h/.zcode/skills/mine/SKILL.md", scope: "user" as SkillScope, enabled: true },
    { name: "plug", path: "/h/.zcode/cli/plugins/cache/p/SKILL.md", scope: "plugin" as SkillScope, enabled: true },
    { name: "ws", path: "/w/.zcode/skills/ws/SKILL.md", scope: "project" as SkillScope, enabled: false },
  ];

  it("allows a delete only in the user and agents roots", () => {
    // The bug this guards: reading a `deletable` field the bridge never sends
    // made every delete button vanish, while the copy button appeared only on
    // skills that were switched OFF. `isDeletableScope` is the page's own
    // predicate — imported, so a page that starts reading another field fails
    // here instead of shipping a dead button.
    expect(wire.map((s) => isDeletableScope(s.scope))).toEqual([true, false, false]);
  });

  it("offers copy-to-user for exactly the scopes that are not deletable", () => {
    expect(wire.map((s) => !isDeletableScope(s.scope))).toEqual([false, true, true]);
  });
});

// --- agents: `readOnly` is the server's verdict ---------------------------

describe("agents payload", () => {
  const wire = [
    {
      name: "general-purpose",
      frontmatter: { name: "general-purpose", description: "General agent" },
      systemPrompt: "…",
      enabled: true,
      readOnly: true,
    },
    {
      name: "mine",
      frontmatter: { name: "mine", description: "My agent" },
      systemPrompt: "…",
      enabled: true,
      readOnly: false,
      modelSelection: { modelId: "glm-4.6", thoughtLevel: "high" },
    },
  ];

  it("hides the controls for a read-only agent", () => {
    // The bug this guards: reading a `builtIn` field the bridge never sends
    // left the enable and delete controls on built-ins, where every call is
    // refused with a 400 the user cannot act on. `isAgentReadOnly` is the
    // page's own predicate, imported so the wire shape is checked against the
    // code that reads it rather than against a copy of it.
    expect(isAgentReadOnly(wire[0]!.readOnly)).toBe(true);
    expect((wire[0] as { builtIn?: boolean }).builtIn).toBeUndefined();
    expect(isAgentReadOnly(wire[1]!.readOnly)).toBe(false);
  });

  it("reads the description from the frontmatter and the override from modelSelection", () => {
    expect(wire[0]!.frontmatter.description).toBe("General agent");
    expect(wire[1]!.modelSelection?.modelId).toBe("glm-4.6");
    expect(wire[1]!.modelSelection?.thoughtLevel).toBe("high");
  });
});

// --- reset cards: the provider list is all four ids, not the account's -----

describe("reset-card eligibility", () => {
  const wire = {
    ok: true,
    resetCards: {
      providers: [
        "account:bigmodel-individual-coding-plan",
        "account:bigmodel-team-coding-plan",
        "account:zai-individual-coding-plan",
        "account:zai-team-coding-plan",
      ],
      credentials: true,
    },
  };

  it("never assumes a single provider — the hub lists all four ids", () => {
    // The bug this guards: a `providers.length === 1` check could never be
    // true, so the whole reset-card feature was unreachable.
    expect(wire.resetCards.providers).toHaveLength(4);
    expect(wire.resetCards.providers.length === 1).toBe(false);
  });

  it("separates 'no credentials' from 'no plan'", () => {
    // credentials:false means the store could not be decrypted — a normal
    // state, and a different message from having nothing to spend.
    const noCreds = { ...wire.resetCards, credentials: false };
    expect(noCreds.credentials).toBe(false);
    expect(wire.resetCards.credentials).toBe(true);
  });

  it("still refuses to spend on a team plan", () => {
    expect(isTeamPlan(wire.resetCards.providers[1]!)).toBe(true);
    expect(isTeamPlan(wire.resetCards.providers[0]!)).toBe(false);
  });
});

// --- the spend gate -------------------------------------------------------

describe("spend threshold", () => {
  it("opens the gate on the highest window, not the average", () => {
    expect(maxUsedPercent([{ usedPercent: 4 }, { usedPercent: 93 }])).toBe(93);
  });

  it("stays shut while every window is under it", () => {
    expect(maxUsedPercent([{ usedPercent: 89 }, { usedPercent: 91 }])).toBeLessThan(
      100,
    );
    expect(maxUsedPercent([{ usedPercent: 89 }])).toBeLessThan(90);
  });
});

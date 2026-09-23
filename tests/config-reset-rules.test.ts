// @vitest-environment node
// The rules that guard the one irreversible action in the configuration API
// (ADR-0009): when a reset card may be offered, and which provider ids can
// own one. Kept as plain functions so the threshold and the team-plan block
// are testable without mounting the screen.
import { describe, expect, it } from "vitest";
import {
  CODING_PLAN_PROVIDERS,
  SPEND_THRESHOLD_PCT,
  isTeamPlan,
  maxUsedPercent,
  spendGatePercent,
} from "../src/screens/config/QuotaPage";

describe("reset-card spend gate", () => {
  it("offers a card once the highest window reaches the threshold", () => {
    expect(
      maxUsedPercent([
        { usedPercent: 42 },
        { usedPercent: SPEND_THRESHOLD_PCT },
        { usedPercent: 10 },
      ]),
    ).toBeGreaterThanOrEqual(SPEND_THRESHOLD_PCT);
  });

  it("refuses when every window is below it", () => {
    expect(maxUsedPercent([{ usedPercent: 89 }, { usedPercent: 12 }])).toBeLessThan(
      SPEND_THRESHOLD_PCT,
    );
  });

  it("treats one exhausted window as enough — not all of them", () => {
    // The gate is "any window", because one exhausted window is exactly when a
    // card helps. Requiring all of them would refuse the feature's own case.
    const items = [{ usedPercent: 100 }, { usedPercent: 3 }];
    expect(maxUsedPercent(items)).toBeGreaterThanOrEqual(SPEND_THRESHOLD_PCT);
  });

  it("reads an absent item list as zero, not as unlimited", () => {
    expect(maxUsedPercent(undefined)).toBe(0);
  });

  it("ignores the Opencode Go and Ollama windows", () => {
    // Those are not coding-plan windows; a card does nothing for them, so they
    // must not be able to open the gate. Asserted through `spendGatePercent` —
    // the selector the page itself calls — rather than through `maxUsedPercent`
    // with a pre-filtered list, which would pass no matter what the page reads.
    const usage = {
      glm: { items: [{ usedPercent: 20 }] },
      opencode: { kind: "success" as const, windows: [{ usagePercent: 100 }] },
    };
    expect(spendGatePercent(usage)).toBe(20);
    expect(spendGatePercent(usage)).toBeLessThan(SPEND_THRESHOLD_PCT);
  });

  it("reads an absent GLM branch as zero, not as unlimited", () => {
    expect(spendGatePercent(null)).toBe(0);
    expect(spendGatePercent({ glm: {} })).toBe(0);
  });
});

describe("provider eligibility", () => {
  it("knows the four coding-plan ids", () => {
    expect(CODING_PLAN_PROVIDERS).toEqual([
      "account:bigmodel-individual-coding-plan",
      "account:bigmodel-team-coding-plan",
      "account:zai-individual-coding-plan",
      "account:zai-team-coding-plan",
    ]);
  });

  it("blocks both team plans — a headless process cannot read their headers", () => {
    expect(isTeamPlan("account:bigmodel-team-coding-plan")).toBe(true);
    expect(isTeamPlan("account:zai-team-coding-plan")).toBe(true);
  });

  it("allows both individual plans", () => {
    expect(isTeamPlan("account:bigmodel-individual-coding-plan")).toBe(false);
    expect(isTeamPlan("account:zai-individual-coding-plan")).toBe(false);
  });

  it("does not mistake a builtin provider for a plan", () => {
    expect(isTeamPlan("builtin:bigmodel-coding-plan")).toBe(false);
  });
});

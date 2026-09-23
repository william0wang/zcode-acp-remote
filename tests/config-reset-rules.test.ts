// @vitest-environment node
// The rules that guard the one irreversible action in the configuration API
// (ADR-0009): how many confirmations a reset-card spend needs, and which
// provider ids can own one. Kept as plain functions so the threshold and the
// team-plan block are testable without mounting the screen.
import { describe, expect, it } from "vitest";
import {
  CODING_PLAN_PROVIDERS,
  SPEND_THRESHOLD_PCT,
  isTeamPlan,
  windowUsedPercent,
} from "../src/screens/config/QuotaPage";

describe("reset-card confirm threshold", () => {
  it("reads each card's OWN window, never the max across them", () => {
    // A card cannot clear a window it does not reset: an exhausted week must
    // not let a 5-hour card skip its warning, or the card is spent on a
    // window nowhere near its limit — exactly the mistake the warning is for.
    const usage = {
      glm: {
        items: [
          { key: "token_5h", usedPercent: 20 },
          { key: "token_week", usedPercent: 100 },
        ],
      },
    };
    expect(windowUsedPercent(usage, "FIVE_HOUR")).toBe(20);
    expect(windowUsedPercent(usage, "FIVE_HOUR")).toBeLessThan(
      SPEND_THRESHOLD_PCT,
    );
    expect(windowUsedPercent(usage, "WEEK")).toBe(100);
    expect(windowUsedPercent(usage, "WEEK")).toBeGreaterThanOrEqual(
      SPEND_THRESHOLD_PCT,
    );
  });

  it("skips the extra confirmation once the card's window reaches it", () => {
    const usage = {
      glm: { items: [{ key: "token_5h", usedPercent: SPEND_THRESHOLD_PCT }] },
    };
    expect(windowUsedPercent(usage, "FIVE_HOUR")).toBeGreaterThanOrEqual(
      SPEND_THRESHOLD_PCT,
    );
    // The boundary-1 case keeps the warning.
    const justBelow = {
      glm: {
        items: [{ key: "token_week", usedPercent: SPEND_THRESHOLD_PCT - 1 }],
      },
    };
    expect(windowUsedPercent(justBelow, "WEEK")).toBeLessThan(
      SPEND_THRESHOLD_PCT,
    );
  });

  it("reads a window the payload does not list as zero, not as unlimited", () => {
    // Unknown usage keeps the warning rather than skipping it.
    expect(windowUsedPercent(null, "WEEK")).toBe(0);
    expect(windowUsedPercent({ glm: {} }, "FIVE_HOUR")).toBe(0);
    // Only token windows count — the MCP limit is not a card window either.
    expect(
      windowUsedPercent(
        { glm: { items: [{ key: "mcp", usedPercent: 100 }] } },
        "WEEK",
      ),
    ).toBe(0);
  });

  it("ignores the Opencode Go and Ollama windows", () => {
    // Those are not coding-plan windows; a card does nothing for them, so they
    // must not be able to skip the warning. Asserted through
    // `windowUsedPercent` — the selector the page itself calls.
    const usage = {
      glm: { items: [{ key: "token_5h", usedPercent: 20 }] },
      opencode: { kind: "success" as const, windows: [{ usagePercent: 100 }] },
    };
    expect(windowUsedPercent(usage, "FIVE_HOUR")).toBe(20);
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

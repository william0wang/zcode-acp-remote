// Regression: the auto load-earlier trigger must be edge-fired and keyed to
// genuine user input. The old level-triggered check (scrollTop < 60) re-armed
// on PROGRAMMATIC scrolls — the prepend anchor-restore, the entry content
// swap — and one touch at the top cascaded 2+ page fetches (100 messages),
// re-running on every session re-entry.
import { describe, expect, it } from "vitest";

import { shouldAutoExpand } from "../src/chat/autoExpand";

const user = { atTop: true, wasAtTop: false, sinceInputMs: 100, expanding: false };

describe("shouldAutoExpand", () => {
  it("fires once on a user-driven edge entry into the top zone", () => {
    expect(shouldAutoExpand(user)).toBe(true);
  });

  it("never fires without recent user input (programmatic scrolls)", () => {
    // The anchor-restore after a prepend, the entry content swap, and the
    // stick-to-bottom hook all move scrollTop without a user gesture.
    expect(shouldAutoExpand({ ...user, sinceInputMs: 5_000 })).toBe(false);
    expect(shouldAutoExpand({ ...user, sinceInputMs: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("is edge-fired: holding or re-landing in the top zone does not refire", () => {
    // Scroll events keep arriving while parked at the top (anchor-restore
    // clamped low, async mount growing the content) — wasAtTop stays true.
    expect(shouldAutoExpand({ ...user, wasAtTop: true })).toBe(false);
  });

  it("does not fire while a page fetch is in flight", () => {
    expect(shouldAutoExpand({ ...user, expanding: true })).toBe(false);
  });

  it("does not fire outside the top zone", () => {
    expect(shouldAutoExpand({ ...user, atTop: false })).toBe(false);
  });

  it("re-arms only after leaving the top zone (edge semantics)", () => {
    // User drags to top -> fire; parks -> no fire; scrolls back down past
    // the threshold; drags up again -> fire again (next page, one per drag).
    const seq: Array<[boolean, boolean]> = [
      [true, false], // edge in: fire
      [true, true], // parked: hold
      [true, true], // anchor-restore clamp: still holding
      [false, true], // scrolled down: edge resets
      [true, false], // edge in again: fire
    ];
    const fired = seq.map(([atTop, wasAtTop]) =>
      shouldAutoExpand({ atTop, wasAtTop, sinceInputMs: 100, expanding: false }),
    );
    expect(fired).toEqual([true, false, false, false, true]);
  });
});

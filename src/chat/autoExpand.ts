// Decision logic for the chat viewport's auto load-earlier trigger, extracted
// as a pure function for tests.
//
// A page fetch must fire ONLY on a genuine user drag into the top zone —
// never on programmatic scrolls. The prepend anchor-restore (and the entry
// content swap, and the stick-to-bottom hook) all move scrollTop and fire
// scroll events; level-triggering on "scrollTop < threshold" re-armed on
// those and cascaded 2+ page fetches per touch (and on every session entry).

/** Max age of the last genuine input for a scroll to count as user-driven. */
export const AUTO_EXPAND_INPUT_WINDOW_MS = 600;

/** scrollTop below this counts as the top zone. */
export const AUTO_EXPAND_TOP_PX = 60;

export type AutoExpandInputs = {
  /** Viewport is in the top zone (scrollTop < AUTO_EXPAND_TOP_PX, overflow). */
  atTop: boolean;
  /** The previous scroll event's top-zone state — the trigger is edge-fired. */
  wasAtTop: boolean;
  /** Ms since the last genuine user input (pointer/wheel/touch/keyboard) on
   *  the viewport; Infinity when there was none. */
  sinceInputMs: number;
  /** An expansion is already in flight. */
  expanding: boolean;
};

/**
 * Fire an auto page-fetch only when ALL hold: a fresh EDGE entry into the
 * top zone, driven by recent user input, with no fetch in flight. Holding
 * the top zone (or being parked there by the anchor-restore) never refires.
 */
export function shouldAutoExpand(i: AutoExpandInputs): boolean {
  if (i.expanding) return false;
  if (!i.atTop || i.wasAtTop) return false;
  return i.sinceInputMs <= AUTO_EXPAND_INPUT_WINDOW_MS;
}

// notify() toasts: ephemeral feedback rendered above every full-screen
// overlay by the global NoticeToast layer. The store-side contract under
// test: a toast appears immediately, auto-clears after its window, a newer
// toast replaces the old one AND resets the clear timer (no stale clear),
// and dismissToast clears immediately.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function bootStore() {
  const { useAppStore } = await import("../src/store/appStore");
  return useAppStore;
}

test("notify shows a toast immediately and auto-clears it", async () => {
  const store = await bootStore();
  expect(store.getState().toast).toBeNull();
  store.getState().notify("downloading x");
  expect(store.getState().toast?.text).toBe("downloading x");
  vi.advanceTimersByTime(3999);
  expect(store.getState().toast?.text).toBe("downloading x");
  vi.advanceTimersByTime(1);
  expect(store.getState().toast).toBeNull();
});

test("a newer toast replaces the older one and survives its timer", async () => {
  const store = await bootStore();
  store.getState().notify("first");
  vi.advanceTimersByTime(3000);
  store.getState().notify("second");
  expect(store.getState().toast?.text).toBe("second");
  // The first notify's timer fires 1000ms later — it must NOT clear the
  // newer toast (id guard), which clears only at its own 4000ms mark.
  vi.advanceTimersByTime(1000);
  expect(store.getState().toast?.text).toBe("second");
  vi.advanceTimersByTime(2999);
  expect(store.getState().toast?.text).toBe("second");
  vi.advanceTimersByTime(1);
  expect(store.getState().toast).toBeNull();
});

test("dismissToast clears immediately and cancels the timer", async () => {
  const store = await bootStore();
  store.getState().notify("hello");
  store.getState().dismissToast();
  expect(store.getState().toast).toBeNull();
  // No pending timer throws on a later tick.
  vi.advanceTimersByTime(10_000);
  expect(store.getState().toast).toBeNull();
});

// backNav: the LIFO handler stack the Android back gesture walks. Contract
// under test: later-registered handlers answer first (overlay order), a true
// return consumes the press and stops the walk, a false return passes it to
// the next handler, an empty stack falls through to the caller (App's
// double-back-to-exit), and the unregister function removes exactly its own
// handler. The stack is module state — every test removes what it added.
import { afterEach, expect, test } from "vitest";
import { addBackHandler, dispatchBack } from "../src/lib/backNav";

const cleanups: Array<() => void> = [];

function register(handler: () => boolean): () => boolean {
  const remove = addBackHandler(handler);
  cleanups.push(remove);
  return handler;
}

afterEach(() => {
  for (const remove of cleanups.splice(0)) remove();
});

test("later handlers answer first and a true return consumes", () => {
  const calls: string[] = [];
  register(() => {
    calls.push("a");
    return true;
  });
  register(() => {
    calls.push("b");
    return true;
  });
  expect(dispatchBack()).toBe(true);
  // "b" registered last, so it answers alone — "a" never runs.
  expect(calls).toEqual(["b"]);
});

test("a false return passes the press down the stack", () => {
  const calls: string[] = [];
  register(() => {
    calls.push("a");
    return false;
  });
  register(() => {
    calls.push("b");
    return false;
  });
  // Nobody consumes; every handler ran, bottom-last.
  expect(dispatchBack()).toBe(false);
  expect(calls).toEqual(["b", "a"]);
});

test("the walk stops at the first consuming handler after passes", () => {
  const calls: string[] = [];
  register(() => {
    calls.push("root");
    return true;
  });
  register(() => {
    calls.push("mid");
    return false;
  });
  register(() => {
    calls.push("top");
    return false;
  });
  expect(dispatchBack()).toBe(true);
  expect(calls).toEqual(["top", "mid", "root"]);
});

test("an empty stack falls through", () => {
  expect(dispatchBack()).toBe(false);
});

test("unregister removes exactly its own handler", () => {
  const remove = addBackHandler(() => true);
  remove();
  remove(); // idempotent
  expect(dispatchBack()).toBe(false);
});

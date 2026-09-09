// @vitest-environment node
// Persistence coverage for storage.ts: legacy draft migration, invalid-entry
// filtering, and the quota-exceeded fallback that strips images instead of
// losing the queue.
import { beforeEach, expect, test } from "vitest";
import {
  loadPending,
  loadProfile,
  savePending,
  saveProfile,
} from "../src/lib/storage";

const PENDING_KEY = "zcode-acp:pending";
const PROFILE_KEY = "zcode-acp:profile";

let backing: Map<string, string>;

function install(throwOn?: (v: string) => boolean): void {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOn?.(v)) throw new Error("quota exceeded");
      backing.set(k, String(v));
    },
    removeItem: (k: string) => void backing.delete(k),
    clear: () => void backing.clear(),
  };
}

beforeEach(() => {
  backing = new Map();
  install();
});

test("loadPending migrates legacy plain-string drafts to text-only PromptDrafts", () => {
  backing.set(PENDING_KEY, JSON.stringify({ sess_1: ["hello", "world"] }));
  expect(loadPending()).toEqual({
    sess_1: [
      { text: "hello", images: [] },
      { text: "world", images: [] },
    ],
  });
});

test("loadPending drops malformed entries and keys left empty by filtering", () => {
  backing.set(
    PENDING_KEY,
    JSON.stringify({
      sess_1: [
        { text: "ok", images: [] },
        { text: 42, images: [] }, // bad text
        { text: "no-images", images: "x" }, // bad images
        null,
      ],
      sess_2: [{ text: "img", images: [{ data: "d", mimeType: "image/png" }] }],
      sess_3: "not-an-array",
    }),
  );
  const map = loadPending();
  expect(Object.keys(map).sort()).toEqual(["sess_1", "sess_2"]);
  expect(map.sess_1).toEqual([{ text: "ok", images: [] }]);
});

test("loadPending survives corrupt JSON", () => {
  backing.set(PENDING_KEY, "{not json");
  expect(loadPending()).toEqual({});
});

test("savePending writes the map and drops the key once empty", () => {
  savePending({ sess_1: [{ text: "a", images: [] }] });
  expect(backing.get(PENDING_KEY)).toContain('"text":"a"');
  savePending({});
  expect(backing.has(PENDING_KEY)).toBe(false);
});

test("savePending strips images on quota failure instead of losing the queue", () => {
  install((v) => v.includes('"data":"IMG"'));
  savePending({
    sess_1: [{ text: "keep me", images: [{ data: "IMG", mimeType: "image/png" }] }],
  });
  expect(JSON.parse(backing.get(PENDING_KEY)!)).toEqual({
    sess_1: [{ text: "keep me", images: [] }],
  });
});

test("loadProfile returns only the connection fields and rejects garbage", () => {
  saveProfile({ hubUrl: "http://hub", token: "t" });
  expect(loadProfile()).toEqual({ hubUrl: "http://hub", token: "t" });

  backing.set(PROFILE_KEY, JSON.stringify({ hubUrl: "http://hub" }));
  expect(loadProfile()).toBeNull();

  backing.set(PROFILE_KEY, "{oops");
  expect(loadProfile()).toBeNull();
});

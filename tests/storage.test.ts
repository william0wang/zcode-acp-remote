// @vitest-environment node
// Persistence coverage for storage.ts: legacy draft migration, invalid-entry
// filtering, and the quota-exceeded fallback that strips images instead of
// losing the queue. Also the multi-server book: round-trip, garbage filtering,
// and the one-time legacy single-profile migration.
import { beforeEach, expect, test } from "vitest";
import {
  defaultServerName,
  loadPending,
  loadServerBook,
  newServerId,
  savePending,
  saveServerBook,
} from "../src/lib/storage";

const PENDING_KEY = "zcode-acp:pending";
const PROFILE_KEY = "zcode-acp:profile";
const SERVERS_KEY = "zcode-acp:servers";

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

test("saveServerBook/loadServerBook round-trips the book", () => {
  const book = {
    servers: [
      { id: "a", name: "home", hubUrl: "http://home", token: "t1" },
      { id: "b", name: "office", hubUrl: "http://office", token: "t2" },
    ],
    activeId: "b",
  };
  saveServerBook(book);
  expect(loadServerBook()).toEqual(book);
});

test("loadServerBook drops malformed entries and re-points a dangling activeId", () => {
  backing.set(
    SERVERS_KEY,
    JSON.stringify({
      servers: [
        { id: "a", name: "ok", hubUrl: "http://a", token: "t" },
        { id: "b" }, // missing fields
        "junk", // not an object
        { id: "", name: "x", hubUrl: "http://c", token: "t" }, // empty id
        { id: "d", name: "x", hubUrl: "", token: "t" }, // empty hubUrl
      ],
      activeId: "nope",
    }),
  );
  const book = loadServerBook();
  expect(book?.servers).toEqual([
    { id: "a", name: "ok", hubUrl: "http://a", token: "t" },
  ]);
  expect(book?.activeId).toBe("a");
});

test("loadServerBook returns null for corrupt JSON or an empty book", () => {
  backing.set(SERVERS_KEY, "{oops");
  expect(loadServerBook()).toBeNull();
  backing.set(SERVERS_KEY, JSON.stringify({ servers: [], activeId: null }));
  expect(loadServerBook()).toBeNull();
});

test("loadServerBook returns null with no key and no legacy profile", () => {
  expect(loadServerBook()).toBeNull();
});

test("legacy single profile migrates into a one-entry book; the old key is removed", () => {
  backing.set(
    PROFILE_KEY,
    JSON.stringify({ hubUrl: "http://hub.example.com:8912/", token: "secret" }),
  );
  const book = loadServerBook();
  expect(book?.servers).toHaveLength(1);
  const s = book!.servers[0];
  expect(s.hubUrl).toBe("http://hub.example.com:8912");
  expect(s.name).toBe("hub.example.com:8912");
  expect(s.token).toBe("secret");
  expect(book?.activeId).toBe(s.id);
  expect(backing.has(PROFILE_KEY)).toBe(false);
  expect(backing.has(SERVERS_KEY)).toBe(true);
});

test("legacy migration ignores a garbage profile and keeps it untouched", () => {
  backing.set(PROFILE_KEY, JSON.stringify({ hubUrl: "http://hub" }));
  expect(loadServerBook()).toBeNull();
  expect(backing.has(PROFILE_KEY)).toBe(true);
  expect(backing.has(SERVERS_KEY)).toBe(false);
});

test("defaultServerName falls back to the raw URL", () => {
  expect(defaultServerName("http://hub:1234")).toBe("hub:1234");
  expect(defaultServerName("not a url")).toBe("not a url");
});

test("newServerId yields unique non-empty ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newServerId()));
  expect(ids.size).toBe(50);
});

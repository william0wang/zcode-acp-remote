// @vitest-environment node
// REST-layer coverage for HubClient: payload validation, error mapping
// (401 / HTTP / network), verbatim cursor pagination, fs line-window
// parsing, and the transparent 404 retry after a bridge upgrade.
import { beforeEach, expect, test } from "vitest";
import { HubApiError, HubClient } from "../src/lib/hub";

let responses: Response[] = [];
let requested: string[] = [];

function install(): void {
  (globalThis as Record<string, unknown>).fetch = async (
    input: unknown,
  ): Promise<Response> => {
    const url = String(input);
    requested.push(url);
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

test("instances parses the payload and forwards the probe flag", async () => {
  responses.push(
    Response.json([{ id: "inst1", workspace: "/w", sessions: [] }]),
  );
  await expect(client().instances()).resolves.toHaveLength(1);
  expect(requested[0]).toBe("http://hub/api/instances");

  responses.push(Response.json([]));
  await client().instances(true);
  expect(requested[1]).toBe("http://hub/api/instances?probe=1");
});

test("instances rejects a non-array payload", async () => {
  responses.push(Response.json({}));
  await expect(client().instances()).rejects.toThrow(
    "unexpected /api/instances payload",
  );
});

test("401 keeps its status; other HTTP errors surface as 'HTTP <code>'", async () => {
  responses.push(new Response("no", { status: 401 }));
  const err = await client().health().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HubApiError);
  expect(err).toMatchObject({ status: 401, message: "unauthorized: check token" });

  responses.push(new Response("boom", { status: 502 }));
  await expect(client().health()).rejects.toMatchObject({
    status: 502,
    message: "HTTP 502",
  });
});

test("fetch failures are marked network (expected hub-offline state)", async () => {
  (globalThis as Record<string, unknown>).fetch = async () => {
    throw new TypeError("dispatch error");
  };
  const err = await client().health().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HubApiError);
  expect(err).toMatchObject({ network: true });
});

test("projectSessions passes the composite cursor verbatim", async () => {
  responses.push(Response.json({ sessions: [], nextCursor: null }));
  await client().projectSessions("/my proj", { before: 1700000000, beforeId: "row9" });
  const url = new URL(requested[0]);
  expect(url.pathname).toBe("/api/projects/sessions");
  expect(url.searchParams.get("workspacePath")).toBe("/my proj");
  expect(url.searchParams.get("before")).toBe("1700000000");
  expect(url.searchParams.get("beforeId")).toBe("row9");
});

test("fsFileText trusts X-Zcode-First-Line and strips the trailing newline", async () => {
  responses.push(
    new Response("a\nb\nc\n", {
      headers: { "X-Zcode-First-Line": "7" },
    }),
  );
  await expect(client().fsFileText("inst", "sess", "/f.txt", 1, 3)).resolves.toEqual({
    firstLine: 7,
    text: "a\nb\nc",
  });
});

test("fsFileText falls back to the requested line without the header", async () => {
  responses.push(new Response("only\n"));
  await expect(client().fsFileText("inst", "sess", "/f.txt", 4, 1)).resolves.toEqual({
    firstLine: 4,
    text: "only",
  });
});

test("fsFileUrl embeds token + session in the query for <img src>", () => {
  const url = new URL(client().fsFileUrl("inst", "sess", "/a b.png"));
  expect(url.pathname).toBe("/api/instances/inst/fs/file");
  expect(url.searchParams.get("sessionId")).toBe("sess");
  expect(url.searchParams.get("path")).toBe("/a b.png");
  expect(url.searchParams.get("token")).toBe("tok");
});

test("a 404 right after a bridge upgrade is retried once transparently", async () => {
  responses.push(new Response("stale route", { status: 404 }));
  responses.push(Response.json({ entries: [] }));
  await expect(client().fsList("inst", "sess", "/")).resolves.toEqual({
    entries: [],
  });
  expect(requested).toHaveLength(2);
});

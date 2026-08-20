import type { FsListing, HubInstance } from "./types";

export class HubApiError extends Error {
  // `network` = the fetch itself failed (hub unreachable): the hub lives and
  // dies with the editor, so this is an expected "offline" state, not an error.
  constructor(
    message: string,
    readonly status?: number,
    readonly network = false,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

export class HubClient {
  constructor(
    private readonly hubUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return this.hubUrl.replace(/\/+$/, "") + path;
  }

  private async fetch(
    path: string,
    method: "GET" | "POST" = "GET",
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (e) {
      throw new HubApiError(
        `network error: ${(e as Error).message}`,
        undefined,
        true,
      );
    }
    if (res.status === 401)
      throw new HubApiError("unauthorized: check token", 401);
    if (!res.ok) throw new HubApiError(`HTTP ${res.status}`, res.status);
    return res;
  }

  // Body is plain text "ok".
  async health(): Promise<void> {
    await (await this.fetch("/api/health")).text();
  }

  /**
   * Fetch registered instances. With `probe` the hub TCP-probes each bridge
   * first and prunes unreachable ones (hard-killed bridges otherwise linger
   * for the 30s heartbeat TTL); use it where an immediately-honest list
   * matters — manual refresh, reconnect liveness checks.
   */
  async instances(probe = false): Promise<HubInstance[]> {
    const res = await this.fetch(`/api/instances${probe ? "?probe=1" : ""}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data))
      throw new HubApiError("unexpected /api/instances payload");
    return data as HubInstance[];
  }

  /**
   * Account quota (bridge 0.8.0, ADR-0005): same payload as the ACP
   * `account/usage_stats` method but no instance connection needed. The hub
   * caches ~30s server-side; 502 = upstream query failed (retry later).
   */
  async quota(): Promise<unknown> {
    const res = await this.fetch("/api/quota");
    return res.json();
  }

  /**
   * Retires a session from remote discovery (ADR-0006). Close, not delete —
   * backend store and editor storage are untouched; an editor-side-still-open
   * conversation self-heals back into discovery on its next use. Refused with
   * 409 while a turn is running.
   */
  async closeSession(instanceId: string, sessionId: string): Promise<void> {
    await this.fetch(
      `/api/instances/${instanceId}/sessions/${encodeURIComponent(sessionId)}/close`,
      "POST",
    );
  }

  /**
   * Session Files (ADR-0005). A 404 right after a bridge upgrade is the hub
   * self-learning the fs route — retried once transparently.
   */
  private async fetchFs(path: string): Promise<Response> {
    try {
      return await this.fetch(path);
    } catch (e) {
      if (e instanceof HubApiError && e.status === 404) {
        await new Promise((r) => setTimeout(r, 400));
        return await this.fetch(path);
      }
      throw e;
    }
  }

  /** One directory level; dotfiles included (filter client-side). */
  async fsList(
    instanceId: string,
    sessionId: string,
    path: string,
  ): Promise<FsListing> {
    const q = new URLSearchParams({ sessionId, path });
    const res = await this.fetchFs(`/api/instances/${instanceId}/fs/list?${q}`);
    return (await res.json()) as FsListing;
  }

  /**
   * Text line window (default 200, cap 5000). `firstLine` comes from the
   * X-Zcode-First-Line header — always trust it over the request's `line`.
   */
  async fsFileText(
    instanceId: string,
    sessionId: string,
    path: string,
    line: number,
    limit: number,
  ): Promise<{ firstLine: number; text: string }> {
    const q = new URLSearchParams({
      sessionId,
      path,
      line: String(line),
      limit: String(limit),
    });
    const res = await this.fetchFs(`/api/instances/${instanceId}/fs/file?${q}`);
    const firstLine = Number(res.headers.get("X-Zcode-First-Line")) || line;
    const raw = await res.text();
    // The line window always ends with a trailing "\n" (server emits
    // lines.join("\n") + "\n"); strip it so line counts and window stitching
    // in the viewer stay exact.
    return {
      firstLine,
      text: raw.endsWith("\n") ? raw.slice(0, -1) : raw,
    };
  }

  /**
   * Absolute fs/file URL with the token in the query string — for `<img src>`
   * and download links, which cannot carry an Authorization header.
   */
  fsFileUrl(instanceId: string, sessionId: string, path: string): string {
    const q = new URLSearchParams({ sessionId, path, token: this.token });
    return this.url(`/api/instances/${instanceId}/fs/file?${q}`);
  }
}

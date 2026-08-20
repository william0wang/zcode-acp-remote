import type { HubInstance } from "./types";

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

  private async fetch(path: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
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
}

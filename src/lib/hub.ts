import type { HubInstance } from "./types";

export class HubApiError extends Error {
  constructor(message: string, readonly status?: number) {
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
      throw new HubApiError(`network error: ${(e as Error).message}`);
    }
    if (res.status === 401) throw new HubApiError("unauthorized: check token", 401);
    if (!res.ok) throw new HubApiError(`HTTP ${res.status}`, res.status);
    return res;
  }

  // Body is plain text "ok".
  async health(): Promise<void> {
    await (await this.fetch("/api/health")).text();
  }

  async instances(): Promise<HubInstance[]> {
    const res = await this.fetch("/api/instances");
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new HubApiError("unexpected /api/instances payload");
    return data as HubInstance[];
  }
}

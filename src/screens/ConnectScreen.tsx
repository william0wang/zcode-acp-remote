import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HubClient } from "../lib/hub";
import { useAppStore } from "../store/appStore";

export function ConnectScreen() {
  const { t } = useTranslation();
  const connectToHub = useAppStore((s) => s.connectToHub);
  const [hubUrl, setHubUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const url = hubUrl.trim();
    const secret = token.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      setError(t("connect.invalidUrl"));
      return;
    }
    setTesting(true);
    try {
      const client = new HubClient(url, secret);
      await client.health();
      await client.instances();
      connectToHub({ hubUrl: url, token: secret });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold">ZCode ACP</h1>
        <p className="mt-2 text-center text-sm text-zinc-500">{t("connect.subtitle")}</p>

        <label className="mt-8 block text-xs font-medium text-zinc-400">
          {t("connect.hubUrl")}
        </label>
        <input
          value={hubUrl}
          onChange={(e) => setHubUrl(e.target.value)}
          placeholder="https://hub.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none"
        />

        <label className="mt-4 block text-xs font-medium text-zinc-400">
          {t("connect.token")}
        </label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none"
        />

        {error && (
          <p className="mt-4 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={testing || !hubUrl.trim() || !token.trim()}
          className="mt-6 w-full rounded-xl bg-blue-600 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {testing ? t("connect.testing") : t("connect.connect")}
        </button>
      </form>
    </div>
  );
}

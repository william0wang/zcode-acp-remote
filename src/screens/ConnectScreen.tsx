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
    <div className="flex h-full items-center justify-center bg-canvas px-6 text-ink">
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold tracking-tight">ZCode ACP</h1>
        <p className="mt-2 text-center text-sm text-faint">{t("connect.subtitle")}</p>

        <label className="mt-8 block text-xs font-medium text-dim">
          {t("connect.hubUrl")}
        </label>
        <input
          value={hubUrl}
          onChange={(e) => setHubUrl(e.target.value)}
          placeholder="https://hub.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          className="mt-1 w-full rounded-xl bg-raised px-4 py-3 text-sm text-ink ring-1 ring-inset ring-hairline placeholder:text-faint focus:ring-2 focus:ring-white/40 focus:outline-none"
        />

        <label className="mt-4 block text-xs font-medium text-dim">
          {t("connect.token")}
        </label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          className="mt-1 w-full rounded-xl bg-raised px-4 py-3 text-sm text-ink ring-1 ring-inset ring-hairline placeholder:text-faint focus:ring-2 focus:ring-white/40 focus:outline-none"
        />

        {error && (
          <p className="mt-4 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={testing || !hubUrl.trim() || !token.trim()}
          className="mt-6 w-full rounded-xl bg-white py-3 text-sm font-semibold text-black transition active:scale-[0.99] disabled:opacity-40"
        >
          {testing ? t("connect.testing") : t("connect.connect")}
        </button>
      </form>
    </div>
  );
}

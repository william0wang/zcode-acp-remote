import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus } from "lucide-react";
import { HubClient } from "../lib/hub";
import { useAppStore } from "../store/appStore";
import type { SavedServer } from "../lib/types";

const inputClass =
  "mt-1 w-full rounded-xl bg-raised px-4 py-3 text-sm text-ink ring-1 ring-inset ring-hairline placeholder:text-faint focus:ring-2 focus:ring-white/40 focus:outline-none";

// Add/edit form. ADDING keeps the original gate — health + discovery must
// answer before a new server is saved. EDITING saves in place (a down hub is
// fine; the offline banner + polling handle it) and only the ACTIVE server
// reconnects immediately, from the store side.
function ServerForm({
  server,
  onCancel,
}: {
  server: SavedServer | null;
  // Null on a fresh install (nothing to go back to): the cancel button hides.
  onCancel: (() => void) | null;
}) {
  const { t } = useTranslation();
  const connectToHub = useAppStore((s) => s.connectToHub);
  const saveServer = useAppStore((s) => s.saveServer);
  const deleteServer = useAppStore((s) => s.deleteServer);
  const [name, setName] = useState(server?.name ?? "");
  const [hubUrl, setHubUrl] = useState(server?.hubUrl ?? "");
  const [token, setToken] = useState(server?.token ?? "");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The confirm state is fleeting — a stray first tap must not linger armed.
  useEffect(() => {
    if (!confirmDelete) return;
    const id = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(id);
  }, [confirmDelete]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const url = hubUrl.trim().replace(/\/+$/, "");
    const secret = token.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error();
    } catch {
      setError(t("connect.invalidUrl"));
      return;
    }
    if (server) {
      saveServer({ ...server, name: name.trim(), hubUrl: url, token: secret });
      onCancel?.();
      return;
    }
    setTesting(true);
    try {
      const client = new HubClient(url, secret);
      await client.health();
      await client.instances();
      connectToHub({ hubUrl: url, token: secret, name: name.trim() });
      onCancel?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8">
      <h2 className="text-base font-semibold">
        {server ? t("connect.editServer") : t("connect.addServer")}
      </h2>

      <label className="mt-4 block text-xs font-medium text-dim">
        {t("connect.serverName")}
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("connect.namePlaceholder")}
        autoCapitalize="none"
        autoCorrect="off"
        className={inputClass}
      />

      <label className="mt-4 block text-xs font-medium text-dim">
        {t("connect.hubUrl")}
      </label>
      <input
        value={hubUrl}
        onChange={(e) => setHubUrl(e.target.value)}
        placeholder="https://hub.example.com"
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        className={inputClass}
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
        className={inputClass}
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
        {testing
          ? t("connect.testing")
          : server
            ? t("connect.saveServer")
            : t("connect.connect")}
      </button>

      {server && (
        <button
          type="button"
          onClick={() => {
            if (confirmDelete) {
              deleteServer(server.id);
              onCancel?.();
            } else setConfirmDelete(true);
          }}
          className={`mt-2 w-full rounded-xl px-3 py-2 text-xs font-medium transition ${
            confirmDelete
              ? "bg-red-500 text-white active:bg-red-600"
              : "bg-red-500/10 text-red-400 active:bg-red-500/20"
          }`}
        >
          {confirmDelete
            ? t("connect.deleteConfirm")
            : t("connect.deleteServer")}
        </button>
      )}

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-2 w-full rounded-xl px-3 py-2 text-xs font-medium text-dim active:bg-white/[0.06]"
        >
          {t("common.cancel")}
        </button>
      )}
    </form>
  );
}

// Server manager: lists every saved server (tap a row to switch, pencil to
// edit/delete) plus the add form. A fresh install lands directly on the add
// form — which is the original single-server connect screen.
export function ConnectScreen() {
  const { t } = useTranslation();
  const savedServers = useAppStore((s) => s.savedServers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const switchServer = useAppStore((s) => s.switchServer);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SavedServer | null>(null);

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };
  const freshInstall = savedServers.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-canvas px-6 text-ink">
      <div className="mx-auto w-full max-w-sm py-10">
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          ZCode ACP
        </h1>
        <p className="mt-2 text-center text-sm text-faint">
          {t("connect.subtitle")}
        </p>
        <p className="mt-1 text-center text-[11px] text-faint">
          v{__APP_VERSION__}
        </p>

        {adding || editing ? (
          <ServerForm
            key={editing?.id ?? "new"}
            server={editing}
            onCancel={freshInstall ? null : closeForm}
          />
        ) : freshInstall ? (
          <ServerForm server={null} onCancel={null} />
        ) : (
          <>
            <h3 className="mt-8 text-xs font-medium text-dim">
              {t("connect.savedServers")}
            </h3>
            <div className="mt-2 space-y-2">
              {savedServers.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center rounded-xl bg-raised ring-1 ring-inset ring-hairline"
                >
                  <button
                    onClick={() => switchServer(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-4 py-3 text-left active:bg-white/[0.05]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {s.name}
                      </span>
                      <span className="block truncate font-mono text-xs text-faint">
                        {s.hubUrl}
                      </span>
                    </span>
                    {s.id === activeServerId && (
                      <Check className="size-4 shrink-0 text-dim" />
                    )}
                  </button>
                  <button
                    onClick={() => setEditing(s)}
                    aria-label={t("connect.editServer")}
                    className="mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
                  >
                    <Pencil className="size-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setAdding(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-hairline px-3 py-2.5 text-xs font-medium text-dim active:bg-white/[0.05]"
            >
              <Plus className="size-4" />
              {t("connect.addServer")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

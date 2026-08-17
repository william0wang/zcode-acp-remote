import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../store/appStore";

function baseName(path: string | undefined): string {
  if (!path) return "?";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

// Entry screen = the same flat session list the left drawer shows: sessions
// across every bridge instance, newest first. Tapping one connects its
// instance and attaches in a single step. (Instance cards would only add a
// dead second hop for an attach-only client.)
export function InstancePicker() {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instancesError = useAppStore((s) => s.instancesError);
  const connState = useAppStore((s) => s.connState);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);
  const forgetHub = useAppStore((s) => s.forgetHub);

  const connecting = connState === "connecting";

  const sessions = instances
    .flatMap((i) =>
      (i.sessions ?? []).map((s) => ({
        ...s,
        instanceId: i.id,
        workspace: i.workspace,
      })),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex items-center gap-1 px-3 pb-2 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <h1 className="flex-1 text-lg font-semibold tracking-tight">{t("picker.title")}</h1>
        <button
          onClick={() => void refreshInstances({ probe: true })}
          aria-label={t("picker.refresh")}
          className="flex size-9 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <RefreshCw className="size-4.5" />
        </button>
        <button
          onClick={forgetHub}
          className="ml-1 rounded-full px-3 py-1.5 text-xs text-dim ring-1 ring-hairline active:bg-white/[0.06]"
        >
          {t("picker.changeServer")}
        </button>
      </header>

      {instancesError && (
        <p className="mx-4 mb-2 rounded-lg border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
          {instancesError}
        </p>
      )}
      {connecting && (
        <p className="mx-4 mb-2 rounded-lg bg-surface px-3 py-2 text-xs text-dim ring-1 ring-hairline">
          {t("picker.connecting")}
        </p>
      )}

      <div className="flex-1 overflow-y-auto pb-8">
        {sessions.length === 0 && !instancesError && (
          <p className="mt-16 text-center text-sm text-faint">{t("picker.empty")}</p>
        )}
        {sessions.map((s) => (
          <button
            key={`${s.instanceId}:${s.sessionId}`}
            disabled={connecting}
            onClick={() => void openSession(s.instanceId, s.sessionId)}
            className="flex w-full flex-col px-4 py-3 text-left active:bg-white/[0.05] disabled:opacity-50"
          >
            <span className="truncate text-sm text-dim">
              {s.title || t("chat.untitled")}
            </span>
            <span className="mt-0.5 truncate text-xs text-faint">
              {baseName(s.workspace)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../store/appStore";

function baseName(path: string | undefined): string {
  if (!path) return "?";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function InstancePicker() {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instancesError = useAppStore((s) => s.instancesError);
  const connState = useAppStore((s) => s.connState);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const connectInstance = useAppStore((s) => s.connectInstance);
  const forgetHub = useAppStore((s) => s.forgetHub);

  const connecting = connState === "connecting";

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

      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {instances.length === 0 && !instancesError && (
          <p className="mt-16 text-center text-sm text-faint">{t("picker.empty")}</p>
        )}
        {instances.map((inst) => (
          <button
            key={inst.id}
            disabled={connecting}
            onClick={() => void connectInstance(inst.id)}
            className="mb-3 w-full rounded-2xl bg-surface p-4 text-left ring-1 ring-hairline active:bg-white/[0.06] disabled:opacity-50"
          >
            <div className="flex items-center justify-between">
              <span className="truncate font-medium">{baseName(inst.workspace)}</span>
              <span className="ml-2 shrink-0 text-xs text-faint">pid {inst.pid}</span>
            </div>
            <div className="mt-1 truncate text-xs text-faint">{inst.workspace}</div>
            <div className="mt-2 text-xs text-dim">
              {t("picker.sessionCount", { count: inst.sessions?.length ?? 0 })}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

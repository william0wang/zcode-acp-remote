import { useTranslation } from "react-i18next";
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
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between px-4 pb-2 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <h1 className="text-lg font-semibold">{t("picker.title")}</h1>
        <div className="flex gap-2">
          <button
            onClick={() => void refreshInstances({ probe: true })}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
          >
            {t("picker.refresh")}
          </button>
          <button
            onClick={forgetHub}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
          >
            {t("picker.changeServer")}
          </button>
        </div>
      </header>

      {instancesError && (
        <p className="mx-4 mb-2 rounded-lg border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
          {instancesError}
        </p>
      )}
      {connecting && (
        <p className="mx-4 mb-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
          {t("picker.connecting")}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {instances.length === 0 && !instancesError && (
          <p className="mt-16 text-center text-sm text-zinc-500">{t("picker.empty")}</p>
        )}
        {instances.map((inst) => (
          <button
            key={inst.id}
            disabled={connecting}
            onClick={() => void connectInstance(inst.id)}
            className="mb-3 w-full rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-left active:bg-zinc-800 disabled:opacity-50"
          >
            <div className="flex items-center justify-between">
              <span className="truncate font-medium">{baseName(inst.workspace)}</span>
              <span className="ml-2 shrink-0 text-xs text-zinc-500">pid {inst.pid}</span>
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">{inst.workspace}</div>
            <div className="mt-2 text-xs text-zinc-400">
              {t("picker.sessionCount", { count: inst.sessions?.length ?? 0 })}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

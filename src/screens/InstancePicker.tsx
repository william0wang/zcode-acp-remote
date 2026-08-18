import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { SettingsPanel } from "../components/SidePanel";
import { SessionList } from "../components/SessionList";

// Entry screen = the same flat session list the left drawer shows: sessions
// across every bridge instance, newest first. Tapping one connects its
// instance and attaches in a single step.
export function InstancePicker() {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instancesError = useAppStore((s) => s.instancesError);
  const connState = useAppStore((s) => s.connState);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);
  const [panelOpen, setPanelOpen] = useState(false);

  const connecting = connState === "connecting";

  const sessions = useMemo(
    () =>
      instances
        .flatMap((i) =>
          (i.sessions ?? []).map((s) => ({
            ...s,
            instanceId: i.id,
            workspace: i.workspace,
          })),
        )
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [instances],
  );

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-[max(var(--safe-top),0.75rem)]">
        <h1 className="flex-1 text-lg font-semibold tracking-tight">{t("picker.title")}</h1>
        <button
          onClick={() => void refreshInstances({ probe: true })}
          aria-label={t("picker.refresh")}
          className="flex size-9 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <RefreshCw className="size-4.5" />
        </button>
        <button
          onClick={() => setPanelOpen(true)}
          aria-label={t("panel.title")}
          className="ml-1 flex size-9 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <SlidersHorizontal className="size-4.5" />
        </button>
      </header>

      {instancesError && (
        <p className="mx-4 mb-2 shrink-0 rounded-lg border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
          {instancesError}
        </p>
      )}
      {connecting && (
        <p className="mx-4 mb-2 shrink-0 rounded-lg bg-surface px-3 py-2 text-xs text-dim ring-1 ring-hairline">
          {t("picker.connecting")}
        </p>
      )}

      <SessionList
        sessions={sessions}
        activeKey={null}
        connecting={connecting}
        onSelect={(instanceId, sessionId) =>
          void openSession(instanceId, sessionId)
        }
        emptyHint={t("picker.empty")}
      />

      {panelOpen && <SettingsPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

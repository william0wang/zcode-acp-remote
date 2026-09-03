import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderPlus,
  History,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useAppStore } from "../store/appStore";
import { SettingsPanel } from "../components/SidePanel";
import { SessionList } from "../components/SessionList";
import { PermissionDialog } from "../components/PermissionDialog";
import { ElicitationDialog } from "../components/ElicitationDialog";
import { ProjectCreateDialog } from "../components/ProjectCreateDialog";
import { ProjectHistoryDialog } from "../components/ProjectHistoryDialog";

// Entry screen = the same flat session list the left drawer shows: sessions
// across every bridge instance, newest first. Tapping one connects its
// instance and attaches in a single step.
export function InstancePicker() {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instancesError = useAppStore((s) => s.instancesError);
  const hubOffline = useAppStore((s) => s.hubOffline);
  const connState = useAppStore((s) => s.connState);
  const notice = useAppStore((s) => s.notice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);
  const [panelOpen, setPanelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

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
        <h1 className="flex-1 text-lg font-semibold tracking-tight">
          {t("picker.title")}
        </h1>
        <button
          onClick={() => setHistoryOpen(true)}
          aria-label={t("historyDialog.title")}
          className="flex size-9 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <History className="size-4.5" />
        </button>
        <button
          onClick={() => setCreateOpen(true)}
          aria-label={t("projectDialog.title")}
          className="flex size-9 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <FolderPlus className="size-4.5" />
        </button>
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
      {hubOffline && (
        <p className="mx-4 mb-2 shrink-0 rounded-lg bg-surface px-3 py-2 text-xs text-faint ring-1 ring-hairline">
          {t("picker.hubOffline")}
        </p>
      )}
      {connecting && (
        <p className="mx-4 mb-2 shrink-0 rounded-lg bg-surface px-3 py-2 text-xs text-dim ring-1 ring-hairline">
          {t("picker.connecting")}
        </p>
      )}
      {connState === "reconnecting" && (
        <p className="mx-4 mb-2 shrink-0 rounded-lg bg-amber-950 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-900">
          {t("chat.reconnecting")}
        </p>
      )}
      {notice && (
        <div className="mx-4 mb-2 flex shrink-0 items-center justify-between gap-2 rounded-lg bg-white/[0.05] px-3 py-2 text-xs text-dim">
          <span className="truncate">
            {notice.startsWith("notice.") ? t(notice) : notice}
          </span>
          <button onClick={dismissNotice} className="shrink-0 text-faint">
            ✕
          </button>
        </div>
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
      {createOpen && (
        <ProjectCreateDialog onClose={() => setCreateOpen(false)} />
      )}
      {historyOpen && (
        <ProjectHistoryDialog onClose={() => setHistoryOpen(false)} />
      )}
      {/* The instance connection stays alive on this screen, but dialogs are
          per-session now: with no session open, nothing renders here — a
          request raised elsewhere waits behind its session's badge. */}
      <PermissionDialog />
      <ElicitationDialog />
    </div>
  );
}

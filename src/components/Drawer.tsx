import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { List, RefreshCw } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { SessionList } from "./SessionList";

// Left drawer = session switching only. Config, quota and language live in
// the right-side SidePanel so this list stays scannable.
export function Drawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);
  const closeSession = useAppStore((s) => s.closeSession);

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
    <div className="fixed inset-0 z-40 flex bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-80 max-w-[85%] flex-col overflow-hidden border-r border-hairline bg-surface pt-[max(var(--safe-top),0.75rem)] text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-1">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t("chat.sessions")}
          </h2>
          <button
            onClick={() => void refreshInstances({ probe: true })}
            aria-label={t("picker.refresh")}
            className="flex size-8 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
        <SessionList
          sessions={sessions}
          activeKey={
            instanceId && activeSessionId
              ? `${instanceId}:${activeSessionId}`
              : null
          }
          onSelect={(instId, sessId) => {
            onClose();
            void openSession(instId, sessId);
          }}
          emptyHint={t("chat.noSessions")}
        />

        {/* Full-screen list entry: leaving the session belongs here, not in
            the chat header. */}
        <button
          onClick={() => {
            onClose();
            closeSession();
          }}
          className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface px-4 py-3 text-left active:bg-white/[0.05]"
        >
          <List className="size-4 shrink-0 text-faint" />
          <span className="text-sm text-dim">{t("chat.backToSessions")}</span>
        </button>
      </aside>
    </div>
  );
}

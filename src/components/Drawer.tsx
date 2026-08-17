import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../store/appStore";

function baseName(path: string | undefined): string {
  if (!path) return "?";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

// Left drawer = session switching only. Config, quota and language live in
// the right-side SidePanel so this list stays scannable.
export function Drawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);

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
    <div className="fixed inset-0 z-40 flex bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-80 max-w-[85%] flex-col overflow-y-auto border-r border-hairline bg-surface pt-[max(var(--safe-top),0.75rem)] text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pb-1">
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
        {sessions.length === 0 && (
          <p className="px-4 py-2 text-xs text-faint">{t("chat.noSessions")}</p>
        )}
        {sessions.map((s) => {
          const active = s.instanceId === instanceId && s.sessionId === activeSessionId;
          return (
            <button
              key={`${s.instanceId}:${s.sessionId}`}
              onClick={() => {
                onClose();
                void openSession(s.instanceId, s.sessionId);
              }}
              className={`px-4 py-2.5 text-left ${active ? "bg-white/[0.07]" : "active:bg-white/[0.05]"}`}
            >
              <span
                className={`block truncate text-sm ${active ? "font-medium text-ink" : "text-dim"}`}
              >
                {s.title || t("chat.untitled")}
              </span>
              <span className="mt-0.5 block truncate text-xs text-faint">
                {baseName(s.workspace)}
              </span>
            </button>
          );
        })}
      </aside>
    </div>
  );
}

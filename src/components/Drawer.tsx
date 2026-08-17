import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/appStore";

function baseName(path: string | undefined): string {
  if (!path) return "?";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

// One flat list across every bridge instance: session title as the main line,
// workspace as the subtitle. Tapping a session on another instance switches
// the WS connection and attaches in one step.
export function Drawer({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openSession = useAppStore((s) => s.openSession);
  const setLang = useAppStore((s) => s.setLang);

  const sessions = instances
    .flatMap((i) =>
      (i.sessions ?? []).map((s) => ({
        ...s,
        instanceId: i.id,
        workspace: i.workspace,
      })),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  function switchLang(lang: "en" | "zh-CN") {
    setLang(lang);
    void i18n.changeLanguage(lang);
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-80 max-w-[85%] flex-col overflow-y-auto bg-zinc-950 pt-[max(env(safe-area-inset-top),0.75rem)] text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t("chat.sessions")}
        </h2>
        {sessions.length === 0 && (
          <p className="px-4 py-2 text-xs text-zinc-600">{t("chat.noSessions")}</p>
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
              className={`px-4 py-2.5 text-left ${
                active ? "bg-zinc-800" : "active:bg-zinc-900"
              }`}
            >
              <span
                className={`block truncate text-sm ${active ? "text-zinc-100" : "text-zinc-300"}`}
              >
                {s.title || t("chat.untitled")}
              </span>
              <span className="mt-0.5 block truncate text-xs text-zinc-500">
                {baseName(s.workspace)}
              </span>
            </button>
          );
        })}

        <div className="mt-auto flex gap-2 border-t border-zinc-800 p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
          <button
            onClick={() => switchLang("en")}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs ${
              i18n.language === "en" ? "border-blue-500 text-blue-400" : "border-zinc-700 text-zinc-400"
            }`}
          >
            English
          </button>
          <button
            onClick={() => switchLang("zh-CN")}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs ${
              i18n.language === "zh-CN" ? "border-blue-500 text-blue-400" : "border-zinc-700 text-zinc-400"
            }`}
          >
            中文
          </button>
        </div>
      </aside>
    </div>
  );
}

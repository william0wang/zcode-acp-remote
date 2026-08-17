import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatView } from "../chat/ChatView";
import { Drawer } from "../components/Drawer";
import { PermissionDialog } from "../components/PermissionDialog";
import { useAppStore } from "../store/appStore";

function baseName(path: string | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function ChatScreen() {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const instances = useAppStore((s) => s.instances);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const connState = useAppStore((s) => s.connState);
  const planText = useAppStore((s) => s.planText);
  const notice = useAppStore((s) => s.notice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);

  const instance = instances.find((i) => i.id === instanceId);
  const session = instance?.sessions?.find((s) => s.sessionId === activeSessionId);
  const workspace = baseName(instance?.workspace);
  const messages = useAppStore((s) => s.messages);

  // Discovery titles are often absent; fall back to the first user message
  // of the replayed history, then to the placeholder.
  let derived: string | null = null;
  for (const m of messages) {
    if (m.role !== "user") continue;
    const part = m.parts.find((p) => p.type === "text");
    if (part && part.type === "text" && part.text.trim()) {
      derived = part.text.trim();
      break;
    }
  }
  const title = session?.title || derived?.slice(0, 60) || t("chat.untitled");

  const statusDot =
    connState === "open"
      ? "bg-emerald-500"
      : connState === "reconnecting"
        ? "bg-amber-500 animate-pulse"
        : "bg-zinc-500";

  const noticeText = notice
    ? notice.startsWith("notice.")
      ? t(notice)
      : notice
    : null;

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-3 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="menu"
          className="flex size-9 items-center justify-center rounded-lg text-zinc-300 active:bg-zinc-800"
        >
          ☰
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          {workspace && (
            <div className="truncate text-[11px] text-zinc-500">{workspace}</div>
          )}
        </div>
        <span className={`size-2.5 shrink-0 rounded-full ${statusDot}`} aria-label={connState} />
      </header>

      {connState === "reconnecting" && (
        <div className="bg-amber-950 px-4 py-1.5 text-center text-xs text-amber-300">
          {t("chat.reconnecting")}
        </div>
      )}

      {noticeText && (
        <div className="flex items-center justify-between gap-2 bg-zinc-800 px-4 py-1.5 text-xs text-zinc-300">
          <span className="truncate">{noticeText}</span>
          <button onClick={dismissNotice} className="shrink-0 text-zinc-500">
            ✕
          </button>
        </div>
      )}

      {planText && (
        <details className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
          <summary className="cursor-pointer select-none text-zinc-300">
            {t("chat.plan")}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap font-sans">{planText}</pre>
        </details>
      )}

      <div className="min-h-0 flex-1">
        <ChatView />
      </div>

      {drawerOpen && <Drawer onClose={() => setDrawerOpen(false)} />}
      <PermissionDialog />
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { QuotaSection } from "./QuotaSection";

// Shared right slide-over frame. What goes inside depends on where it opens:
// global settings on the entry screen, session-scoped info in chat.
export function PanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-80 max-w-[85%] flex-col overflow-y-auto border-l border-hairline bg-surface pt-[max(var(--safe-top),0.75rem)] text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pb-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-8 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

// Global settings, shown OUTSIDE any session (entry screen): language, the
// destructive server reset, and the account quota card (connection-level
// data — the list screen keeps the instance WS alive, so it renders here
// too). Session-scoped controls live in SessionPanel.
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const profile = useAppStore((s) => s.profile);
  const forgetHub = useAppStore((s) => s.forgetHub);
  const setLang = useAppStore((s) => s.setLang);
  const [confirmForget, setConfirmForget] = useState(false);

  // The confirm state is fleeting — a stray first tap must not linger armed.
  useEffect(() => {
    if (!confirmForget) return;
    const id = setTimeout(() => setConfirmForget(false), 3000);
    return () => clearTimeout(id);
  }, [confirmForget]);

  function switchLang(lang: "en" | "zh-CN") {
    setLang(lang);
    void i18n.changeLanguage(lang);
  }

  return (
    <PanelShell title={t("panel.title")} onClose={onClose}>
      <div className="space-y-5 px-4 pb-[max(var(--safe-bottom),1rem)] pt-2">
        <div>
          <h3 className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
            {t("panel.language")}
          </h3>
          <div className="flex gap-2 rounded-xl bg-raised p-1">
            {(["en", "zh-CN"] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => switchLang(lang)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs transition ${
                  i18n.language === lang
                    ? "bg-white/[0.1] font-medium text-ink"
                    : "text-faint"
                }`}
              >
                {lang === "en" ? "English" : "中文"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
            {t("panel.server")}
          </h3>
          {profile && (
            <p className="truncate pb-1 font-mono text-xs text-faint">
              {profile.hubUrl}
            </p>
          )}
          <p className="pb-2 text-[11px] text-faint">
            {t("panel.changeServerHint")}
          </p>
          <button
            onClick={() =>
              confirmForget ? forgetHub() : setConfirmForget(true)
            }
            className={`w-full rounded-xl px-3 py-2 text-xs font-medium transition ${
              confirmForget
                ? "bg-red-500 text-white active:bg-red-600"
                : "bg-red-500/10 text-red-400 active:bg-red-500/20"
            }`}
          >
            {confirmForget
              ? t("panel.changeServerConfirm")
              : t("panel.changeServer")}
          </button>
        </div>
      </div>

      {/* Sibling, not inside the px-4 wrapper: rows carry their own padding
          and the section's top divider must span the full panel width. */}
      <QuotaSection />
    </PanelShell>
  );
}

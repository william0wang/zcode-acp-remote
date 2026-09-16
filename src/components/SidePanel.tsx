import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
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
// saved-server list (tap a row to switch instantly), the hub upgrade
// trigger, and the account quota card (connection-level data — the list
// screen keeps the instance WS alive, so it renders here too).
// Session-scoped controls live in SessionPanel.
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const savedServers = useAppStore((s) => s.savedServers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const switchServer = useAppStore((s) => s.switchServer);
  const openServerManager = useAppStore((s) => s.openServerManager);
  const setLang = useAppStore((s) => s.setLang);
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
  const upgradeHub = useAppStore((s) => s.upgradeHub);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradeNote, setUpgradeNote] = useState<string | null>(null);

  // Same for the upgrade result note.
  useEffect(() => {
    if (!upgradeNote) return;
    const id = setTimeout(() => setUpgradeNote(null), 5000);
    return () => clearTimeout(id);
  }, [upgradeNote]);

  // The hub alone decides whether to restart; this only triggers its check
  // and rides out the respawn (store polls health + refreshes discovery).
  async function checkHubUpgrade() {
    setUpgradeBusy(true);
    setUpgradeNote(null);
    try {
      const r = await upgradeHub();
      setUpgradeNote(
        r.restarting
          ? t("panel.upgradeRestarted", { version: r.diskVersion ?? "" })
          : t("panel.upgradeLatest", { version: r.runningVersion }),
      );
    } catch (e) {
      setUpgradeNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpgradeBusy(false);
    }
  }

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
            {t("panel.fontSize")}
          </h3>
          <div className="flex gap-2 rounded-xl bg-raised p-1">
            {(["small", "medium", "large"] as const).map((size) => (
              <button
                key={size}
                onClick={() => setFontSize(size)}
                className={`flex-1 rounded-lg px-3 py-1.5 transition ${
                  fontSize === size
                    ? "bg-white/[0.1] font-medium text-ink"
                    : "text-faint"
                }`}
              >
                {t(`panel.fontSize${size.charAt(0).toUpperCase() + size.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
            {t("panel.server")}
          </h3>
          <p className="pb-2 text-[11px] text-faint">
            {t("panel.serverHint")}
          </p>
          <div className="space-y-1">
            {savedServers.map((s) => {
              const active = s.id === activeServerId;
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    if (!active) switchServer(s.id);
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left ${
                    active ? "bg-white/[0.07]" : "active:bg-white/[0.05]"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${
                        active ? "font-medium text-ink" : "text-dim"
                      }`}
                    >
                      {s.name}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-faint">
                      {s.hubUrl}
                    </span>
                  </span>
                  {active && <Check className="size-4 shrink-0 text-dim" />}
                </button>
              );
            })}
          </div>
          <button
            onClick={openServerManager}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-raised px-3 py-2 text-xs font-medium text-dim active:bg-white/[0.07]"
          >
            <Pencil className="size-3.5" />
            {t("panel.manageServers")}
          </button>
          <button
            onClick={() => void checkHubUpgrade()}
            disabled={upgradeBusy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-raised px-3 py-2 text-xs font-medium text-dim active:bg-white/[0.07] disabled:opacity-60"
          >
            <RefreshCw
              className={`size-3.5 ${upgradeBusy ? "animate-spin" : ""}`}
            />
            {upgradeBusy ? t("panel.upgradeBusy") : t("panel.upgrade")}
          </button>
          {upgradeNote && (
            <p className="pt-1.5 text-center text-[11px] text-faint">
              {upgradeNote}
            </p>
          )}
        </div>
      </div>

      {/* Sibling, not inside the px-4 wrapper: rows carry their own padding
          and the section's top divider must span the full panel width. */}
      <QuotaSection />

      <p className="px-4 pb-[max(var(--safe-bottom),1rem)] pt-4 text-center text-[11px] text-faint">
        v{__APP_VERSION__}
      </p>
    </PanelShell>
  );
}

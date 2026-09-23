import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Bot,
  Box,
  ChartBar,
  ChevronRight,
  Download,
  Gauge,
  Package,
  Plug,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useAppStore, type ConfigSection } from "../store/appStore";
import { ConfigPageFrame } from "../components/config/ConfigPage";
import { ModelsPage } from "./config/ModelsPage";
import { SkillsPage } from "./config/SkillsPage";
import { McpPage } from "./config/McpPage";
import { HooksPage } from "./config/HooksPage";
import { AgentsPage } from "./config/AgentsPage";
import { QuotaPage } from "./config/QuotaPage";
import { UsagePage } from "./config/UsagePage";
import { BackupsPage } from "./config/BackupsPage";
import { AppUpdatePage } from "./config/AppUpdatePage";

// The independent configuration entry (ADR-0009): a full-screen list of the
// machine's ZCode configuration sections, each opening its own full-screen
// page. Reaches state that belongs to no session, so it works from the
// settings panel (inside a session) and from the instance picker alike.
export function ZCodeConfigScreen() {
  const { t } = useTranslation();
  const section = useAppStore((s) => s.configSection);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const openConfig = useAppStore((s) => s.openConfig);
  const closeConfig = useAppStore((s) => s.closeConfig);
  const loadConfigAll = useAppStore((s) => s.loadConfigAll);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);

  // The snapshot feeds the entry list's summaries (counts, whether the machine
  // has cards at all), so it loads once when the screen opens — not per row.
  useEffect(() => {
    if (supported === null) void loadConfigAll();
  }, [supported, loadConfigAll]);

  // A section page loads its own payload on mount; the snapshot alone would
  // compress the shapes these screens edit.
  useEffect(() => {
    if (section) void loadConfigSection(section);
    // loadConfigSection is a stable store action; section is the only input.
  }, [section, loadConfigSection]);

  if (section === "models") return <ModelsPage />;
  if (section === "skills") return <SkillsPage />;
  if (section === "mcp") return <McpPage />;
  if (section === "hooks") return <HooksPage />;
  if (section === "agents") return <AgentsPage />;
  if (section === "quota") return <QuotaPage />;
  if (section === "usage") return <UsagePage />;
  if (section === "backups") return <BackupsPage />;
  if (section === "appUpdate") return <AppUpdatePage />;

  const entries: Array<{
    id: ConfigSection;
    icon: typeof Box;
    title: string;
    hint: string;
  }> = [
    { id: "quota", icon: Gauge, title: t("zconfig.quota"), hint: t("zconfig.quotaHint") },
    { id: "models", icon: Box, title: t("zconfig.models"), hint: t("zconfig.modelsHint") },
    { id: "skills", icon: Sparkles, title: t("zconfig.skills"), hint: t("zconfig.skillsHint") },
    { id: "mcp", icon: Plug, title: t("zconfig.mcp"), hint: t("zconfig.mcpHint") },
    { id: "hooks", icon: Package, title: t("zconfig.hooks"), hint: t("zconfig.hooksHint") },
    { id: "agents", icon: Bot, title: t("zconfig.agents"), hint: t("zconfig.agentsHint") },
    { id: "usage", icon: ChartBar, title: t("zconfig.usage"), hint: t("zconfig.usageHint") },
    { id: "backups", icon: Archive, title: t("zconfig.backups"), hint: t("zconfig.backupsHint") },
    {
      id: "appUpdate",
      icon: Download,
      title: t("zconfig.appUpdate"),
      hint: t("zconfig.appUpdateHint"),
    },
  ];

  return (
    <ConfigPageFrame
      title={t("zconfig.title")}
      onBack={closeConfig}
      onRefresh={() => void loadConfigAll()}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
    >
      {/* The machine these screens configure, so a multi-hub user can tell
          which one they are about to change. */}
      <p className="px-4 pb-1 pt-1 text-[11px] text-faint">
        {t("zconfig.scope")}
      </p>
      <div className="mt-1">
        {entries.map(({ id, icon: Icon, title, hint }) => (
          <button
            key={id}
            onClick={() => openConfig(id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.05]"
          >
            <Icon className="size-4.5 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink">{title}</span>
              <span className="block truncate text-[11px] text-faint">{hint}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        ))}
      </div>

      {/* A needs-restart write landed somewhere in these screens and has not
          been applied yet — say so at the top level, where the user returns. */}
      <RestartNote />
    </ConfigPageFrame>
  );
}

/**
 * The restart affordance, shown only when there is something to apply.
 *
 * Restarting cancels in-flight turns, so it is never automatic: the user taps
 * it, and the button is absent (not disabled) when nothing is pending.
 *
 * The restart is per-instance — the hub's own settings mount has no backend —
 * so with no session attached there is no bridge to name and the affordance
 * says so instead of failing silently on tap.
 */
function RestartNote() {
  const { t } = useTranslation();
  const pendingRestart = useAppStore((s) => s.pendingRestart);
  const instanceId = useAppStore((s) => s.instanceId);
  const restartConfigBackend = useAppStore((s) => s.restartConfigBackend);
  if (!pendingRestart) return null;
  return (
    <div className="mx-4 mt-4 rounded-xl bg-surface px-4 py-3 ring-1 ring-hairline">
      <p className="text-xs text-dim">{t("zconfig.restartPending")}</p>
      <p className="pt-1 text-[11px] text-faint">
        {t("zconfig.restartWarning")}
      </p>
      {instanceId ? (
        <button
          onClick={() => void restartConfigBackend()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-medium text-ink active:bg-white/[0.12]"
        >
          <RefreshCw className="size-3.5" />
          {t("zconfig.restart")}
        </button>
      ) : (
        <p className="pt-2 text-[11px] text-amber-300">
          {t("zconfig.restartNoInstance")}
        </p>
      )}
    </div>
  );
}

// Re-exported so the mounting screens can name the type without reaching into
// the store module for it.
export type { ConfigSection };

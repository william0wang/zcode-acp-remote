import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Workflow } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { ConfigSheet } from "./ConfigSheet";
import { PanelShell } from "./SidePanel";
import { QuotaSection, SectionLabel } from "./QuotaSection";
import { bareModelIdFromConfigValue } from "../lib/modelValue";

// Session-scoped right panel shown in chat: config options (model / mode /
// thought) plus the shared account quota card. Global settings live in
// SettingsPanel.
export function SessionPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const configOptions = useAppStore((s) => s.configOptions);
  const usageStats = useAppStore((s) => s.usageStats);
  const quotaUnavailable = useAppStore((s) => s.quotaUnavailable);
  const workflowGate = useAppStore((s) => s.configWorkflowGate);
  const loadWorkflowGate = useAppStore((s) => s.loadWorkflowGate);
  const openConfig = useAppStore((s) => s.openConfig);
  const [configOpen, setConfigOpen] = useState<string | null>(null);

  // The workflows entry's visibility rides the per-instance gate verdict (the
  // same fail-closed rule the config screen applies), so the panel probes it
  // while it is still unknown.
  useEffect(() => {
    if (workflowGate === null) void loadWorkflowGate();
  }, [workflowGate, loadWorkflowGate]);

  const workflowEnabled = workflowGate?.enabled === true;

  return (
    <PanelShell title={t("panel.session")} onClose={onClose}>
      {/* Session-scoped config — meaningless until a session is attached. */}
      {activeSessionId != null && configOptions.length > 0 && (
        <>
          <SectionLabel title={t("config.title")} />
          {configOptions.map((opt) => {
            const current = opt.options?.find(
              (v) => v.value === opt.currentValue,
            );
            return (
              <button
                key={opt.id}
                onClick={() => setConfigOpen(opt.id)}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-left active:bg-white/[0.05]"
              >
                <span className="shrink-0 text-sm text-dim">
                  {t(`config.${opt.id}`, { defaultValue: opt.name ?? opt.id })}
                </span>
                <span className="truncate text-xs text-faint">
                  {current?.name ??
                    (opt.currentValue
                      ? bareModelIdFromConfigValue(opt.currentValue)
                      : "—")}
                </span>
              </button>
            );
          })}
        </>
      )}

      {workflowEnabled && activeSessionId != null && (
        <>
          <SectionLabel title={t("panel.workflows")} />
          {/* The single workflow entry: launching, live runs, history and
              cleanup all live INSIDE the management page — the panel keeps
              nothing workflow-specific of its own. */}
          <button
            onClick={() => openConfig("workflows")}
            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left active:bg-white/[0.05]"
          >
            <span className="flex items-center gap-2 text-sm text-dim">
              <Workflow className="size-3.5 shrink-0 text-faint" />
              {t("panel.workflowManage")}
            </span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        </>
      )}

      <QuotaSection />

      {activeSessionId == null && !usageStats && !quotaUnavailable && (
        <p className="px-4 py-2 text-xs text-faint">{t("chat.noSession")}</p>
      )}

      {configOpen && (
        <ConfigSheet
          optionId={configOpen}
          onClose={() => setConfigOpen(null)}
        />
      )}
    </PanelShell>
  );
}

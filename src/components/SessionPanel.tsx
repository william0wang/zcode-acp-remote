import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Workflow } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { ConfigSheet } from "./ConfigSheet";
import { PanelShell } from "./SidePanel";
import { QuotaSection, SectionLabel } from "./QuotaSection";
import { WorkflowStartSheet } from "./chat/WorkflowStartSheet";
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
  const [configOpen, setConfigOpen] = useState<string | null>(null);
  const [wfOpen, setWfOpen] = useState(false);

  // The launcher's visibility rides the per-instance gate verdict (the same
  // fail-closed rule the config screen applies to its workflows entry), so
  // the panel probes it when it is still unknown.
  useEffect(() => {
    if (workflowGate === null) void loadWorkflowGate();
  }, [workflowGate, loadWorkflowGate]);

  return (
    // In-chat workflow launcher: a header button, not another stacked row —
    // starting with `sessionId` pins the run to THIS session (the server
    // takes it on start), so the progress card streams into the open
    // conversation.
    <PanelShell
      title={t("panel.session")}
      onClose={onClose}
      action={
        activeSessionId != null && workflowGate?.enabled === true ? (
          <button
            onClick={() => setWfOpen(true)}
            aria-label={t("chat.workflowPickTitle")}
            className="flex size-8 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
          >
            <Workflow className="size-4" />
          </button>
        ) : undefined
      }
    >
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
      {wfOpen && activeSessionId && (
        <WorkflowStartSheet
          sessionId={activeSessionId}
          onClose={() => setWfOpen(false)}
        />
      )}
    </PanelShell>
  );
}

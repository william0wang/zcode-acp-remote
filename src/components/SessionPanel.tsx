import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Square, Workflow } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { ConfigSheet } from "./ConfigSheet";
import { PanelShell } from "./SidePanel";
import { QuotaSection, SectionLabel } from "./QuotaSection";
import { WorkflowStartSheet } from "./chat/WorkflowStartSheet";
import { StatusBadge } from "./config/WorkflowRunDetail";
import { bareModelIdFromConfigValue } from "../lib/modelValue";
import type { ConversationRunSummary } from "../lib/types";

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
  const loadSessionRuns = useAppStore((s) => s.loadSessionRuns);
  const openConfig = useAppStore((s) => s.openConfig);
  const openWorkflowRun = useAppStore((s) => s.openWorkflowRun);
  const stopWorkflowRun = useAppStore((s) => s.stopWorkflowRun);
  const instanceId = useAppStore((s) => s.instanceId);
  const [configOpen, setConfigOpen] = useState<string | null>(null);
  const [wfOpen, setWfOpen] = useState(false);
  const [sessionRuns, setSessionRuns] = useState<ConversationRunSummary[] | null>(
    null,
  );

  // The launcher's visibility rides the per-instance gate verdict (the same
  // fail-closed rule the config screen applies to its workflows entry), so
  // the panel probes it when it is still unknown.
  useEffect(() => {
    if (workflowGate === null) void loadWorkflowGate();
  }, [workflowGate, loadWorkflowGate]);

  const workflowEnabled = workflowGate?.enabled === true;

  // This session's runs (desktop task-row workflowActivity parity): journal
  // summaries via conversationRuns, re-read on a 5s cadence while the panel
  // is open with a session attached. The chain re-arms on EVERY read —
  // re-arming only on active runs froze the block at "no runs" when the
  // first read raced the launched run's first journal row.
  useEffect(() => {
    if (!workflowEnabled || !activeSessionId) {
      setSessionRuns(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const runs = await loadSessionRuns(activeSessionId);
      if (!alive) return;
      setSessionRuns(runs);
      timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [workflowEnabled, activeSessionId, loadSessionRuns]);

  // The runs rows' stop: hub-routed (stopWorkflowRun with an instanceId), then
  // an immediate re-read so the row settles without waiting for the next tick.
  async function stopRun(runId: string) {
    if (!activeSessionId) return;
    const ok = await stopWorkflowRun(runId, activeSessionId, instanceId ?? undefined);
    if (ok) setSessionRuns(await loadSessionRuns(activeSessionId));
  }

  return (
    // In-chat workflow launcher: a header button, not another stacked row —
    // starting with `sessionId` pins the run to THIS session (the server
    // takes it on start), so the progress card streams into the open
    // conversation.
    <PanelShell
      title={t("panel.session")}
      onClose={onClose}
      action={
        activeSessionId != null && workflowEnabled ? (
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

      {workflowEnabled && activeSessionId != null && (
        <>
          <SectionLabel title={t("panel.workflows")} />
          {/* No launch row: the header workflow button is the quick start, and
              the management page starts runs with full detail. */}
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
          <div className="px-4 pb-1 pt-2">
            <p className="text-[10px] uppercase tracking-wide text-faint">
              {t("panel.workflowSessionRuns")}
            </p>
            {sessionRuns === null || sessionRuns.length === 0 ? (
              <p className="py-1.5 text-xs text-faint">
                {t("panel.workflowNoRuns")}
              </p>
            ) : (
              sessionRuns.map((r) => {
                const active = r.status === "running" || r.status === "pending";
                return (
                  <div
                    key={r.runId}
                    className="flex items-center gap-2 py-1.5 text-xs"
                  >
                    <button
                      onClick={() =>
                        openWorkflowRun({
                          sessionId: activeSessionId,
                          runId: r.runId,
                          name: r.label ?? r.runId.slice(0, 12),
                          instanceId: instanceId ?? "",
                        })
                      }
                      className="min-w-0 flex-1 truncate text-left font-mono text-dim active:opacity-60"
                    >
                      {r.label ?? r.runId.slice(0, 12)}
                    </button>
                    <StatusBadge status={r.status} />
                    {active && (
                      <button
                        onClick={() => void stopRun(r.runId)}
                        aria-label={t("panel.workflowStopRun")}
                        className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-dim active:bg-white/[0.12]"
                      >
                        <Square className="size-3" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
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

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../store/appStore";
import type { GoWindowEntry } from "../lib/types";
import { ConfigSheet } from "./ConfigSheet";
import { PanelShell } from "./SidePanel";

// Local `MM-DD HH:MM` reset stamp — the same layout the zcode-quota CLI card
// uses, so the app reads identically to the terminal output.
function fmtResetTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Status lines, verbatim from the CLI card's non-success prose.
const GLM_STATUS: Record<string, string> = {
  auth_error: "🔒 Quota auth expired — re-login in the ZCode app",
  rate_limited: "⏳ Quota service busy, try again shortly",
  unavailable: "⚠ Quota info unavailable",
};
const GO_STATUS: Record<string, string> = {
  auth_error: "auth expired — refresh your opencode.ai cookie",
  unavailable: "unavailable",
};

// One bar line — CLI layout: label, bar, then `NN% · reset · count` trailing.
// The per-item MCP breakdown is deliberately dropped; the totals suffice.
function QuotaRow({
  label,
  percent,
  resetMs,
  count,
}: {
  label: string;
  percent: number;
  resetMs?: number;
  count?: number;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="px-4 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 font-mono text-xs text-dim">{label}</span>
        <span className="truncate text-xs tabular-nums text-faint">
          {percent}%
          {resetMs != null && ` · ${fmtResetTime(resetMs)}`}
          {count != null && ` · ${count}`}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={`h-full rounded-full ${clamped >= 90 ? "bg-red-500" : "bg-blue-500"}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function SectionLabel({ title, divided }: { title: string; divided?: boolean }) {
  return (
    <h3
      className={`px-4 pb-0.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-faint ${
        divided ? "mt-2 border-t border-hairline" : ""
      }`}
    >
      {title}
    </h3>
  );
}

// Session-scoped right panel shown in chat: config options (model / mode /
// thought) and the plan quota card. Global settings live in SettingsPanel.
export function SessionPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const configOptions = useAppStore((s) => s.configOptions);
  const usageStats = useAppStore((s) => s.usageStats);
  const quotaUnavailable = useAppStore((s) => s.quotaUnavailable);
  const refreshUsageStats = useAppStore((s) => s.refreshUsageStats);
  const [configOpen, setConfigOpen] = useState<string | null>(null);

  return (
    <PanelShell title={t("panel.session")} onClose={onClose}>
      {/* Session-scoped config — meaningless until a session is attached. */}
      {activeSessionId != null && configOptions.length > 0 && (
        <>
          <SectionLabel title={t("config.title")} />
          {configOptions.map((opt) => {
            const current = opt.options?.find((v) => v.value === opt.currentValue);
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
                  {current?.name ?? opt.currentValue ?? "—"}
                </span>
              </button>
            );
          })}
        </>
      )}

      {(quotaUnavailable || usageStats) && (
        <>
          <div className="mt-2 flex items-center justify-between border-t border-hairline px-4 pb-0.5 pt-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-faint">
              {t("quota.title")}
            </h3>
            <button
              onClick={() => void refreshUsageStats()}
              aria-label={t("quota.refresh")}
              className="flex size-7 items-center justify-center rounded-full text-faint active:bg-white/[0.06]"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
          {quotaUnavailable ? (
            <p className="px-4 py-1 text-xs text-faint">{t("quota.unavailable")}</p>
          ) : (
            usageStats && (
              <>
                <SectionLabel
                  title={`GLM Coding Plan${
                    usageStats.glm.level ? ` · ${capitalise(usageStats.glm.level)}` : ""
                  }`}
                />
                {usageStats.glm.kind === "success" ? (
                  usageStats.glm.items?.map((it) => (
                    <QuotaRow
                      key={it.key}
                      label={it.label}
                      percent={it.usedPercent}
                      resetMs={it.nextResetTime}
                      count={it.usedCount}
                    />
                  ))
                ) : (
                  <p className="px-4 py-1 text-xs text-faint">
                    {GLM_STATUS[usageStats.glm.kind] ?? GLM_STATUS.unavailable}
                  </p>
                )}

                {usageStats.opencode.kind !== "not_configured" && (
                  <>
                    <SectionLabel title="Opencode Go" divided />
                    {usageStats.opencode.kind === "success" ? (
                      usageStats.opencode.windows?.map((w: GoWindowEntry) => (
                        <QuotaRow
                          key={w.key}
                          label={w.label}
                          percent={w.usagePercent}
                          resetMs={w.resetsAt}
                        />
                      ))
                    ) : (
                      <p className="px-4 py-1 text-xs text-faint">
                        {GO_STATUS[usageStats.opencode.kind] ?? GO_STATUS.unavailable}
                      </p>
                    )}
                  </>
                )}
              </>
            )
          )}
        </>
      )}

      {activeSessionId == null && !usageStats && !quotaUnavailable && (
        <p className="px-4 py-2 text-xs text-faint">{t("chat.noSession")}</p>
      )}

      {configOpen && <ConfigSheet optionId={configOpen} onClose={() => setConfigOpen(null)} />}
    </PanelShell>
  );
}

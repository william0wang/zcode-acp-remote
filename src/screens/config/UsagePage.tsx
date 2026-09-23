import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
  fmtTokens,
} from "../../components/config/ConfigPage";

// Local token usage (ADR-0009): what this machine actually spent, per model,
// read from the agent's own database. Deliberately separate from Plan Quota,
// which is the account's allowance — a user sees both and they answer
// different questions.
const RANGES = ["7d", "30d", "all"] as const;
type Range = (typeof RANGES)[number];

export function UsagePage() {
  const { t } = useTranslation();
  const usage = useAppStore((s) => s.configUsage);
  const supported = useAppStore((s) => s.configSupported);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  // The store's record of the last ask is the authority: a response that
  // arrives out of order is dropped there, so trusting a local mirror here
  // could highlight a range whose numbers were discarded.
  const storeRange = useAppStore((s) => s.configUsageRange);
  const range = (RANGES as readonly string[]).includes(storeRange)
    ? (storeRange as Range)
    : "7d";

  useEffect(() => {
    void loadConfigSection("usage");
  }, [loadConfigSection]);

  // The range is a client-side control over the same endpoint; switching
  // refetches rather than filtering a wider window, so the numbers always
  // match what the bridge computed for that range.
  async function pickRange(next: Range) {
    await loadConfigSection("usage", { range: next });
  }

  const models = usage?.models ?? [];
  const daily = usage?.daily ?? [];

  return (
    <ConfigPageFrame
      title={t("zconfig.usage")}
      onBack={() => useAppStore.getState().openConfig(null)}
      unsupported={supported === false}
      // The frame's spinner covers the first load; this page's own loading
      // branch below only has to distinguish "no database" from "no rows".
      hasLoaded={usage !== null}
    >
      <div className="flex gap-2 px-4 py-3">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => void pickRange(r)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs transition ${
              r === range
                ? "bg-white/[0.1] font-medium text-ink"
                : "text-faint active:bg-white/[0.05]"
            }`}
          >
            {t(`zconfig.range${r === "all" ? "All" : r}`)}
          </button>
        ))}
      </div>

      {usage && !usage.available ? (
        // No agent database is a normal state on a machine that never ran one,
        // not an error — say so plainly rather than showing an empty chart.
        <ConfigEmpty text={t("zconfig.usageNoData")} />
      ) : (
        <>
          <ConfigBlock>
            <div className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-dim">{t("zconfig.usageTotal")}</span>
                <span className="text-sm tabular-nums text-ink">
                  {fmtTokens(usage?.summary.totalTokens ?? 0)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 pt-1">
                <span className="text-sm text-dim">
                  {t("zconfig.usageRequests")}
                </span>
                <span className="text-sm tabular-nums text-ink">
                  {usage?.summary.requestCount ?? 0}
                </span>
              </div>
            </div>
          </ConfigBlock>

          <ConfigBlock title={t("zconfig.usageByModel")} divided>
            {models.length === 0 ? (
              <ConfigEmpty text={t("zconfig.usageNoData")} />
            ) : (
              models.map((m) => (
                <div key={m.modelId ?? "unknown"} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-dim">
                      {/* The db column is nullable (older rows predate the
                          column), so a null id renders as a placeholder rather
                          than a blank line the user cannot attribute. */}
                      {m.modelId ?? t("zconfig.usageUnknownModel")}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-ink">
                      {fmtTokens(m.totalTokens)}
                      {m.share != null && (
                        <span className="pl-1.5 text-faint">
                          {(m.share * 100).toFixed(0)}%
                        </span>
                      )}
                    </span>
                  </div>
                  {/* The share bar: same heat idea as the quota card, but here
                      it compares models against each other, not against a
                      limit — so it is a flat neutral fill. */}
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className="h-full rounded-full bg-white/25"
                      style={{ width: `${Math.round((m.share ?? 0) * 100)}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </ConfigBlock>

          {daily.length > 0 && (
            <ConfigBlock title={t("zconfig.usageByDay")} divided>
              {daily.map((d) => (
                <div
                  key={d.date}
                  className="flex items-baseline justify-between gap-3 px-4 py-2"
                >
                  <span className="shrink-0 font-mono text-xs text-faint">
                    {d.date}
                  </span>
                  <span className="min-w-0 truncate text-right text-xs text-dim">
                    {d.models
                      .map((m) => `${m.modelId} ${fmtTokens(m.totalTokens)}`)
                      .join(" · ")}
                  </span>
                </div>
              ))}
            </ConfigBlock>
          )}
        </>
      )}
    </ConfigPageFrame>
  );
}

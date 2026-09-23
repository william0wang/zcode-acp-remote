import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RefreshCw } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
  fmtStamp,
} from "../../components/config/ConfigPage";
import { QuotaRow, SectionLabel } from "../../components/QuotaSection";

// Plan quota with its reset cards (ADR-0009). The side panels' quota card is
// read-only and untouched; this screen is where a card can actually be spent.
//
// Two gates stand in front of a spend, both deliberate — spending a card is
// the one irreversible action in the settings API:
//   1. the highest usage window must be at or above the threshold, so a card
//      is only offered when it would actually help;
//   2. the spend itself is confirmed with the card's type and expiry.
// Between them sits an opportunity request, because the backend can decline
// one ("not now") and a declined spend is a wasted round trip.
export const SPEND_THRESHOLD_PCT = 90;

/** The provider ids that can own a coding plan (server coding-plan.ts). */
export const CODING_PLAN_PROVIDERS = [
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
];

// A team plan needs organization/project headers a headless process cannot
// read, so its cards can never be spent from here. Say so instead of letting
// the user commit to a request that fails.
export function isTeamPlan(providerId: string): boolean {
  return providerId.includes("-team-");
}

/**
 * The highest used percentage across the GLM windows.
 *
 * The gate is "any window at or above the threshold", not "every window": one
 * exhausted window is exactly when a card helps, and waiting for all of them
 * would refuse the case the feature exists for.
 */
export function maxUsedPercent(
  items: Array<{ usedPercent: number }> | undefined,
): number {
  return (items ?? []).reduce((m, it) => Math.max(m, it.usedPercent), 0);
}

/**
 * The percentage that decides whether a card may be offered.
 *
 * Reads the GLM branch and NOTHING else. The usage payload also carries
 * Opencode Go and Ollama windows, which a coding-plan card does nothing for —
 * passing the whole payload (or the other branches) would let an exhausted
 * Opencode window open the gate on a card that cannot clear it. The selector
 * is exported so the page and its tests agree on which windows count.
 */
export function spendGatePercent(
  usageStats: { glm: { items?: Array<{ usedPercent: number }> } } | null,
): number {
  return maxUsedPercent(usageStats?.glm.items);
}

/**
 * A short label for a coding-plan provider id.
 *
 * The wire ids are long (`account:bigmodel-individual-coding-plan`) and the
 * parts that matter to a human are the family and whether it is a personal or
 * team plan. The picker shows that instead of the raw string.
 */
function providerLabel(id: string, t: (key: string) => string): string {
  const family = id.includes(":zai-") ? "Zai" : "Bigmodel";
  return id.includes("-team-")
    ? `${family} · ${t("zconfig.planTeam")}`
    : `${family} · ${t("zconfig.planIndividual")}`;
}

export function QuotaPage() {
  const { t } = useTranslation();
  const usageStats = useAppStore((s) => s.usageStats);
  const usageStatsAt = useAppStore((s) => s.usageStatsAt);
  const quotaUnavailable = useAppStore((s) => s.quotaUnavailable);
  const refreshUsageStats = useAppStore((s) => s.refreshUsageStats);
  const resetCards = useAppStore((s) => s.resetCards);
  const resetProviderId = useAppStore((s) => s.resetProviderId);
  const resetBusy = useAppStore((s) => s.resetBusy);
  const resetNextTryAt = useAppStore((s) => s.resetNextTryAt);
  const supported = useAppStore((s) => s.configSupported);
  const loadResetCards = useAppStore((s) => s.loadResetCards);
  const requestResetOpportunity = useAppStore((s) => s.requestResetOpportunity);
  const spendResetCard = useAppStore((s) => s.spendResetCard);
  const markResetHistoryRead = useAppStore((s) => s.markResetHistoryRead);
  const [confirm, setConfirm] = useState<"FIVE_HOUR" | "WEEK" | null>(null);

  // Which providers could hold cards, from the entry snapshot's eligibility
  // check (a provider-id shape test plus a credential-file check). The hub
  // lists all four ids regardless of the account, so the picker is the norm
  // rather than the exception.
  const eligible = useAppStore((s) => s.resetEligible);
  const credentialsOk = useAppStore((s) => s.resetCredentials);
  // Nothing is pre-selected: guessing which plan the account holds would show
  // an empty inventory and read as "I have no cards".
  const providerId = resetProviderId;

  // Load the inventory once the provider is known. The nonce it returns is
  // what the spend sends back, so a screen that sat open for an hour cannot
  // burn a card from stale state.
  useEffect(() => {
    if (providerId) void loadResetCards(providerId);
  }, [providerId, loadResetCards]);

  // The unread badge is cosmetic, but clearing it on the way out means the
  // user is not shown a dot for history they just read.
  useEffect(() => {
    if (resetCards?.hasUnreadHistory) void markResetHistoryRead();
  }, [resetCards?.hasUnreadHistory, markResetHistoryRead]);

  const maxUsedPct = spendGatePercent(usageStats);

  const canSpend = maxUsedPct >= SPEND_THRESHOLD_PCT;
  const teamBlocked = providerId ? isTeamPlan(providerId) : false;

  async function spend(resetType: "FIVE_HOUR" | "WEEK") {
    // Capture BOTH halves of the spend now, while the confirm dialog is still
    // open and the user cannot switch provider underneath. A gesture spans two
    // round trips (opportunity, then spend); re-reading the store at entry time
    // of the second would let a provider switch redirect the spend at another
    // plan's card — spending is irreversible, so the wrong provider is the one
    // failure mode worth engineering against.
    const spendProviderId = providerId;
    const spendNonce = resetCards?.nonce ?? "";
    if (!spendProviderId || !spendNonce) return;
    setConfirm(null);
    // Ask first: the backend answers "not now" with a next-try time, and a
    // granted opportunity is what makes the spend worth committing to.
    const granted = await requestResetOpportunity(spendProviderId);
    if (!granted) return;
    await spendResetCard({ providerId: spendProviderId, nonce: spendNonce, resetType });
  }

  return (
    <ConfigPageFrame
      title={t("zconfig.quota")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void refreshUsageStats()}
      unsupported={supported === false}
    >
      {/* ---- the allowance itself ---- */}
      <ConfigBlock>
        {quotaUnavailable ? (
          <ConfigEmpty text={t("quota.unavailable")} />
        ) : usageStats ? (
          <>
            <SectionLabel title="GLM Coding Plan" />
            {usageStats.glm.kind === "success" ? (
              (usageStats.glm.items ?? []).map((it) => (
                <QuotaRow
                  key={it.key}
                  label={it.label}
                  percent={it.usedPercent}
                  resetMs={it.nextResetTime}
                  used={it.key === "mcp" ? it.usedCount : undefined}
                  total={it.key === "mcp" ? it.totalCount : undefined}
                />
              ))
            ) : (
              <ConfigEmpty text={t("quota.unavailable")} />
            )}
            {usageStats.opencode.kind !== "not_configured" && (
              <>
                <SectionLabel title="Opencode Go" divided />
                {(usageStats.opencode.windows ?? []).map((w) => (
                  <QuotaRow
                    key={w.key}
                    label={w.label}
                    percent={w.usagePercent}
                    resetMs={w.resetsAt}
                  />
                ))}
              </>
            )}
          </>
        ) : (
          <ConfigEmpty text={t("quota.unavailable")} />
        )}
      </ConfigBlock>

      {/* ---- reset cards ---- */}
      <ConfigBlock title={t("zconfig.resetCards")} divided>
        {/* The hub lists the provider ids that COULD own cards; it does not
            know which one this account actually has, so the user picks. Team
            plans are offered too — they are selectable and then explained,
            because hiding them would look like the plan is missing. */}
        {eligible.length > 1 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {eligible.map((id) => (
              <button
                key={id}
                disabled={resetBusy}
                onClick={() => void loadResetCards(id)}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] transition disabled:opacity-50 ${
                  id === providerId
                    ? "bg-white/[0.12] font-medium text-ink"
                    : "text-faint active:bg-white/[0.06]"
                }`}
              >
                {providerLabel(id, t)}
              </button>
            ))}
          </div>
        )}

        {!credentialsOk ? (
          // The credential store is encrypted per machine; not being able to
          // read it is a normal state, and it is distinct from having no plan.
          <ConfigEmpty text={t("zconfig.resetUnavailable")} />
        ) : !providerId ? (
          <ConfigEmpty text={t("zconfig.resetPickProvider")} />
        ) : teamBlocked ? (
          // Not a missing feature — the request cannot work from a headless
          // process, so offer the desktop app instead of a dead button.
          <ConfigEmpty text={t("zconfig.resetTeamBlocked")} />
        ) : resetBusy && !resetCards ? (
          <ConfigEmpty text={t("zconfig.resetLoading")} />
        ) : resetCards ? (
          <>
            <CardList
              title={t("zconfig.resetFiveHour")}
              cards={resetCards.availableFiveHour}
              lastUsed={resetCards.latestFiveHour?.usedAt ?? null}
              resetType="FIVE_HOUR"
              canSpend={canSpend}
              busy={resetBusy}
              nextTryAt={resetNextTryAt}
              confirm={confirm}
              onConfirm={setConfirm}
              onSpend={spend}
            />
            <CardList
              title={t("zconfig.resetWeek")}
              cards={resetCards.availableWeek}
              lastUsed={resetCards.latestWeek?.usedAt ?? null}
              resetType="WEEK"
              canSpend={canSpend}
              busy={resetBusy}
              nextTryAt={resetNextTryAt}
              confirm={confirm}
              onConfirm={setConfirm}
              onSpend={spend}
            />
            {/* The threshold is the gate; when it is not met, say why rather
                than showing a mysteriously disabled button. */}
            {!canSpend && (
              <p className="px-4 pt-2 text-xs text-faint">
                {t("zconfig.resetBelowThreshold", { pct: SPEND_THRESHOLD_PCT })}
              </p>
            )}
          </>
        ) : (
          <ConfigEmpty text={t("zconfig.resetUnavailable")} />
        )}
      </ConfigBlock>

      {usageStatsAt != null && (
        <p className="px-4 pt-3 text-center text-[11px] text-faint">
          {t("quota.updated")} {fmtStamp(usageStatsAt)}
        </p>
      )}
    </ConfigPageFrame>
  );
}

/**
 * One window's card inventory: how many are left, when each expires, and the
 * spend control.
 *
 * A card carries an expiry and nothing else — the API exposes no card number
 * or denomination — so this is all there is to show. Soonest-expiring first,
 * because that is the order they should be spent in.
 */
function CardList({
  title,
  cards,
  lastUsed,
  resetType,
  canSpend,
  busy,
  nextTryAt,
  confirm,
  onConfirm,
  onSpend,
}: {
  title: string;
  cards: Array<{ expireAt: number }>;
  lastUsed: number | null;
  resetType: "FIVE_HOUR" | "WEEK";
  canSpend: boolean;
  busy: boolean;
  nextTryAt: number | null;
  confirm: "FIVE_HOUR" | "WEEK" | null;
  onConfirm: (v: "FIVE_HOUR" | "WEEK" | null) => void;
  onSpend: (v: "FIVE_HOUR" | "WEEK") => void;
}) {
  const { t } = useTranslation();
  const sorted = [...cards].sort((a, b) => a.expireAt - b.expireAt);
  const next = sorted[0];

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-dim">{title}</span>
        <span className="text-sm tabular-nums text-ink">{cards.length}</span>
      </div>

      {cards.length === 0 ? (
        <p className="pt-1 text-xs text-faint">{t("zconfig.resetNone")}</p>
      ) : (
        <ul className="pt-1">
          {sorted.map((c, i) => (
            <li
              key={`${c.expireAt}-${i}`}
              className="flex items-center gap-2 py-0.5 text-xs text-faint"
            >
              <Check className="size-3 shrink-0 text-emerald-400/70" />
              <span className="tabular-nums">
                {t("zconfig.resetExpires")} {fmtStamp(c.expireAt)}
              </span>
              {i === 0 && (
                <span className="ml-auto shrink-0 text-[10px] text-faint">
                  {t("zconfig.resetNextUp")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {lastUsed != null && (
        <p className="pt-1 text-[11px] text-faint">
          {t("zconfig.resetLastUsed")} {fmtStamp(lastUsed)}
        </p>
      )}

      {nextTryAt != null && nextTryAt > Date.now() && (
        <p className="pt-1 text-[11px] text-amber-300">
          {t("zconfig.resetRetryAt")} {fmtStamp(nextTryAt)}
        </p>
      )}

      {cards.length > 0 && (
        <>
          {confirm === resetType ? (
            // The confirmation names the card, not a generic "are you sure":
            // a spend is irreversible and the user is committing to a specific
            // window and expiry.
            <div className="mt-2 rounded-lg bg-white/[0.05] px-3 py-2.5">
              <p className="text-xs text-dim">
                {t("zconfig.resetConfirm", {
                  title: title.toLowerCase(),
                  expires: next ? fmtStamp(next.expireAt) : "",
                })}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => onConfirm(null)}
                  className="flex-1 rounded-lg px-3 py-2 text-xs text-faint active:bg-white/[0.06]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void onSpend(resetType)}
                  className="flex-1 rounded-lg bg-white/[0.1] px-3 py-2 text-xs font-medium text-ink active:bg-white/[0.15] disabled:opacity-60"
                >
                  {busy ? (
                    <RefreshCw className="mx-auto size-3.5 animate-spin" />
                  ) : (
                    t("zconfig.resetSpend")
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button
              disabled={!canSpend || busy}
              onClick={() => onConfirm(resetType)}
              className="mt-2 w-full rounded-lg bg-white/[0.08] px-3 py-2 text-xs font-medium text-ink active:bg-white/[0.12] disabled:opacity-40"
            >
              {t("zconfig.resetUse")}
            </button>
          )}
        </>
      )}
    </div>
  );
}


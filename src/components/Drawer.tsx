import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/appStore";
import type { GoWindowEntry, QuotaItem } from "../lib/types";
import { ConfigSheet } from "./ConfigSheet";

function baseName(path: string | undefined): string {
  if (!path) return "?";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

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
function QuotaRow({
  label,
  percent,
  resetMs,
  count,
  detail,
}: {
  label: string;
  percent: number;
  resetMs?: number;
  count?: number;
  detail?: QuotaItem["detail"];
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="px-4 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 font-mono text-xs text-zinc-300">{label}</span>
        <span className="truncate text-xs tabular-nums text-zinc-500">
          {percent}%
          {resetMs != null && ` · ${fmtResetTime(resetMs)}`}
          {count != null && ` · ${count}`}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full ${clamped >= 90 ? "bg-red-500" : "bg-blue-500"}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {detail?.map((d) => (
        <p key={d.modelCode} className="mt-0.5 pl-1 font-mono text-[11px] text-zinc-600">
          {d.modelCode} {d.usage}
        </p>
      ))}
    </div>
  );
}

function SectionHeader({ title, divided }: { title: string; divided?: boolean }) {
  return (
    <h3
      className={`px-4 pb-0.5 pt-2 text-xs font-semibold text-zinc-300 ${
        divided ? "mt-2 border-t border-zinc-800/70" : ""
      }`}
    >
      {title}
    </h3>
  );
}

// One flat list across every bridge instance: session title as the main line,
// workspace as the subtitle. Tapping a session on another instance switches
// the WS connection and attaches in one step.
export function Drawer({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const instances = useAppStore((s) => s.instances);
  const instanceId = useAppStore((s) => s.instanceId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const refreshInstances = useAppStore((s) => s.refreshInstances);
  const openSession = useAppStore((s) => s.openSession);
  const setLang = useAppStore((s) => s.setLang);
  const configOptions = useAppStore((s) => s.configOptions);
  const usageStats = useAppStore((s) => s.usageStats);
  const quotaUnavailable = useAppStore((s) => s.quotaUnavailable);
  const refreshUsageStats = useAppStore((s) => s.refreshUsageStats);
  const [configOpen, setConfigOpen] = useState<string | null>(null);

  const sessions = instances
    .flatMap((i) =>
      (i.sessions ?? []).map((s) => ({
        ...s,
        instanceId: i.id,
        workspace: i.workspace,
      })),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  function switchLang(lang: "en" | "zh-CN") {
    setLang(lang);
    void i18n.changeLanguage(lang);
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-80 max-w-[85%] flex-col overflow-y-auto bg-zinc-950 pt-[max(env(safe-area-inset-top),0.75rem)] text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pb-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {t("chat.sessions")}
          </h2>
          <button
            onClick={() => void refreshInstances({ probe: true })}
            className="text-xs text-zinc-500 active:text-zinc-300"
          >
            {t("picker.refresh")}
          </button>
        </div>
        {sessions.length === 0 && (
          <p className="px-4 py-2 text-xs text-zinc-600">{t("chat.noSessions")}</p>
        )}
        {sessions.map((s) => {
          const active = s.instanceId === instanceId && s.sessionId === activeSessionId;
          return (
            <button
              key={`${s.instanceId}:${s.sessionId}`}
              onClick={() => {
                onClose();
                void openSession(s.instanceId, s.sessionId);
              }}
              className={`px-4 py-2.5 text-left ${
                active ? "bg-zinc-800" : "active:bg-zinc-900"
              }`}
            >
              <span
                className={`block truncate text-sm ${active ? "text-zinc-100" : "text-zinc-300"}`}
              >
                {s.title || t("chat.untitled")}
              </span>
              <span className="mt-0.5 block truncate text-xs text-zinc-500">
                {baseName(s.workspace)}
              </span>
            </button>
          );
        })}

        {/* Session-scoped config — meaningless until a session is attached. */}
        {activeSessionId != null && configOptions.length > 0 && (
          <>
            <h2 className="px-4 pb-1 pt-5 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t("config.title")}
            </h2>
            {configOptions.map((opt) => {
              const current = opt.options?.find((v) => v.value === opt.currentValue);
              return (
                <button
                  key={opt.id}
                  onClick={() => setConfigOpen(opt.id)}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-left active:bg-zinc-900"
                >
                  <span className="shrink-0 text-sm text-zinc-300">
                    {t(`config.${opt.id}`, { defaultValue: opt.name ?? opt.id })}
                  </span>
                  <span className="truncate text-xs text-zinc-500">
                    {current?.name ?? opt.currentValue ?? "—"}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {(quotaUnavailable || usageStats) && (
          <>
            <div className="flex items-center justify-between px-4 pb-1 pt-5">
              <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                {t("quota.title")}
              </h2>
              <button
                onClick={() => void refreshUsageStats()}
                className="text-xs text-zinc-500 active:text-zinc-300"
              >
                {t("quota.refresh")}
              </button>
            </div>
            {quotaUnavailable ? (
              <p className="px-4 py-1 text-xs text-zinc-600">{t("quota.unavailable")}</p>
            ) : (
              usageStats && (
                <>
                  <SectionHeader
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
                        detail={it.detail}
                      />
                    ))
                  ) : (
                    <p className="px-4 py-1 text-xs text-zinc-600">
                      {GLM_STATUS[usageStats.glm.kind] ?? GLM_STATUS.unavailable}
                    </p>
                  )}

                  {usageStats.opencode.kind !== "not_configured" && (
                    <>
                      <SectionHeader title="Opencode Go" divided />
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
                        <p className="px-4 py-1 text-xs text-zinc-600">
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

        <div className="mt-auto flex gap-2 border-t border-zinc-800 p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
          <button
            onClick={() => switchLang("en")}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs ${
              i18n.language === "en" ? "border-blue-500 text-blue-400" : "border-zinc-700 text-zinc-400"
            }`}
          >
            English
          </button>
          <button
            onClick={() => switchLang("zh-CN")}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs ${
              i18n.language === "zh-CN" ? "border-blue-500 text-blue-400" : "border-zinc-700 text-zinc-400"
            }`}
          >
            中文
          </button>
        </div>

        {configOpen && <ConfigSheet optionId={configOpen} onClose={() => setConfigOpen(null)} />}
      </aside>
    </div>
  );
}

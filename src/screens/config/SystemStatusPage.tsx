import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import { ConfigBlock, ConfigPageFrame, ConfigRow, fmtStamp } from "../../components/config/ConfigPage";
import type { SystemStatsResponse, SystemStatsVolume } from "../../lib/types";

// Machine-level system status (hub route /api/system-stats, bridge 0.62.0).
// A dashboard, not a config editor: every field is read-only, and every
// null field is a probe the hub could not run (denied inside a sandbox,
// absent hardware) — rendered as "—", never as an error. Rate fields (CPU %,
// transfer speeds, hub CPU %) are hub-side deltas across reads: the first
// read after a hub start shows "…" for them until a second read lands.

/** Poll cadence: a live dashboard; the hub caches a collect for 1s. */
const POLL_MS = 5000;

const PLACEHOLDER = "—";
const PENDING = "…";

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

function fmtRate(bytesPerS: number | null): string {
  if (bytesPerS == null) return PENDING;
  return `${fmtBytes(bytesPerS)}/s`;
}

function fmtUptime(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtMinutes(min: number | null): string {
  if (min == null) return PLACEHOLDER;
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// CLI-parity heat color (QuotaSection's heatColor): green → yellow → red,
// piecewise-linear at 0/50/100%.
function heatColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const [r, g, b] =
    p < 50
      ? [lerp(34, 234, p / 50), lerp(197, 179, p / 50), lerp(94, 8, p / 50)]
      : [
          lerp(234, 239, (p - 50) / 50),
          lerp(179, 68, (p - 50) / 50),
          lerp(8, 68, (p - 50) / 50),
        ];
  return `rgb(${r}, ${g}, ${b})`;
}

/** One usage bar line (QuotaRow's layout, byte-oriented values). */
function BarRow({
  label,
  value,
  percent,
}: {
  label: string;
  value: string;
  percent: number | null;
}) {
  const clamped = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="px-4 py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 font-mono text-xs text-dim">{label}</span>
        <span className="shrink-0 truncate text-xs tabular-nums text-faint">
          {value}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full"
          style={
            percent == null
              ? undefined
              : { width: `${clamped}%`, backgroundColor: heatColor(clamped) }
          }
        />
      </div>
    </div>
  );
}

export function SystemStatusPage() {
  const { t } = useTranslation();
  const stats = useAppStore((s) => s.configSystemStats);
  const loading = useAppStore((s) => s.configSystemStatsLoading);
  const error = useAppStore((s) => s.configSystemStatsError);
  const supported = useAppStore((s) => s.configSystemStatsSupported);
  const loadSystemStats = useAppStore((s) => s.loadSystemStats);
  const backFromConfigSection = useAppStore((s) => s.backFromConfigSection);

  // First paint is seeded by the ZCodeConfigScreen mount effect (the section
  // case in loadConfigSection → loadSystemStats); this poll keeps the
  // dashboard live for as long as the page is open. No page-level mount
  // effect — child effects run before the parent's, so one here would
  // double-fire the seed read (same shape as WorkflowsPage).
  useEffect(() => {
    const timer = setInterval(() => void loadSystemStats(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadSystemStats]);

  const m = stats?.memory;
  const root = stats?.storage.root;
  const home = stats?.storage.home;
  const battery = stats?.battery;
  const power = stats?.power;
  const net = stats?.network;

  const powerSource =
    battery?.powerSource == null
      ? PLACEHOLDER
      : battery.powerSource === "ac"
        ? t("zconfig.systemPowerAc")
        : t("zconfig.systemPowerBattery");
  const battStatus =
    battery?.status == null
      ? null
      : ({
          charging: t("zconfig.systemBattCharging"),
          discharging: t("zconfig.systemBattDischarging"),
          charged: t("zconfig.systemBattCharged"),
        } as Record<string, string>)[battery.status] ?? battery.status;
  const usedPct = (v: SystemStatsVolume): number =>
    v.totalBytes > 0 ? (v.usedBytes / v.totalBytes) * 100 : 0;

  return (
    <ConfigPageFrame
      title={t("zconfig.system")}
      onBack={backFromConfigSection}
      onRefresh={() => void loadSystemStats()}
      refreshing={loading}
      loading={loading}
      unsupported={!supported}
      error={error}
      hasLoaded={stats != null}
    >
      {stats && (
        <>
          <ConfigBlock title={t("zconfig.systemHost")}>
            <ConfigRow label={t("zconfig.systemHostname")} value={stats.host.hostname} />
            <ConfigRow label={t("zconfig.systemOs")} value={stats.host.osVersion ?? PLACEHOLDER} />
            <ConfigRow label={t("zconfig.systemModel")} value={stats.host.model ?? PLACEHOLDER} />
            <ConfigRow label={t("zconfig.systemChip")} value={stats.host.chip ?? PLACEHOLDER} />
            <ConfigRow label={t("zconfig.systemUptime")} value={fmtUptime(stats.uptimeS)} />
          </ConfigBlock>

          <ConfigBlock title={t("zconfig.systemBattery")} divided>
            {battery?.present ? (
              <>
                <BarRow
                  label={t("zconfig.systemBattery")}
                  value={
                    battery.percent == null
                      ? PLACEHOLDER
                      : `${battery.percent}% · ${battStatus ?? ""}`.trim()
                  }
                  percent={battery.percent}
                />
                <ConfigRow
                  label={t("zconfig.systemPowerSource")}
                  value={`${powerSource}${battStatus ? ` · ${battStatus}` : ""}`}
                />
                <ConfigRow
                  label={t("zconfig.systemRemaining")}
                  value={fmtMinutes(battery.remainingMin)}
                />
              </>
            ) : (
              <ConfigRow
                label={t("zconfig.systemBattery")}
                value={t("zconfig.systemBatteryNone")}
              />
            )}
            <ConfigRow
              label={t("zconfig.systemSleep")}
              value={
                power?.preventSleep == null
                  ? PLACEHOLDER
                  : power.preventSleep
                    ? t("zconfig.systemSleepHeld")
                    : t("zconfig.systemSleepOk")
              }
              hint={
                power?.preventSleep && power.sleepHolders.length > 0
                  ? t("zconfig.systemSleepHolders", {
                      names: power.sleepHolders.join(", "),
                    })
                  : undefined
              }
            />
            <ConfigRow
              label={t("zconfig.systemThermal")}
              value={
                power?.cpuSpeedLimitPct == null
                  ? PLACEHOLDER
                  : power.cpuSpeedLimitPct >= 100
                    ? t("zconfig.systemThermalOk")
                    : t("zconfig.systemThermalLimited", {
                        pct: power.cpuSpeedLimitPct,
                      })
              }
            />
          </ConfigBlock>

          <ConfigBlock title={t("zconfig.systemPerformance")} divided>
            <BarRow
              label={`CPU · ${stats.cpu.cores}C`}
              value={
                stats.cpu.usagePct == null
                  ? PENDING
                  : `${stats.cpu.usagePct}%`
              }
              percent={stats.cpu.usagePct}
            />
            <ConfigRow
              label={t("zconfig.systemLoad")}
              value={stats.cpu.loadAvg.map((v) => v.toFixed(1)).join(" / ")}
            />
            {m && (
              <BarRow
                label={t("zconfig.systemMemory")}
                value={
                  m.usedBytes == null
                    ? PLACEHOLDER
                    : `${fmtBytes(m.usedBytes)} / ${fmtBytes(m.totalBytes)}`
                }
                percent={
                  m.usedBytes == null ? null : (m.usedBytes / m.totalBytes) * 100
                }
              />
            )}
            {m && m.swapTotalBytes != null && m.swapUsedBytes != null && (
              <BarRow
                label={t("zconfig.systemSwap")}
                value={`${fmtBytes(m.swapUsedBytes)} / ${fmtBytes(m.swapTotalBytes)}`}
                percent={(m.swapUsedBytes / m.swapTotalBytes) * 100}
              />
            )}
            {root && (
              <BarRow
                label={t("zconfig.systemStorage")}
                value={`${fmtBytes(root.usedBytes)} / ${fmtBytes(root.totalBytes)}`}
                percent={usedPct(root)}
              />
            )}
            {home && (
              <BarRow
                label={t("zconfig.systemStorageHome")}
                value={`${fmtBytes(home.usedBytes)} / ${fmtBytes(home.totalBytes)}`}
                percent={usedPct(home)}
              />
            )}
          </ConfigBlock>

          <ConfigBlock title={t("zconfig.systemNetwork")} divided>
            <ConfigRow label={t("zconfig.systemSsid")} value={net?.ssid ?? PLACEHOLDER} />
            <ConfigRow
              label={t("zconfig.systemAddresses")}
              value={net?.addresses.length ? net.addresses.join(", ") : PLACEHOLDER}
            />
            <ConfigRow
              label={t("zconfig.systemSpeed")}
              value={
                net == null
                  ? PLACEHOLDER
                  : `↓ ${fmtRate(net.rxBytesPerS)} · ↑ ${fmtRate(net.txBytesPerS)}`
              }
            />
          </ConfigBlock>

          <ConfigBlock title={t("zconfig.systemProcesses")} divided>
            <ConfigRow
              label={t("zconfig.systemHubProc")}
              value={`v${stats.hub.version} · ${fmtUptime(stats.hub.uptimeS)}`}
              hint={`${fmtBytes(stats.processes.hub.rssBytes)}${
                stats.processes.hub.cpuPct != null
                  ? ` · CPU ${stats.processes.hub.cpuPct}%`
                  : ""
              } · pid ${stats.processes.hub.pid}`}
            />
            {stats.processes.bridges.length === 0 ? (
              <ConfigRow
                label={t("zconfig.systemBridges")}
                value={t("zconfig.systemBridgesEmpty")}
              />
            ) : (
              stats.processes.bridges.map((b) => (
                <ConfigRow
                  key={b.id}
                  label={
                    b.workspace
                      ? (b.workspace.split("/").filter(Boolean).pop() ?? b.workspace)
                      : b.id
                  }
                  value={
                    b.rssBytes == null
                      ? PLACEHOLDER
                      : `${fmtBytes(b.rssBytes)}${b.cpuPct != null ? ` · ${b.cpuPct}%` : ""}`
                  }
                  hint={`bridge · pid ${b.pid ?? "?"}`}
                />
              ))
            )}
          </ConfigBlock>

          <p className="px-4 pb-2 pt-3 text-[11px] text-faint">
            {t("zconfig.systemCollected", { time: fmtStamp(stats.collectedAt) })}
          </p>
        </>
      )}
    </ConfigPageFrame>
  );
}

export type { SystemStatsResponse };

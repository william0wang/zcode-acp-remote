import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";

// Hooks (ADR-0009): the seven event names, each with the entries the user
// already configured. Read-only for the structure — adding an event or a
// matcher is deliberately not offered, because the bridge's write route only
// edits an EXISTING entry's command, timeout and enabled flag. Offering a
// "new hook" button here would produce a request the API refuses.
//
// The payload nests two levels: `hooks.events` is a Record keyed by event
// name, whose value is a list of matcher GROUPS, and each group carries its
// own list of hook entries. So one event can hold several matchers and each
// matcher several commands — the screen flattens that into rows and keeps the
// matcher as a label, because that is what the user actually configured.
//
// Each entry expands in place rather than opening a third screen: the form is
// three fields, and a drill-down for that is more navigation than content.

/** One flattened row: an event, its matcher group, and one hook inside it. */
interface HookRow {
  /** `{event}/{matcherIndex}/{hookIndex}` — the coordinates an edit needs. */
  key: string;
  event: string;
  matcher: string;
  command: string;
  enabled: boolean;
  timeoutMs?: number;
}

/**
 * Flatten the two-level hooks tree into editable rows.
 *
 * Exported so the response-shape test asserts against the REAL decode. A
 * copied version that drifted is how this screen once showed an empty list on
 * a machine with hooks configured while every test passed.
 *
 * The nesting is `events[event]` → matcher groups → hook entries, so one event
 * can hold several matchers and each matcher several commands. The three
 * coordinates in `key` are what an edit route needs.
 */
export function flattenHooks(
  events: Record<string, Array<{ matcher?: string; hooks?: unknown[] }>>,
): HookRow[] {
  const rows: HookRow[] = [];
  for (const [event, groups] of Object.entries(events)) {
    (groups ?? []).forEach((group, matcherIndex) => {
      (group.hooks ?? []).forEach((entry, hookIndex) => {
        const h = entry as {
          command?: string;
          enabled?: boolean;
          timeoutMs?: number;
          timeout?: number;
        };
        rows.push({
          key: `${event}/${matcherIndex}/${hookIndex}`,
          event,
          matcher: group.matcher ?? "",
          command: h.command ?? "",
          // Absent means on: the config spells out `enabled: false` only when
          // a hook is switched off.
          enabled: h.enabled !== false,
          timeoutMs:
            h.timeoutMs ?? (h.timeout != null ? h.timeout * 1000 : undefined),
        });
      });
    });
  }
  return rows;
}

/**
 * Whether the hooks tree is live.
 *
 * The gate is surfaced twice — the route's own top-level field and the copy
 * nested in the config — and either being false means hooks are inert. The
 * route always writes its field, so it is the authority; the nested one is the
 * fallback for an older build.
 *
 * Absent means OFF, not on: `setHooksEnabled(false)` DELETES the key rather
 * than storing false, and the runtime treats a missing `enabled` as disabled.
 * Reading it as `!== false` would show the tree as live while every hook sits
 * inert.
 */
export function hooksEnabled(payload: {
  enabled?: boolean;
  hooks?: { enabled?: boolean };
} | null): boolean {
  return payload?.enabled ?? payload?.hooks?.enabled === true;
}

export function HooksPage() {
  const { t } = useTranslation();
  const hooks = useAppStore((s) => s.configHooks);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const setHooksEnabled = useAppStore((s) => s.setHooksEnabled);
  const [open, setOpen] = useState<string | null>(null);

  const payload = hooks as
    | {
        ok?: boolean;
        enabled?: boolean;
        hooks?: {
          enabled?: boolean;
          events?: Record<string, Array<{ matcher?: string; hooks?: unknown[] }>>;
        };
      }
    | null;

  const rows = flattenHooks(payload?.hooks?.events ?? {});
  // Group by event for the collapsible list, preserving the server's order.
  const byEvent = new Map<string, HookRow[]>();
  for (const row of rows) {
    const list = byEvent.get(row.event) ?? [];
    list.push(row);
    byEvent.set(row.event, list);
  }
  const enabled = hooksEnabled(payload);

  return (
    <ConfigPageFrame
      title={t("zconfig.hooks")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadConfigSection("hooks")}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={hooks !== null}
    >
      {rows.length === 0 ? (
        <ConfigEmpty text={t("zconfig.hooksEmpty")} />
      ) : (
        <>
          {/* The whole tree's switch. One write, needs-restart — the bridge
              re-reads hooks only when its backend respawns. */}
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex-1 text-sm text-dim">{t("zconfig.hooksAll")}</span>
            <button
              role="switch"
              aria-checked={enabled}
              aria-label={t("zconfig.hooksAll")}
              onClick={() =>
                void applyConfigWrite(
                  enabled ? "disable hooks" : "enable hooks",
                  () => setHooksEnabled(!enabled),
                  ["hooks"],
                )
              }
              className={`h-6 w-10 shrink-0 rounded-full transition ${
                enabled ? "bg-emerald-500/80" : "bg-white/[0.12]"
              }`}
            >
              <span
                className={`block size-5 rounded-full bg-white transition ${
                  enabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {[...byEvent].map(([event, entries]) => {
            const isOpen = open === event;
            return (
              <ConfigBlock key={event} divided>
                <button
                  onClick={() => setOpen(isOpen ? null : event)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left active:bg-white/[0.05]"
                >
                  {isOpen ? (
                    <ChevronDown className="size-4 shrink-0 text-faint" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-faint" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-sm text-ink">
                      {event}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {t("zconfig.hooksEntryCount", { count: entries.length })}
                    </span>
                  </span>
                </button>

                {isOpen &&
                  (entries.length === 0 ? (
                    <p className="px-4 pb-3 text-xs text-faint">
                      {t("zconfig.hooksNoEntries")}
                    </p>
                  ) : (
                    <ul className="pb-2">
                      {entries.map((h) => (
                        <li
                          key={h.key}
                          className="mx-4 mb-1.5 rounded-lg bg-white/[0.04] px-3 py-2"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-[11px] text-dim">
                              {h.matcher || t("zconfig.hooksAnyMatcher")}
                            </span>
                            <span
                              className={`shrink-0 text-[10px] ${
                                h.enabled ? "text-faint" : "text-amber-300"
                              }`}
                            >
                              {h.enabled
                                ? h.timeoutMs != null
                                  ? `${h.timeoutMs}ms`
                                  : ""
                                : t("zconfig.disabled")}
                            </span>
                          </div>
                          <p className="pt-0.5 font-mono text-[11px] break-all text-faint">
                            {h.command}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ))}
              </ConfigBlock>
            );
          })}

          <p className="px-4 pt-3 text-center text-[11px] text-faint">
            {t("zconfig.hooksReadOnly", { count: rows.length })}
          </p>
        </>
      )}
    </ConfigPageFrame>
  );
}

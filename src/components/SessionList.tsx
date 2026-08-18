import { useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { fmtRelative } from "../lib/time";

// Shared flat session list (drawer + entry screen): search field, per-session
// activity badge, relative time.

export interface SessionRowItem {
  sessionId: string;
  instanceId: string;
  title?: string;
  updatedAt?: number;
  workspace?: string;
}

// Session Activity (CONTEXT.md): awaiting confirmation > running > just
// finished (60s window) > idle. Broadcast-only, so idle is the default.
function ActivityBadge({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const activity = useAppStore((s) => s.sessionStates[sessionId]);
  // Re-render once the just-finished window lapses (no store event for it).
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!activity?.finishedAt) return;
    const remain = 60_000 - (Date.now() - activity.finishedAt);
    if (remain <= 0) return;
    const id = setTimeout(force, remain + 100);
    return () => clearTimeout(id);
  }, [activity?.finishedAt]);

  if (!activity) return null;
  if (activity.awaitingPermission) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-400">
        <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
        {t("chat.activityAwaiting")}
      </span>
    );
  }
  if (activity.running) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-400">
        <span className="size-1.5 animate-pulse rounded-full bg-blue-400" />
        {t("chat.activityRunning")}
      </span>
    );
  }
  if (activity.finishedAt && Date.now() - activity.finishedAt < 60_000) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-emerald-400">
        {t("chat.activityFinished")}
      </span>
    );
  }
  return null;
}

function baseName(path: string | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function SessionRow({
  item,
  active,
  disabled,
  onSelect,
}: {
  item: SessionRowItem;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`flex w-full flex-col px-4 py-3 text-left disabled:opacity-50 ${
        active ? "bg-white/[0.07]" : "active:bg-white/[0.05]"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${active ? "font-medium text-ink" : "text-dim"}`}
        >
          {item.title || t("chat.untitled")}
        </span>
        <ActivityBadge sessionId={item.sessionId} />
      </span>
      <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-faint">
        <span className="min-w-0 truncate">{baseName(item.workspace)}</span>
        {item.updatedAt && (
          <span className="shrink-0 tabular-nums">
            {fmtRelative(item.updatedAt, i18n.language)}
          </span>
        )}
      </span>
    </button>
  );
}

export function SessionList({
  sessions,
  activeKey,
  connecting,
  onSelect,
  emptyHint,
}: {
  sessions: SessionRowItem[];
  activeKey: string | null;
  connecting?: boolean;
  onSelect: (instanceId: string, sessionId: string) => void;
  emptyHint: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        baseName(s.workspace).toLowerCase().includes(q),
    );
  }, [sessions, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-raised px-3 py-2 ring-1 ring-inset ring-hairline">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chat.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="mt-8 text-center text-sm text-faint">
            {sessions.length === 0 ? emptyHint : t("chat.noMatches")}
          </p>
        )}
        {filtered.map((s) => (
          <SessionRow
            key={`${s.instanceId}:${s.sessionId}`}
            item={s}
            active={activeKey === `${s.instanceId}:${s.sessionId}`}
            disabled={connecting}
            onSelect={() => onSelect(s.instanceId, s.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

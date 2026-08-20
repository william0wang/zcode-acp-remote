import { useEffect, useMemo, useReducer, useRef, useState } from "react";
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
  // Coarse "running" | "idle" from the hub heartbeat (REST) — used when no
  // instance connection exists to feed the live broadcast-based activity.
  status?: string;
}

// Session Activity (CONTEXT.md): awaiting confirmation > running > just
// finished (60s window) > idle. Broadcast-only, so idle is the default.
// `restRunning` is the heartbeat fallback (ADR-0005) for list rows seen
// without any instance connection — coarse and up to ~10s stale.
function ActivityBadge({
  sessionId,
  restRunning,
}: {
  sessionId: string;
  restRunning?: boolean;
}) {
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

  if (!activity) {
    if (restRunning) {
      return (
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-400">
          <span className="size-1.5 animate-pulse rounded-full bg-blue-400" />
          {t("chat.activityRunning")}
        </span>
      );
    }
    return null;
  }
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

// Long-press (H5-friendly retire gesture, ADR-0006): a pointerdown timer
// cancelled by movement (scroll intent) or release. Spread onto the row.
// The trailing click after a fired long-press is swallowed, else releasing
// the finger would also open the session.
function useLongPress(onLongPress: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (!o || !timer.current) return;
      if (Math.abs(e.clientX - o.x) > 10 || Math.abs(e.clientY - o.y) > 10)
        clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      e.preventDefault();
      e.stopPropagation();
      fired.current = false;
    },
    // Suppress the WebView's own long-press menu alongside ours.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

function SessionRow({
  item,
  active,
  disabled,
  onSelect,
  onLongPress,
}: {
  item: SessionRowItem;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onLongPress: () => void;
}) {
  const { t, i18n } = useTranslation();
  const press = useLongPress(onLongPress);
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      {...press}
      className={`flex w-full flex-col px-4 py-3 text-left select-none [-webkit-touch-callout:none] disabled:opacity-50 ${
        active ? "bg-white/[0.07]" : "active:bg-white/[0.05]"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${active ? "font-medium text-ink" : "text-dim"}`}
        >
          {item.title || t("chat.untitled")}
        </span>
        <ActivityBadge
          sessionId={item.sessionId}
          restRunning={item.status === "running"}
        />
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
  const [retireTarget, setRetireTarget] = useState<SessionRowItem | null>(null);
  const closeRemoteSession = useAppStore((s) => s.closeRemoteSession);

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
            onLongPress={() => setRetireTarget(s)}
          />
        ))}
      </div>

      {retireTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]"
          onClick={() => setRetireTarget(null)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl border border-hairline bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4">
              <h2 className="text-sm font-semibold text-ink">
                {retireTarget.title || t("chat.untitled")}
              </h2>
              <p className="mt-1 text-xs text-faint">
                {t("chat.closeSessionHint")}
              </p>
            </div>
            <div className="flex flex-col gap-2 px-4 pb-4 pt-3">
              <button
                onClick={() => {
                  const { instanceId, sessionId } = retireTarget;
                  setRetireTarget(null);
                  void closeRemoteSession(instanceId, sessionId);
                }}
                className="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-400 ring-1 ring-inset ring-red-500/40 active:bg-red-500/20"
              >
                {t("chat.closeSession")}
              </button>
              <button
                onClick={() => setRetireTarget(null)}
                className="rounded-xl bg-raised px-4 py-3 text-sm font-medium text-ink ring-1 ring-inset ring-hairline active:bg-white/[0.08]"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

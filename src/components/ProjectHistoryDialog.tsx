import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, History, Loader2, Search } from "lucide-react";
import { HubApiError, HubClient } from "../lib/hub";
import type {
  HubHistoryCursor,
  HubHistorySession,
  HubProject,
} from "../lib/types";
import { fmtRelative } from "../lib/time";
import { useAppStore } from "../store/appStore";
import { SessionList, type SessionRowItem } from "./SessionList";
import { projectName } from "./ProjectCreateDialog";

// Per-project session history (bridge 0.19.0, ADR-0015): browse a project's
// backend session store — closed conversations included — and resume one
// with a tap. Two surfaces, deliberately not reconciled (ADR-0015 §5):
// discovery stays the live-attention list, this is the browse/resume one,
// so the same conversation may appear in both under different ids.
// The listing is fetched strictly on demand for the chosen project: a cold
// project's first page incubates its serve bridge (~12s), so prefetching
// every project would spawn bridges for all of them.

export function ProjectHistoryDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const profile = useAppStore((s) => s.profile);
  const resumeProjectSession = useAppStore((s) => s.resumeProjectSession);

  // Project chooser state.
  const [projects, setProjects] = useState<HubProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // Session list state: accumulated pages + the server's composite cursor.
  const [rows, setRows] = useState<HubHistorySession[] | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [cursor, setCursor] = useState<HubHistoryCursor | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);

  // Invalidates in-flight listing responses across view switches (back /
  // another project): a late page must never land in the wrong list — its
  // cursor would corrupt the new project's pagination.
  const listSeq = useRef(0);

  useEffect(() => {
    if (!profile) return;
    const client = new HubClient(profile.hubUrl, profile.token);
    let alive = true;
    client
      .projects()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch((e) => {
        if (!alive) return;
        setError(`projects: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      alive = false;
    };
  }, [profile]);

  const describeListError = (e: unknown): string => {
    if (e instanceof HubApiError) {
      // Older bridge (<0.19.0): the route doesn't exist.
      if (e.status === 404) return t("historyDialog.tooOld");
      // The project dropped off the known list — refresh and re-pick.
      if (e.status === 403) return t("notice.projectUnknown");
    }
    return `history: ${e instanceof Error ? e.message : String(e)}`;
  };

  const openProject = async (workspacePath: string) => {
    if (!profile || loadingPage) return;
    const mySeq = ++listSeq.current;
    setSelected(workspacePath);
    setRows(null);
    setCursor(null);
    setListError(null);
    setLoadingPage(true);
    const client = new HubClient(profile.hubUrl, profile.token);
    try {
      // A cold project blocks ~12s while the hub incubates its serve bridge
      // — no client-side timeout, the spinner owns the wait.
      const page = await client.projectSessions(workspacePath);
      if (listSeq.current !== mySeq) return;
      setRows(page.sessions);
      setInstanceId(page.instance.id);
      setCursor(page.nextCursor);
    } catch (e) {
      if (listSeq.current !== mySeq) return;
      setListError(describeListError(e));
    } finally {
      if (listSeq.current === mySeq) setLoadingPage(false);
    }
  };

  const loadMore = async () => {
    if (!profile || !selected || !cursor || loadingMore) return;
    // NOT incremented: this view owns the sequence until back/openProject.
    const mySeq = listSeq.current;
    setLoadingMore(true);
    setListError(null);
    const client = new HubClient(profile.hubUrl, profile.token);
    try {
      // The cursor rides verbatim — recomputing it from the last row's
      // updatedAt (an ISO string) would drop rows tied across the boundary.
      const page = await client.projectSessions(selected, cursor);
      if (listSeq.current !== mySeq) return;
      setRows((prev) => [...(prev ?? []), ...page.sessions]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (listSeq.current !== mySeq) return;
      setListError(describeListError(e));
    } finally {
      if (listSeq.current === mySeq) setLoadingMore(false);
    }
  };

  const resume = async (sessionId: string) => {
    if (resuming || !selected) return;
    setResuming(sessionId);
    setListError(null);
    await resumeProjectSession(selected, sessionId);
    // Success swaps the route to ChatScreen and unmounts this dialog with
    // the picker. Failure sets `notice` — surface it HERE as well: this
    // dialog's full-screen overlay hides the picker's notice banner.
    if (useAppStore.getState().activeSessionId) return;
    const n = useAppStore.getState().notice;
    if (n) {
      setListError(n.startsWith("notice.") ? t(n) : n);
      // Consumed here — don't repeat it on the picker banner after close.
      useAppStore.getState().dismissNotice();
    }
    setResuming(null);
  };

  const back = () => {
    // A load-more still in flight belongs to the view we are leaving.
    listSeq.current++;
    setSelected(null);
    setRows(null);
    setCursor(null);
    setListError(null);
  };

  const items: SessionRowItem[] = useMemo(
    () =>
      (rows ?? []).map((s) => ({
        sessionId: s.sessionId,
        instanceId,
        title: s.title,
        // The listing's updatedAt is an ISO string; rows render epoch ms.
        updatedAt: s.updatedAt
          ? Date.parse(s.updatedAt) || undefined
          : undefined,
        workspace: s.cwd,
        status: s.running ? "running" : undefined,
      })),
    [rows, instanceId],
  );

  const visible = (projects ?? []).filter((p) =>
    p.workspacePath.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="flex items-center gap-2 px-4 pt-3">
          {selected ? (
            <button
              onClick={back}
              disabled={resuming !== null}
              aria-label={t("files.back")}
              className="-ml-1 flex size-6 items-center justify-center rounded-full text-dim active:bg-white/[0.06] disabled:opacity-50"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <History className="size-4 shrink-0 text-cyan-400" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {selected ? projectName(selected) : t("historyDialog.title")}
          </h2>
          <button onClick={onClose} className="text-faint" aria-label="close">
            ✕
          </button>
        </div>
        <p className="px-4 pt-1 text-xs text-faint">
          {selected
            ? resuming
              ? // Resume POST may incubate the project's serve bridge —
                // same visible-terminal-window behavior as session-create.
                t("projectDialog.creatingHint")
              : t("historyDialog.listHint")
            : t("historyDialog.hint")}
        </p>

        {selected ? (
          rows === null ? (
            <div className="min-h-0 flex-1 px-4 py-8">
              {listError ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="rounded-lg bg-amber-950 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-900">
                    {listError}
                  </p>
                  <button
                    onClick={() => void openProject(selected)}
                    className="rounded-xl bg-raised px-4 py-2 text-xs font-medium text-ink ring-1 ring-inset ring-hairline active:bg-white/[0.08]"
                  >
                    {t("historyDialog.retry")}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-xs text-faint">
                  <Loader2 className="size-4 animate-spin" />
                  {t("historyDialog.waking")}
                </div>
              )}
            </div>
          ) : (
            <>
              {listError && (
                <p className="mx-4 mb-1 shrink-0 rounded-lg bg-amber-950 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-900">
                  {listError}
                </p>
              )}
              <SessionList
                sessions={items}
                activeKey={null}
                connecting={resuming !== null}
                onSelect={(_instanceId, sessionId) => void resume(sessionId)}
                emptyHint={t("historyDialog.listEmpty")}
                readOnly
                footer={
                  cursor ? (
                    <button
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                      className="mx-auto mb-3 mt-1 flex items-center gap-2 rounded-xl bg-raised px-4 py-2 text-xs font-medium text-dim ring-1 ring-inset ring-hairline active:bg-white/[0.08] disabled:opacity-50"
                    >
                      {loadingMore && (
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      {t(
                        loadingMore
                          ? "historyDialog.loadingMore"
                          : "historyDialog.loadMore",
                      )}
                    </button>
                  ) : items.length > 0 ? (
                    <p className="py-3 text-center text-[10px] text-faint">
                      {t("historyDialog.end")}
                    </p>
                  ) : null
                }
              />
            </>
          )
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-2">
              <Search className="size-3.5 shrink-0 text-faint" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("historyDialog.filter")}
                className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {error && (
                <p className="mx-2 rounded-lg bg-amber-950 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-900">
                  {error}
                </p>
              )}
              {!projects && !error && (
                <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-faint">
                  <Loader2 className="size-4 animate-spin" />
                  {t("historyDialog.loading")}
                </div>
              )}
              {projects && visible.length === 0 && !error && (
                <p className="px-4 py-6 text-center text-xs text-faint">
                  {t("historyDialog.empty")}
                </p>
              )}
              {visible.map((p) => (
                <button
                  key={p.workspacePath}
                  onClick={() => void openProject(p.workspacePath)}
                  disabled={loadingPage}
                  className="mb-1 flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left active:bg-white/[0.05] disabled:opacity-50"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {projectName(p.workspacePath)}
                    </span>
                    <span className="shrink-0 text-[10px] text-faint">
                      {t("projectDialog.sessionCount", { count: p.sessions })}
                    </span>
                  </span>
                  <span className="flex w-full items-center gap-2 text-[10px] text-faint">
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {p.workspacePath}
                    </span>
                    <span className="shrink-0">
                      {fmtRelative(p.lastActive, i18n.language)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

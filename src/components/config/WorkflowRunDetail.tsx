import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useBackHandler } from "../../lib/backNav";
import { useAppStore } from "../../store/appStore";
import { MarkdownText } from "../Markdown";
import type {
  ConversationRunSummary,
  WorkflowArtifact,
  WorkflowNodeSummary,
  WorkflowRunEvent,
  WorkflowWorkspaceNode,
} from "../../lib/types";
import { ConfigBlock, ConfigEmpty, fmtStamp } from "./ConfigPage";

// One workflow run's detail view (bridge 0.48.0, ADR-0029): the journal
// events, the artifacts, and the workspace nodes the backend's v4 queries
// expose — everything the chat progress card deliberately compresses.
//
// Live-ness is polling, not push: the journal cursor (`afterSequence`) never
// invalidates, so a 3s tick while the run is active appends only the new
// lines, and a settled run costs exactly one fetch per tab.

/** Badge palette for a run/node status token (unknown tokens fall back gray). */
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-white/[0.08] text-dim",
  running: "bg-sky-500/20 text-sky-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  errored: "bg-red-500/20 text-red-300",
  failed: "bg-red-500/20 text-red-300",
  stopped: "bg-amber-500/20 text-amber-300",
  cancelled: "bg-amber-500/20 text-amber-300",
  ok: "bg-emerald-500/20 text-emerald-300",
  waiting: "bg-white/[0.08] text-dim",
  queued: "bg-white/[0.08] text-dim",
  dispatched: "bg-sky-500/20 text-sky-300",
  executing: "bg-sky-500/20 text-sky-300",
  settled: "bg-emerald-500/20 text-emerald-300",
};

export function StatusBadge({ status }: { status?: string }) {
  const token = status ?? "";
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
        STATUS_STYLE[token] ?? "bg-white/[0.08] text-dim"
      }`}
    >
      {token || "?"}
    </span>
  );
}

/** Pretty JSON for the structured viewers, capped so a huge payload cannot wedge the DOM. */
const JSON_CAP = 20_000;
export function prettyJson(value: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2) ?? "null";
    } catch {
      return String(value);
    }
  })();
  return text.length > JSON_CAP ? text.slice(0, JSON_CAP) + "\n…" : text;
}

/** The newest version number an artifact advertises (top level or versions[]). */
function latestVersion(a: WorkflowArtifact): number {
  const vs = a.versions ?? [];
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = Number(vs[i]?.["version"]);
    if (Number.isInteger(v)) return v;
  }
  const top = Number(a.version);
  return Number.isInteger(top) ? top : 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The node summary line. `summary` is a strict object upstream — rendering it
 * as a React child would throw "Objects are not valid as a React child" and
 * take the whole app down, so it must be flattened to text here.
 */
function nodeSummaryText(s: WorkflowNodeSummary): string {
  const parts: string[] = [];
  if (s.resultCount !== undefined) parts.push(`${s.resultCount}`);
  if (s.exitCode !== undefined) parts.push(`exit ${s.exitCode}`);
  if (s.stdoutBytes !== undefined)
    parts.push(`out ${formatBytes(s.stdoutBytes)}`);
  if (s.stderrBytes !== undefined)
    parts.push(`err ${formatBytes(s.stderrBytes)}`);
  if (s.resultBytes !== undefined) parts.push(formatBytes(s.resultBytes));
  return parts.join(" · ");
}

/** Cap the chunk ask: ≤512KiB is the upstream per-read maximum anyway. */
const READ_CHUNK = 256 * 1024;

type Tab = "events" | "artifacts" | "workspace";

export function WorkflowRunDetail({
  instanceId,
  sessionId,
  runId,
  title,
  onBack,
}: {
  instanceId: string;
  sessionId: string;
  runId: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const workflowAction = useAppStore((s) => s.workflowAction);
  const resumeWorkflowRun = useAppStore((s) => s.resumeWorkflowRun);
  const [tab, setTab] = useState<Tab>("events");
  const [summary, setSummary] = useState<ConversationRunSummary | null>(null);
  const [events, setEvents] = useState<WorkflowRunEvent[] | null>(null);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [artifacts, setArtifacts] = useState<WorkflowArtifact[] | null>(null);
  const [nodes, setNodes] = useState<WorkflowWorkspaceNode[] | null>(null);
  const [openArtifact, setOpenArtifact] = useState<WorkflowArtifact | null>(
    null,
  );
  const [nodeResult, setNodeResult] = useState<{
    key: string;
    status?: string;
    body: string;
    truncated?: boolean;
  } | null>(null);
  // Set when the polls stop believing the session is reachable: the launch
  // memory went stale (bridge restart, closed session) and every tick would
  // fail. The view degrades to a read-only notice instead of erroring forever.
  const [sessionDead, setSessionDead] = useState(false);
  // One fetch at a time: a manual "Load more" racing the 3s tick would read
  // the SAME afterSequence from two closures and append the batch twice.
  const eventsInFlight = useRef(false);
  const failCount = useRef(0);

  useBackHandler(() => {
    if (openArtifact || nodeResult) {
      setOpenArtifact(null);
      setNodeResult(null);
      return true;
    }
    onBack();
    return true;
  });

  const refreshSummary = useCallback(
    async (silent = false) => {
      const res = await workflowAction(
        "load run status",
        (c) => c.conversationRuns(instanceId, sessionId),
        silent,
      );
      if (res) setSummary(res.runs.find((r) => r.runId === runId) ?? null);
      return res !== null;
    },
    [workflowAction, instanceId, sessionId, runId],
  );

  const fetchEvents = useCallback(
    async (initial: boolean, silent = false) => {
      if (eventsInFlight.current) return;
      eventsInFlight.current = true;
      setEventsBusy(true);
      const after = initial
        ? undefined
        : (events?.[events.length - 1]?.sequence ?? undefined);
      const res = await workflowAction(
        "load run events",
        (c) => c.runEvents(instanceId, sessionId, runId, after),
        silent,
      );
      eventsInFlight.current = false;
      setEventsBusy(false);
      if (!res) return;
      if (initial) setEvents(res.events);
      else setEvents((prev) => [...(prev ?? []), ...res.events]);
      setHasMore(res.hasMore === true);
    },
    [workflowAction, instanceId, sessionId, runId, events],
  );

  // First paint: summary + the journal's head. (The mount effect in
  // ZCodeConfigScreen does not reach this component — it is not a section.)
  useEffect(() => {
    void refreshSummary();
    void fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while the run is unsettled. `summary === null` also polls: an
  // unknown status is not proof of completion. The tick is silent — a dead
  // session announces itself once below, not once per tick — and two
  // consecutive failed ticks retire the poller entirely (read-only view).
  const active =
    !sessionDead &&
    (summary === null ||
      summary.status === "running" ||
      summary.status === "pending");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(async () => {
      const ok = await refreshSummary(true);
      // `events === null` means the first pull failed — pull from the head
      // again instead of skipping forever (eventsInFlight makes the overlap
      // with a still-running earlier pull safe).
      await fetchEvents(events === null, true);
      if (ok) {
        failCount.current = 0;
      } else if (++failCount.current >= 2) {
        setSessionDead(true);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [active, refreshSummary, fetchEvents, events]);

  // Tabs load lazily — the journal is the default view, artifacts and the
  // workspace only cost a request once they are opened.
  useEffect(() => {
    if (tab === "artifacts" && artifacts === null) {
      void workflowAction("load artifacts", (c) =>
        c.runArtifacts(instanceId, sessionId, runId),
      ).then((res) =>
        setArtifacts((res?.artifacts as WorkflowArtifact[]) ?? []),
      );
    }
    if (tab === "workspace" && nodes === null) {
      void workflowAction("load workspace", (c) =>
        c.runWorkspace(instanceId, sessionId, runId),
      ).then((res) => setNodes(res?.nodes ?? []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function resume() {
    const ok = await resumeWorkflowRun({ runId, sessionId });
    if (ok) void refreshSummary();
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "events", label: t("zconfig.workflowEvents") },
    { id: "artifacts", label: t("zconfig.workflowArtifacts") },
    { id: "workspace", label: t("zconfig.workflowWorkspace") },
  ];

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-[max(var(--safe-top),0.75rem)]">
        <button
          onClick={() => {
            setOpenArtifact(null);
            setNodeResult(null);
            onBack();
          }}
          aria-label={t("common.close")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <ArrowLeft className="size-4.5" />
        </button>
        <span className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          <p className="flex items-center gap-1.5 text-[11px] text-faint">
            <StatusBadge status={summary?.status} />
            {summary?.updatedAt ? fmtStamp(summary.updatedAt) : ""}
            {summary?.failureMessage ? ` · ${summary.failureMessage}` : ""}
          </p>
        </span>
        {summary?.resumable && (
          <button
            onClick={() => void resume()}
            className="shrink-0 rounded-lg bg-sky-500/20 px-2.5 py-1.5 text-[11px] font-medium text-sky-300"
          >
            {t("zconfig.workflowResume")}
          </button>
        )}
      </header>

      <div className="flex shrink-0 gap-1 px-4 pb-2">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs ${
              tab === id
                ? "bg-white/[0.1] font-medium text-ink"
                : "text-dim active:bg-white/[0.05]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pb-[max(var(--safe-bottom),1rem)]">
        {sessionDead && (
          <p className="mx-4 mb-2 rounded-xl bg-surface px-4 py-3 text-xs text-amber-300 ring-1 ring-hairline">
            {t("zconfig.workflowSessionLost")}
          </p>
        )}
        {tab === "events" && (
          <>
            {events !== null && events.length === 0 ? (
              <ConfigEmpty text={t("zconfig.workflowEventsEmpty")} />
            ) : (
              <div className="px-4">
                {(events ?? []).map((ev) => (
                  <EventRow key={ev.sequence} ev={ev} />
                ))}
                {events === null && !sessionDead && !active && (
                  <button
                    onClick={() => void fetchEvents(true)}
                    disabled={eventsBusy}
                    className="mb-4 w-full rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
                  >
                    {t("zconfig.workflowRetry")}
                  </button>
                )}
                {events === null && !sessionDead && active && (
                  <div className="flex justify-center py-8">
                    <RefreshCw className="size-5 animate-spin text-faint" />
                  </div>
                )}
                {hasMore && events !== null && (
                  <button
                    onClick={() => void fetchEvents(false)}
                    disabled={eventsBusy}
                    className="mb-4 w-full rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
                  >
                    {t("zconfig.workflowLoadMore")}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {tab === "artifacts" && (
          <>
            {artifacts !== null && artifacts.length === 0 ? (
              <ConfigEmpty text={t("zconfig.workflowArtifactsEmpty")} />
            ) : (
              <ConfigBlock>
                {(artifacts ?? []).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setOpenArtifact(a)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-white/[0.05]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">
                        {a.title ?? a.id}
                      </span>
                      <span className="block text-[11px] text-faint">
                        {a.kind}
                        {a.versions?.length ? ` · v${latestVersion(a)}` : ""}
                        {a.itemCount !== undefined ? ` · ${a.itemCount}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </ConfigBlock>
            )}
          </>
        )}

        {tab === "workspace" && (
          <>
            {nodes !== null && nodes.length === 0 ? (
              <ConfigEmpty text={t("zconfig.workflowWorkspaceEmpty")} />
            ) : (
              <ConfigBlock>
                {(nodes ?? []).map((n, i) => {
                  const key = `${n.siteId ?? "?"}:${n.ordinal ?? i}`;
                  return (
                    <div key={key} className="px-4 py-3">
                      <button
                        onClick={() => void loadNode(key, n)}
                        className="flex w-full items-baseline gap-2 text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-xs text-ink">
                            {n.op ?? key}
                          </span>
                          {n.summary && (
                            <span className="block truncate text-[11px] text-faint">
                              {nodeSummaryText(n.summary)}
                            </span>
                          )}
                        </span>
                        <StatusBadge status={n.status} />
                      </button>
                      {nodeResult?.key === key && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-raised p-3 font-mono text-[11px] leading-relaxed text-dim ring-1 ring-hairline">
                          {nodeResult.body}
                          {nodeResult.truncated ? "\n…" : ""}
                        </pre>
                      )}
                    </div>
                  );
                })}
                {nodes?.length || sessionDead ? null : (
                  <div className="flex justify-center py-8">
                    <RefreshCw className="size-5 animate-spin text-faint" />
                  </div>
                )}
              </ConfigBlock>
            )}
          </>
        )}
      </div>

      {openArtifact && (
        <ArtifactViewer
          instanceId={instanceId}
          sessionId={sessionId}
          runId={runId}
          artifact={openArtifact}
          onBack={() => setOpenArtifact(null)}
        />
      )}
    </div>
  );

  async function loadNode(key: string, n: WorkflowWorkspaceNode) {
    if (nodeResult?.key === key) {
      setNodeResult(null);
      return;
    }
    if (n.siteId === undefined || n.ordinal === undefined) return;
    const res = await workflowAction("load node result", (c) =>
      c.runNodeResult(instanceId, sessionId, runId, n.siteId!, n.ordinal!),
    );
    if (!res) return;
    setNodeResult({
      key,
      status: res.status,
      body:
        res.error !== undefined && res.error !== null
          ? prettyJson(res.error)
          : prettyJson(res.result),
      truncated: res.truncated,
    });
  }
}

/** One journal row: sequence + type, payload expandable in place. */
function EventRow({ ev }: { ev: WorkflowRunEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-hairline py-2 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
          #{ev.sequence}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-dim">
          {ev.type}
        </span>
      </button>
      {open && (
        <pre className="mt-1.5 max-h-72 overflow-auto rounded-xl bg-raised p-3 font-mono text-[11px] leading-relaxed text-dim ring-1 ring-hairline">
          {prettyJson(ev.payload)}
        </pre>
      )}
    </div>
  );
}

/** Read-only full-screen shell for one artifact (back gesture included). */
function ViewerShell({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useBackHandler(() => {
    onBack();
    return true;
  });
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-[max(var(--safe-top),0.75rem)]">
        <button
          onClick={onBack}
          aria-label={t("common.close")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
        >
          <ArrowLeft className="size-4.5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {title}
        </h1>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-[max(var(--safe-bottom),1rem)]">
        {children}
      </div>
    </div>
  );
}

/**
 * One artifact, by kind: markdown renders (the shared renderer), text files
 * stream in chunks, boards paginate their items, and every other structured
 * kind falls back to a pretty JSON view of its top-level fields.
 */
function ArtifactViewer({
  instanceId,
  sessionId,
  runId,
  artifact,
  onBack,
}: {
  instanceId: string;
  sessionId: string;
  runId: string;
  artifact: WorkflowArtifact;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const workflowAction = useAppStore((s) => s.workflowAction);
  const [busy, setBusy] = useState(true);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [boardItems, setBoardItems] = useState<string | null>(null);
  const [boardHasMore, setBoardHasMore] = useState(false);
  const [boardCursor, setBoardCursor] = useState<number | null>(null);
  // One decoder per artifact, in streaming mode: a chunk boundary can split
  // a multi-byte UTF-8 character, and per-chunk decoding would turn each
  // split into U+FFFD on both sides.
  const decoderRef = useRef<TextDecoder | null>(null);

  const kind = artifact.kind;
  // Structured kinds render from the inventory row itself — no extra fetch.
  const structured = kind !== "markdown" && kind !== "file" && kind !== "board";

  const loadChunk = useCallback(
    async (offset: number, append: boolean) => {
      setBusy(true);
      const res = await workflowAction("read artifact", (c) =>
        c.runArtifactRead(
          instanceId,
          sessionId,
          runId,
          artifact.id,
          latestVersion(artifact),
          offset,
          READ_CHUNK,
        ),
      );
      setBusy(false);
      if (!res) return;
      setTotalBytes(res.totalBytes ?? null);
      setNextOffset(res.nextOffset ?? null);
      try {
        const bin = atob(res.dataBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        decoderRef.current ??= new TextDecoder("utf-8");
        const chunk = decoderRef.current.decode(bytes, { stream: true });
        setText((prev) => (append ? (prev ?? "") + chunk : chunk));
      } catch {
        setBinary(true);
        setText(null);
      }
    },
    [workflowAction, instanceId, sessionId, runId, artifact],
  );

  // The binary verdict reads the WHOLE accumulated text once the chunks
  // stop coming (a split codepoint mid-stream must not read as binary).
  useEffect(() => {
    if (nextOffset !== null || text === null) return;
    let bad = 0;
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 0xfffd) bad++;
    if (text.length > 0 && bad / text.length > 0.01) setBinary(true);
  }, [nextOffset, text]);

  const loadBoard = useCallback(
    async (initial: boolean) => {
      setBusy(true);
      const after = initial ? undefined : (boardCursor ?? undefined);
      const res = await workflowAction("load artifact items", (c) =>
        c.runArtifactData(instanceId, sessionId, runId, artifact.id, after),
      );
      setBusy(false);
      if (!res) return;
      const rendered = res.items
        .map((it) => prettyJson(it.item))
        .join("\n\n---\n\n");
      const lastSeq = res.items[res.items.length - 1]?.sequence;
      if (lastSeq !== undefined) setBoardCursor(lastSeq);
      setBoardItems((prev) =>
        initial || prev === null ? rendered : `${prev}\n\n---\n\n${rendered}`,
      );
      setBoardHasMore(res.hasMore === true);
    },
    [workflowAction, instanceId, sessionId, runId, artifact, boardCursor],
  );

  useEffect(() => {
    if (kind === "markdown" || kind === "file") {
      void loadChunk(0, false);
    } else if (kind === "board") {
      void loadBoard(true);
    } else {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // markdown: decode finished when text landed
  useEffect(() => {
    if (kind === "markdown" && text !== null && !binary) setMarkdown(text);
  }, [kind, text, binary]);

  return (
    <ViewerShell title={artifact.title ?? artifact.id} onBack={onBack}>
      {!structured &&
      busy &&
      text === null &&
      markdown === null &&
      boardItems === null ? (
        <div className="flex justify-center py-10">
          <RefreshCw className="size-5 animate-spin text-faint" />
        </div>
      ) : kind === "markdown" && markdown !== null ? (
        <div className="pt-2">
          <MarkdownText text={markdown} />
        </div>
      ) : kind === "file" ? (
        <>
          {binary ? (
            <p className="py-8 text-center text-sm text-faint">
              {t("zconfig.workflowBinary", {
                bytes: totalBytes ?? text?.length ?? 0,
              })}
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim">
              {text}
            </pre>
          )}
          {nextOffset !== null && (
            <button
              onClick={() => void loadChunk(nextOffset, true)}
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
            >
              {t("zconfig.workflowLoadMore")}
            </button>
          )}
        </>
      ) : kind === "board" ? (
        <>
          {boardItems !== null ? (
            <pre className="whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim">
              {boardItems}
            </pre>
          ) : null}
          {boardHasMore && (
            <button
              onClick={() => void loadBoard(false)}
              disabled={busy}
              className="mt-4 w-full rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
            >
              {t("zconfig.workflowLoadMore")}
            </button>
          )}
        </>
      ) : (
        <pre className="whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim">
          {prettyJson(artifact)}
        </pre>
      )}
    </ViewerShell>
  );
}

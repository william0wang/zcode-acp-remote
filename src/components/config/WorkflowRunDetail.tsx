import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
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
import {
  ConfigField,
  ConfigFormSheet,
  configInputClass,
} from "./ConfigFormSheet";

// One workflow run's detail view (bridge 0.48.0, ADR-0029): the journal
// events, the artifacts, and the workspace nodes the backend's v4 queries
// expose — everything the chat progress card deliberately compresses.
//
// Live-ness is polling, not push: the journal cursor (`afterSequence`) never
// invalidates, so a 3s tick while the run is active appends only the new
// lines, and a settled run costs exactly one fetch per tab.

/**
 * Desktop-parity status presentation (upstream run-status-presentation): a
 * colored dot ALWAYS pairs with the word. Semantic split — success emerald,
 * failure red with a halo, live sky (pulsing), pending an empty ring, and the
 * stopped family (stopped/cancelled/superseded/interrupted) deliberately
 * NEUTRAL: a stopped run is not an error. Unknown tokens fall back neutral.
 */
const STATUS_DOT: Record<string, string> = {
  completed: "bg-emerald-400",
  ok: "bg-emerald-400",
  settled: "bg-emerald-400",
  errored: "bg-red-400 ring-2 ring-red-400/25",
  failed: "bg-red-400 ring-2 ring-red-400/25",
  running: "bg-sky-400 animate-pulse",
  dispatched: "bg-sky-400 animate-pulse",
  executing: "bg-sky-400 animate-pulse",
  pending: "bg-transparent ring-1 ring-white/40",
  queued: "bg-transparent ring-1 ring-white/40",
  waiting: "bg-transparent ring-1 ring-white/40",
  stopped: "bg-white/35",
  cancelled: "bg-white/35",
  superseded: "bg-white/35",
  interrupted: "bg-white/35",
};

export function StatusBadge({ status }: { status?: string }) {
  const token = status ?? "";
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-dim">
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          STATUS_DOT[token] ?? "bg-white/35"
        }`}
      />
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
 * Desktop-parity op tile (upstream WorkflowWorkspaceCard's kind tile): a
 * small colored square keyed by the op family — read/search/git/exec/write —
 * so a long node list scans by color before it reads by text.
 */
const OP_TILE: Array<[RegExp, string]> = [
  [/read|file|cat|list/, "bg-sky-500/15 text-sky-300"],
  [/search|grep|glob|find|scan/, "bg-violet-500/15 text-violet-300"],
  [/git/, "bg-amber-500/15 text-amber-300"],
  [/shell|bash|exec|spawn|terminal|run/, "bg-emerald-500/15 text-emerald-300"],
  [/write|edit|patch|apply|create|delete|move/, "bg-rose-500/15 text-rose-300"],
];

function opTileClass(op?: string): string {
  if (op) for (const [re, cls] of OP_TILE) if (re.test(op)) return cls;
  return "bg-white/[0.07] text-dim";
}

/** Wall time between two epoch-ms stamps, compact ("12s" / "3m41s"). */
function fmtDuration(from?: number, to?: number): string | null {
  if (!from || !to || to < from) return null;
  const s = Math.round((to - from) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
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
  onRepoint,
}: {
  instanceId: string;
  sessionId: string;
  runId: string;
  title: string;
  onBack: () => void;
  /** Supersede re-point: the amendment returned a NEW run id. */
  onRepoint: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const workflowAction = useAppStore((s) => s.workflowAction);
  const resumeWorkflowRun = useAppStore((s) => s.resumeWorkflowRun);
  const stopWorkflowRun = useAppStore((s) => s.stopWorkflowRun);
  const amendWorkflowRun = useAppStore((s) => s.amendWorkflowRun);
  const [tab, setTab] = useState<Tab>("events");
  const [summary, setSummary] = useState<ConversationRunSummary | null>(null);
  const [amending, setAmending] = useState(false);
  const [stopping, setStopping] = useState(false);
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
    const ok = await resumeWorkflowRun({ runId, sessionId, instanceId });
    if (ok) void refreshSummary();
  }

  async function stop() {
    setStopping(true);
    const ok = await stopWorkflowRun(runId, sessionId, instanceId);
    setStopping(false);
    if (ok) void refreshSummary();
  }

  // Phases entered so far (journal `phase-entered` events) — the last one is
  // where the run currently stands.
  const phases = useMemo(
    () =>
      (events ?? [])
        .filter((e) => e.type === "phase-entered")
        .map((e) => {
          const p = e.payload ?? {};
          for (const key of ["phaseName", "name"]) {
            const v = p[key];
            if (typeof v === "string" && v) return v;
          }
          return null;
        })
        .filter((v): v is string => v !== null),
    [events],
  );

  // Events sliced at every phase-entered boundary (the journal has no
  // phase-exited — entering N implies N-1 done): each slice renders as one
  // phase section with its actors and aggregated nodes underneath. A leading
  // slice (phase: null) holds whatever preceded the first phase.
  const phaseSlices = useMemo<PhaseSlice[]>(() => {
    const out: PhaseSlice[] = [];
    let cur: PhaseSlice = { phase: null, events: [] };
    const pushIfUsed = () => {
      if (cur.events.length > 0 || cur.phase !== null) out.push(cur);
    };
    for (const e of events ?? []) {
      if (e.type === "phase-entered") {
        const p = e.payload ?? {};
        const name =
          typeof p.phaseName === "string" && p.phaseName
            ? p.phaseName
            : typeof p.name === "string" && p.name
              ? p.name
              : "?";
        pushIfUsed();
        cur = { phase: name, events: [] };
        continue;
      }
      cur.events.push(e);
    }
    pushIfUsed();
    return out;
  }, [events]);

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
            <span className="min-w-0 flex-1 truncate">
              {[
                summary?.updatedAt ? fmtStamp(summary.updatedAt) : "",
                summary?.stopReason ?? "",
                summary?.failureMessage ?? "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </p>
          {(summary?.resumedFrom || summary?.supersededBy) && (
            <p className="mt-0.5 truncate text-[10px] text-faint">
              {summary?.resumedFrom &&
                ` ${t("zconfig.workflowLineageFrom")} …${summary.resumedFrom.slice(-8)}`}
              {summary?.supersededBy &&
                ` ${t("zconfig.workflowLineageBy")} …${summary.supersededBy.slice(-8)}`}
            </p>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {active && !sessionDead && (
            <>
              <button
                onClick={() => setAmending(true)}
                aria-label={t("zconfig.workflowConfigure")}
                className="flex size-8 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
              >
                <SlidersHorizontal className="size-4" />
              </button>
              <button
                onClick={() => void stop()}
                disabled={stopping}
                aria-label={t("zconfig.workflowStop")}
                className="flex size-8 items-center justify-center rounded-full bg-red-500/15 text-red-300 active:bg-red-500/25 disabled:opacity-40"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </>
          )}
          {summary?.resumable && (
            <button
              onClick={() => void resume()}
              className="rounded-lg bg-sky-500/20 px-2.5 py-1.5 text-[11px] font-medium text-sky-300"
            >
              {t("zconfig.workflowResume")}
            </button>
          )}
        </div>
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
            {phases.length > 0 && <PhaseTimeline phases={phases} running={active} />}
            {events !== null && events.length === 0 ? (
              <ConfigEmpty text={t("zconfig.workflowEventsEmpty")} />
            ) : (
              <div className="px-4">
                {phaseSlices.map((slice, i) => (
                  <PhaseSection
                    key={`${i}-${slice.phase ?? "pre"}`}
                    slice={slice}
                  />
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
                  const dur = fmtDuration(n.createdAt, n.updatedAt);
                  const exitBad =
                    n.summary?.exitCode !== undefined && n.summary.exitCode !== 0;
                  return (
                    <div key={key} className="px-4 py-2.5">
                      <button
                        onClick={() => void loadNode(key, n)}
                        className="flex w-full items-center gap-2.5 text-left"
                      >
                        <span
                          className={`flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-semibold uppercase ${opTileClass(n.op)}`}
                        >
                          {(n.op ?? "?").slice(0, 2)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                              {n.op ?? key}
                            </span>
                            {dur && (
                              <span className="shrink-0 text-[10px] tabular-nums text-faint">
                                +{dur}
                              </span>
                            )}
                          </span>
                          {n.summary && (
                            <span
                              className={`block truncate text-[11px] ${
                                exitBad ? "text-red-300/90" : "text-faint"
                              }`}
                            >
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
      {amending && (
        <AmendSheet
          onClose={() => setAmending(false)}
          onAmend={async (body) => {
            setAmending(false);
            const res = await amendWorkflowRun({ runId, sessionId, body, instanceId });
            if (!res) return;
            // A supersede answers with the NEW run's id — re-point the whole
            // view so the poller and every tab follow the continuation.
            if (res.runId !== runId) onRepoint(res.runId);
            else void refreshSummary();
          }}
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

/**
 * Submit-only settings amendment (bridge 0.49.0): the run summary carries no
 * current values until the upstream schema extension lands, so nothing is
 * prefilled. Three-state per field: empty = keep, "clear" checked = send
 * `null` (revert to default), value = set. The submit is disabled until at
 * least one field contributes a change (an empty delta is a 422 by contract).
 */
function AmendSheet({
  onClose,
  onAmend,
}: {
  onClose: () => void;
  onAmend: (body: {
    subagentModel?: string | null;
    maxConcurrency?: number | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [model, setModel] = useState("");
  const [clearModel, setClearModel] = useState(false);
  const [concurrency, setConcurrency] = useState("");
  const [clearConcurrency, setClearConcurrency] = useState(false);
  const [busy, setBusy] = useState(false);

  const modelValue = clearModel ? null : model.trim() || undefined;
  const parsedConcurrency = concurrency.trim();
  const concurrencyNumber =
    !clearConcurrency && parsedConcurrency
      ? Number(parsedConcurrency)
      : undefined;
  const concurrencyValue: number | null | undefined = clearConcurrency
    ? null
    : concurrencyNumber !== undefined &&
        Number.isInteger(concurrencyNumber) &&
        concurrencyNumber >= 1
      ? concurrencyNumber
      : undefined;
  const concurrencyInvalid =
    !clearConcurrency &&
    parsedConcurrency !== "" &&
    concurrencyValue === undefined;
  const empty =
    modelValue === undefined &&
    concurrencyValue === undefined &&
    !clearConcurrency;

  return (
    <ConfigFormSheet
      title={t("zconfig.workflowConfigure")}
      submitDisabled={busy || empty || concurrencyInvalid}
      onClose={onClose}
      onSubmit={() => {
        setBusy(true);
        void onAmend({
          ...(modelValue !== undefined ? { subagentModel: modelValue } : {}),
          ...(concurrencyValue !== undefined || clearConcurrency
            ? { maxConcurrency: clearConcurrency ? null : concurrencyValue }
            : {}),
        });
      }}
    >
      <ConfigField
        label={t("zconfig.workflowSubagentModel")}
        hint={t("zconfig.workflowSubagentModelHint")}
      >
        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            if (e.target.value) setClearModel(false);
          }}
          disabled={clearModel}
          className={`${configInputClass} font-mono`}
          placeholder="zhipu/glm-4.7"
        />
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
          <input
            type="checkbox"
            checked={clearModel}
            onChange={(e) => {
              setClearModel(e.target.checked);
              if (e.target.checked) setModel("");
            }}
            className="size-3.5 accent-white"
          />
          {t("zconfig.workflowClearModel")}
        </label>
      </ConfigField>
      <ConfigField
        label={t("zconfig.workflowMaxConcurrency")}
        hint={
          concurrencyInvalid
            ? t("zconfig.workflowConcurrencyInvalid")
            : t("zconfig.workflowConcurrencyHint")
        }
      >
        <input
          value={concurrency}
          onChange={(e) => {
            setConcurrency(e.target.value);
            if (e.target.value) setClearConcurrency(false);
          }}
          disabled={clearConcurrency}
          inputMode="numeric"
          className={configInputClass}
          placeholder="4"
        />
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
          <input
            type="checkbox"
            checked={clearConcurrency}
            onChange={(e) => {
              setClearConcurrency(e.target.checked);
              if (e.target.checked) setConcurrency("");
            }}
            className="size-3.5 accent-white"
          />
          {t("zconfig.workflowClearConcurrency")}
        </label>
      </ConfigField>
      <p className="px-1 text-[10px] leading-relaxed text-faint">
        {t("zconfig.workflowAmendHint")}
      </p>
    </ConfigFormSheet>
  );
}

/** One phase's slice of the journal, bounded by phase-entered events. */
interface PhaseSlice {
  /** null = the leading slice before the first phase-entered. */
  phase: string | null;
  events: WorkflowRunEvent[];
}

/** A node's folded lifecycle: the latest of its queued→…→settled events. */
interface NodeAgg {
  site: string;
  ordinal?: number;
  state: "active" | "ok" | "failed" | "cancelled";
  head?: string;
}

/** The journal may carry the node's task head under any of these keys. */
function instructionHead(p: Record<string, unknown>): string | undefined {
  for (const k of ["instructions", "instruction", "prompt", "task", "description"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return undefined;
}

/**
 * Fold one slice's events: node-* lifecycles collapse per (siteId, ordinal)
 * into a single line each (settled is final — later replayed lifecycle noise
 * must not reopen it), actor-created becomes a hiring line, run-settled a
 * closing line, and everything chatty stays an expandable EventRow.
 */
function reduceSlice(events: WorkflowRunEvent[]) {
  const nodes = new Map<string, NodeAgg>();
  const actors: Array<{ label: string }> = [];
  const others: WorkflowRunEvent[] = [];
  let settled: string | null = null;
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (ev.type === "actor-created") {
      const name = [p.name, p.actorName, p.siteId, p.actorSiteId].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      actors.push({ label: name ?? "?" });
      continue;
    }
    if (ev.type === "run-settled") {
      settled = typeof p.status === "string" ? p.status : "unknown";
      continue;
    }
    if (ev.type.startsWith("node-")) {
      const site = typeof p.siteId === "string" ? p.siteId : "";
      const ordinal = typeof p.ordinal === "number" ? p.ordinal : undefined;
      const key = `${site}:${ordinal ?? "?"}`;
      const prev = nodes.get(key);
      if (prev && prev.state !== "active") continue;
      const outcome = p.outcome;
      nodes.set(key, {
        site,
        ordinal,
        state:
          outcome === "ok" || outcome === "failed" || outcome === "cancelled"
            ? outcome
            : "active",
        head: prev?.head ?? instructionHead(p),
      });
      continue;
    }
    others.push(ev);
  }
  return { actors, nodes: [...nodes.values()], others, settled };
}

/**
 * Desktop-parity mini timeline (upstream WorkflowTimeline, mobile-sized): one
 * station per entered phase with a connecting line; entering phase N means
 * N-1 finished, so every line is a passed segment. The newest station is the
 * head — pulsing while the run flies, plain once it settles.
 */
function PhaseTimeline({ phases, running }: { phases: string[]; running: boolean }) {
  return (
    <div className="mx-4 mb-3 overflow-x-auto pb-1">
      <ol className="flex min-w-max items-center">
        {phases.map((p, i) => {
          const head = i === phases.length - 1;
          return (
            <li key={`${i}-${p}`} className="flex items-center">
              {i > 0 && <span className="h-px w-6 bg-emerald-400/40" />}
              <span className="flex items-center gap-1.5 px-1.5 py-1.5">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${
                    head
                      ? running
                        ? "animate-pulse bg-sky-400"
                        : "bg-sky-400"
                      : "bg-emerald-400/80"
                  }`}
                />
                <span
                  className={`whitespace-nowrap font-mono text-[11px] ${
                    head ? "font-medium text-ink" : "text-faint"
                  }`}
                >
                  {p}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One node's folded line: status dot + site#ordinal + task head. */
function NodeLine({ n }: { n: NodeAgg }) {
  const dot =
    n.state === "ok"
      ? "bg-emerald-400"
      : n.state === "failed"
        ? "bg-red-400"
        : n.state === "cancelled"
          ? "bg-white/35"
          : "animate-pulse bg-sky-400";
  const label = `${n.site || "?"}${n.ordinal !== undefined ? ` #${n.ordinal}` : ""}`;
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="max-w-24 shrink-0 truncate font-mono text-[11px] text-dim">
        {label}
      </span>
      {n.head ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{n.head}</span>
      ) : null}
      {n.state !== "active" && (
        <span
          className={`shrink-0 text-[10px] ${
            n.state === "failed"
              ? "text-red-300"
              : n.state === "ok"
                ? "text-emerald-300/80"
                : "text-faint"
          }`}
        >
          {n.state}
        </span>
      )}
    </div>
  );
}

/** One phase section: header, hired actors, folded nodes, raw leftovers. */
function PhaseSection({ slice }: { slice: PhaseSlice }) {
  const { t } = useTranslation();
  const { actors, nodes, others, settled } = useMemo(
    () => reduceSlice(slice.events),
    [slice],
  );
  if (
    actors.length === 0 &&
    nodes.length === 0 &&
    others.length === 0 &&
    settled === null
  )
    return null;
  return (
    <section className="mb-3">
      {slice.phase !== null && (
        <header className="mb-1 flex items-baseline gap-2 border-b border-hairline pb-1">
          <span className="font-mono text-xs font-medium text-ink">{slice.phase}</span>
          {nodes.length > 0 && (
            <span className="text-[10px] text-faint">
              {t("zconfig.workflowPhaseNodes", { n: nodes.length })}
            </span>
          )}
        </header>
      )}
      {actors.map((a, i) => (
        <p key={i} className="truncate py-1 font-mono text-[11px] text-faint">
          + {a.label}
        </p>
      ))}
      {nodes.map((n) => (
        <NodeLine key={`${n.site}:${n.ordinal ?? "?"}`} n={n} />
      ))}
      {others.map((ev) => (
        <EventRow key={ev.sequence} ev={ev} />
      ))}
      {settled !== null && (
        <p className="py-1 font-mono text-[11px] text-dim">
          = run settled · {settled}
        </p>
      )}
    </section>
  );
}

/** One journal row: sequence + type, payload expandable in place. */
function EventRow({ ev }: { ev: WorkflowRunEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-hairline py-2.5 last:border-0">
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
  // Board/table/metrics share one paginated data channel (`artifactData`):
  // raw items stay structured so each kind renders its own view.
  const [dataItems, setDataItems] = useState<Array<{
    sequence: number;
    item: unknown;
  }> | null>(null);
  const [dataHasMore, setDataHasMore] = useState(false);
  const [dataCursor, setDataCursor] = useState<number | null>(null);
  // One decoder per artifact, in streaming mode: a chunk boundary can split
  // a multi-byte UTF-8 character, and per-chunk decoding would turn each
  // split into U+FFFD on both sides.
  const decoderRef = useRef<TextDecoder | null>(null);

  const kind = artifact.kind;

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

  const loadData = useCallback(
    async (initial: boolean) => {
      setBusy(true);
      const after = initial ? undefined : (dataCursor ?? undefined);
      const res = await workflowAction("load artifact items", (c) =>
        c.runArtifactData(instanceId, sessionId, runId, artifact.id, after),
      );
      setBusy(false);
      if (!res) return;
      const lastSeq = res.items[res.items.length - 1]?.sequence;
      if (lastSeq !== undefined) setDataCursor(lastSeq);
      setDataItems((prev) =>
        initial || prev === null
          ? res.items.map((it) => ({
              sequence: it.sequence ?? 0,
              item: it.item,
            }))
          : [
              ...prev,
              ...res.items.map((it) => ({
                sequence: it.sequence ?? 0,
                item: it.item,
              })),
            ],
      );
      setDataHasMore(res.hasMore === true);
    },
    [workflowAction, instanceId, sessionId, runId, artifact, dataCursor],
  );

  useEffect(() => {
    if (kind === "markdown" || kind === "file") {
      void loadChunk(0, false);
    } else if (kind === "board" || kind === "table" || kind === "metrics") {
      void loadData(true);
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
      {busy &&
      text === null &&
      markdown === null &&
      dataItems === null &&
      kind !== "chart" ? (
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
      ) : kind === "table" ? (
        <TableView items={dataItems} spec={artifact.spec} />
      ) : kind === "metrics" ? (
        <MetricsView items={dataItems} />
      ) : kind === "board" ? (
        <>
          {(dataItems ?? []).map((it) => (
            <pre
              key={it.sequence}
              className="mb-3 whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim"
            >
              {prettyJson(it.item)}
            </pre>
          ))}
        </>
      ) : (
        <pre className="whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim">
          {prettyJson(artifact)}
        </pre>
      )}
      {(kind === "board" || kind === "table" || kind === "metrics") &&
        dataHasMore && (
          <button
            onClick={() => void loadData(false)}
            disabled={busy}
            className="mt-4 w-full rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
          >
            {t("zconfig.workflowLoadMore")}
          </button>
        )}
    </ViewerShell>
  );
}

/** Short cell text for a table cell / metric value. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return prettyJson(value);
  return String(value);
}

/**
 * Table artifacts: column labels come from the spec's declared columns when
 * they parse (labels/keys in any common spelling), else from the first row's
 * own keys — the report items are plain objects by construction.
 */
function TableView({
  items,
  spec,
}: {
  items: Array<{ sequence: number; item: unknown }> | null;
  spec: unknown;
}) {
  const rows = (items ?? []).map((it) =>
    typeof it.item === "object" && it.item !== null && !Array.isArray(it.item)
      ? (it.item as Record<string, unknown>)
      : null,
  );
  const firstRow = rows.find((r) => r !== null) ?? null;
  const columns: string[] = (() => {
    const declared = (() => {
      if (typeof spec !== "object" || spec === null) return null;
      const cols = (spec as Record<string, unknown>)["columns"];
      if (!Array.isArray(cols)) return null;
      return cols
        .map((c) => {
          if (typeof c === "string") return c;
          if (typeof c === "object" && c !== null) {
            const o = c as Record<string, unknown>;
            for (const key of ["label", "title", "name", "key", "field"]) {
              const v = o[key];
              if (typeof v === "string" && v) return v;
            }
          }
          return null;
        })
        .filter((v): v is string => v !== null);
    })();
    if (declared && declared.length > 0) return declared;
    return firstRow ? Object.keys(firstRow) : [];
  })();

  if (items === null || rows.every((r) => r === null)) {
    return (
      <pre className="whitespace-pre-wrap break-all pt-2 font-mono text-[11px] leading-relaxed text-dim">
        {(items ?? []).map((it) => prettyJson(it.item)).join("\n\n---\n\n")}
      </pre>
    );
  }

  return (
    <div className="overflow-x-auto pt-2">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="whitespace-nowrap border-b border-hairline px-2 py-1.5 font-medium text-dim"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={items[i]!.sequence} className="align-top">
              {columns.map((c) => (
                <td
                  key={c}
                  className="max-w-64 truncate border-b border-hairline/50 px-2 py-1.5 text-dim"
                >
                  {r === null ? prettyJson(items[i]!.item) : cellText(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Metrics artifacts: one key-value card per report item. */
function MetricsView({
  items,
}: {
  items: Array<{ sequence: number; item: unknown }> | null;
}) {
  if (items === null) return null;
  return (
    <div className="flex flex-col gap-2 pt-2">
      {items.map((it) => {
        if (
          typeof it.item !== "object" ||
          it.item === null ||
          Array.isArray(it.item)
        ) {
          return (
            <pre
              key={it.sequence}
              className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-dim"
            >
              {prettyJson(it.item)}
            </pre>
          );
        }
        return (
          <div
            key={it.sequence}
            className="rounded-xl bg-surface px-3 py-2 ring-1 ring-hairline"
          >
            {Object.entries(it.item as Record<string, unknown>).map(
              ([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-3 py-0.5"
                >
                  <span className="min-w-0 truncate text-[11px] text-faint">
                    {k}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink">
                    {cellText(v)}
                  </span>
                </div>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

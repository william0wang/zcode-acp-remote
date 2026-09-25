import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
  ConfigRow,
  fmtStamp,
  fmtTokens,
} from "../../components/config/ConfigPage";
import {
  ConfigField,
  ConfigFormSheet,
  configInputClass,
} from "../../components/config/ConfigFormSheet";
import {
  StatusBadge,
  WorkflowRunDetail,
} from "../../components/config/WorkflowRunDetail";
import { lookupLaunch } from "../../lib/workflow-launches";
import type {
  ConversationRunSummary,
  WorkflowDetailResponse,
  WorkflowRunRow,
  WorkflowScope,
} from "../../lib/types";

// Dynamic workflows (bridge 0.48.0, server ADR-0029). The management plane
// the chat side deliberately leaves out: saved workflows, their run history,
// and the launch/resume entry points. Everything rides the per-instance
// settings routes, so the whole page is inert without a connected bridge.
//
// Run rows split by what the app can KNOW: a run this app launched carries
// its ACP session in the local launch memory (open / inspect / resume);
// every other row — an editor-driven run, or one whose bridge died — is
// read-only, because the journal only records the backend session id.

/** Parse the optional start-args textarea; "" = no args. */
function parseArgsInput(text: string): {
  args?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: "args must be a JSON object" };
    }
    return { args: value as Record<string, unknown> };
  } catch {
    return { error: "invalid JSON" };
  }
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  const workflows = useAppStore((s) => s.configWorkflows);
  const scope = useAppStore((s) => s.configWorkflowScope);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const instanceId = useAppStore((s) => s.instanceId);
  const loadWorkflows = useAppStore((s) => s.loadWorkflows);
  const workflowAction = useAppStore((s) => s.workflowAction);
  const setComposerPrefill = useAppStore((s) => s.setComposerPrefill);
  const closeConfig = useAppStore((s) => s.closeConfig);

  const [selected, setSelected] = useState<{
    scope: WorkflowScope;
    name: string;
  } | null>(null);
  const [runDetail, setRunDetail] = useState<{
    sessionId: string;
    runId: string;
    name: string;
  } | null>(null);

  // First paint is seeded by the ZCodeConfigScreen mount effect (the section
  // case in loadConfigSection); the scope buttons and refresh call
  // loadWorkflows directly. No page-level mount effect — child effects run
  // before the parent's, so one here would double-fire the seed GET.

  // "Create via conversation": the bridge hands back the desktop's prefilled
  // prompt; the app stages it as the composer draft and never auto-sends.
  async function createViaChat() {
    const res = await workflowAction("load create prompt", (c, iid) =>
      c.workflowCreatePrompt(iid, scope),
    );
    if (!res) return;
    setComposerPrefill(res.prompt);
    closeConfig();
    if (!useAppStore.getState().activeSessionId) {
      useAppStore
        .getState()
        .notify("prompt staged — open a session to review and send it");
    }
  }

  if (runDetail && instanceId) {
    return (
      <WorkflowRunDetail
        instanceId={instanceId}
        sessionId={runDetail.sessionId}
        runId={runDetail.runId}
        title={runDetail.name}
        onBack={() => setRunDetail(null)}
      />
    );
  }

  if (selected) {
    return (
      <WorkflowDetail
        scope={selected.scope}
        name={selected.name}
        onBack={() => setSelected(null)}
        onOpenRun={(sessionId, runId, name) =>
          setRunDetail({ sessionId, runId, name })
        }
      />
    );
  }

  const rows = workflows?.workflows ?? [];
  const invalid = workflows?.invalid ?? [];

  return (
    <ConfigPageFrame
      title={t("zconfig.workflows")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadWorkflows(scope)}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={workflows !== null}
    >
      {!instanceId && (
        <p className="mx-4 mt-2 rounded-xl bg-surface px-4 py-3 text-xs text-amber-300 ring-1 ring-hairline">
          {t("zconfig.workflowNeedInstance")}
        </p>
      )}

      {/* Scope segmented control — the two roots the backend scans. */}
      <div className="flex gap-1 px-4 pb-1 pt-1">
        {(["project", "global"] as const).map((s) => (
          <button
            key={s}
            onClick={() => void loadWorkflows(s)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs ${
              scope === s
                ? "bg-white/[0.1] font-medium text-ink"
                : "text-dim active:bg-white/[0.05]"
            }`}
          >
            {t(`zconfig.workflowScope_${s}`)}
          </button>
        ))}
      </div>

      {rows.length === 0 && invalid.length === 0 ? (
        <ConfigEmpty text={t("zconfig.workflowsEmpty")} />
      ) : (
        <ConfigBlock>
          {rows.map((w) => (
            <button
              key={`${w.scope ?? scope}/${w.name}`}
              onClick={() => setSelected({ scope, name: w.name })}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.05]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">{w.name}</span>
                {w.description && (
                  <span className="block truncate text-[11px] text-faint">
                    {w.description}
                  </span>
                )}
              </span>
              <ChevronRight className="size-4 shrink-0 text-faint" />
            </button>
          ))}
        </ConfigBlock>
      )}

      {invalid.length > 0 && (
        <ConfigBlock title={t("zconfig.workflowInvalid")} divided>
          {invalid.map((e, i) => (
            <div key={i} className="px-4 py-2.5">
              <p className="truncate font-mono text-[10px] text-faint">
                {e.path}
              </p>
              {e.reason && (
                <p className="truncate text-[11px] text-amber-300/80">
                  {e.reason}
                </p>
              )}
            </div>
          ))}
        </ConfigBlock>
      )}

      <div className="px-4">
        <button
          onClick={() => void createViaChat()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
        >
          <Plus className="size-4" />
          {t("zconfig.workflowCreateChat")}
        </button>
      </div>
    </ConfigPageFrame>
  );
}

// ---------- L1: one saved workflow ----------

function WorkflowDetail({
  scope,
  name,
  onBack,
  onOpenRun,
}: {
  scope: WorkflowScope;
  name: string;
  onBack: () => void;
  onOpenRun: (sessionId: string, runId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const workflowAction = useAppStore((s) => s.workflowAction);
  const loadWorkflows = useAppStore((s) => s.loadWorkflows);
  const loadRunSummaries = useAppStore((s) => s.loadRunSummaries);
  const startWorkflow = useAppStore((s) => s.startWorkflow);
  const resumeWorkflowRun = useAppStore((s) => s.resumeWorkflowRun);
  const openSession = useAppStore((s) => s.openSession);
  const instanceId = useAppStore((s) => s.instanceId);

  const [detail, setDetail] = useState<WorkflowDetailResponse | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);
  const [summaries, setSummaries] = useState<
    Record<string, ConversationRunSummary[]>
  >({});
  const [scriptOpen, setScriptOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const res = await workflowAction("load workflow", (c, iid) =>
      c.workflowGet(iid, scope, name),
    );
    if (res) setDetail(res);
    const history = await workflowAction("load runs", (c, iid) =>
      c.workflowRunsHistory(iid, { scope, name }),
    );
    // Only a landed answer updates the list: a failed read keeps `null`, and
    // the render below shows nothing rather than dressing the error up as
    // "no runs recorded yet" (the toast already said what went wrong).
    if (history) setRuns(history.runs);
    // Refresh the resumable verdicts for the sessions this app launched
    // into — silent per design (loadRunSummaries), so dead sessions simply
    // leave their rows without a resume button.
    const sessionIds = Array.from(
      new Set(
        (history?.runs ?? [])
          .map((r) => lookupLaunch(r.runId)?.acpSessionId)
          .filter((sid): sid is string => Boolean(sid)),
      ),
    );
    if (sessionIds.length > 0) setSummaries(await loadRunSummaries(sessionIds));
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const description = useMemo(() => {
    const d = detail?.meta?.["description"];
    return typeof d === "string" ? d : "";
  }, [detail]);

  async function saveDescription(next: string) {
    setEditingDesc(false);
    // updateMeta REPLACES the whole meta — without a loaded detail the merge
    // base is unknown and a bare {description} would wipe whenToUse/args.
    if (!detail) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await workflowAction("save description", (c, iid) =>
      c.workflowUpdateMeta(iid, scope, name, {
        ...detail.meta,
        description: next,
      }),
    );
    setLoading(false);
    if (res) void load();
  }

  async function start(args?: Record<string, unknown>) {
    setStarting(false);
    const res = await startWorkflow({ scope, name, args });
    if (!res) return;
    useAppStore.getState().closeConfig();
    if (instanceId) void openSession(instanceId, res.acpSessionId);
  }

  async function resume(row: WorkflowRunRow) {
    const launch = lookupLaunch(row.runId);
    if (!launch) return;
    const ok = await resumeWorkflowRun({
      runId: row.runId,
      sessionId: launch.acpSessionId,
      ...(row.name ? { name: row.name } : {}),
    });
    if (ok) {
      useAppStore.getState().closeConfig();
      void openSession(launch.instanceId, launch.acpSessionId);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    const res = await workflowAction("delete workflow", (c, iid) =>
      c.workflowDelete(iid, scope, name),
    );
    if (!res) return;
    await loadWorkflows(scope);
    onBack();
  }

  async function moveToProject() {
    const res = await workflowAction("move workflow", (c, iid) =>
      c.workflowMove(iid, scope, name),
    );
    if (!res) return;
    await loadWorkflows("project");
    onBack();
  }

  return (
    <ConfigPageFrame
      title={name}
      onBack={onBack}
      onRefresh={() => void load()}
      refreshing={loading}
      loading={loading}
      hasLoaded={detail !== null}
    >
      <ConfigBlock>
        <ConfigRow label={t("zconfig.workflowScopeLabel")} value={scope} />
        {description ? (
          <ConfigRow
            label={t("zconfig.workflowDescription")}
            value={description}
          />
        ) : null}
        {detail?.path && (
          <ConfigRow
            label={t("zconfig.workflowPath")}
            value={<span className="font-mono text-xs">{detail.path}</span>}
          />
        )}
        {detail && (
          <div className="px-4 py-2.5">
            <button
              onClick={() => setEditingDesc(true)}
              className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
            >
              {t("zconfig.workflowEditDescription")}
            </button>
          </div>
        )}
      </ConfigBlock>

      <div className="px-4">
        <button
          onClick={() => setStarting(true)}
          className="mt-3 w-full rounded-xl bg-white px-3 py-2.5 text-sm font-semibold text-black transition active:scale-[0.99]"
        >
          {t("zconfig.workflowStart")}
        </button>
        <div className="mt-2 flex gap-2">
          {scope === "global" && (
            <button
              onClick={() => void moveToProject()}
              className="flex-1 rounded-xl bg-raised px-3 py-2 text-xs text-dim active:bg-white/[0.07]"
            >
              {t("zconfig.workflowMoveToProject")}
            </button>
          )}
          {confirmDelete ? (
            <span className="flex flex-1 items-center justify-end gap-1.5">
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg px-2 py-1 text-[11px] text-faint"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void remove()}
                className="rounded-lg bg-red-500/20 px-2.5 py-1.5 text-[11px] font-medium text-red-300"
              >
                {t("zconfig.workflowConfirmDelete")}
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex-1 rounded-xl bg-raised px-3 py-2 text-xs text-dim active:bg-white/[0.07]"
            >
              {t("zconfig.workflowDelete")}
            </button>
          )}
        </div>
      </div>

      {detail?.script && (
        <ConfigBlock title={t("zconfig.workflowScript")} divided>
          <button
            onClick={() => setScriptOpen(!scriptOpen)}
            className="w-full px-4 py-2.5 text-left text-xs text-dim active:bg-white/[0.05]"
          >
            {scriptOpen
              ? t("zconfig.workflowHideScript")
              : t("zconfig.workflowShowScript")}
          </button>
          {scriptOpen && (
            <pre className="max-h-80 overflow-auto px-4 pb-3 font-mono text-[10px] leading-relaxed text-faint">
              {detail.script}
            </pre>
          )}
        </ConfigBlock>
      )}

      <ConfigBlock title={t("zconfig.workflowRunsTitle")} divided>
        {runs === null ? (
          // Loading only while a read is in flight; a FAILED read keeps
          // `runs` null with no spinner — the toast owns that story.
          loading ? (
            <p className="px-4 py-4 text-xs text-faint">
              {t("zconfig.loading")}
            </p>
          ) : null
        ) : runs.length === 0 ? (
          <ConfigEmpty text={t("zconfig.workflowRunsEmpty")} />
        ) : (
          runs.map((r) => {
            const launch = lookupLaunch(r.runId);
            const summary = launch
              ? summaries[launch.acpSessionId]?.find((s) => s.runId === r.runId)
              : undefined;
            return (
              <div key={r.runId} className="px-4 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">
                      {r.name ?? r.runId.slice(0, 12)}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {r.updatedAt ? `${fmtStamp(r.updatedAt)} · ` : ""}
                      {r.spentTokens ? `${fmtTokens(r.spentTokens)} · ` : ""}
                      {r.artifacts?.length ? `${r.artifacts.length}◆` : ""}
                    </span>
                  </span>
                  <StatusBadge status={summary?.status ?? r.status} />
                </div>
                {launch ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() =>
                        onOpenRun(launch.acpSessionId, r.runId, r.name ?? name)
                      }
                      className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
                    >
                      {t("zconfig.workflowRunDetail")}
                    </button>
                    <button
                      onClick={() =>
                        void openSession(launch.instanceId, launch.acpSessionId)
                      }
                      className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
                    >
                      {t("zconfig.workflowOpenSession")}
                    </button>
                    {summary?.resumable && (
                      <button
                        onClick={() => void resume(r)}
                        className="rounded-lg bg-sky-500/20 px-2.5 py-1.5 text-[11px] font-medium text-sky-300"
                      >
                        {t("zconfig.workflowResume")}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="pt-1 text-[10px] text-faint">
                    {t("zconfig.workflowRunUnknownSession")}
                  </p>
                )}
              </div>
            );
          })
        )}
      </ConfigBlock>

      {starting && (
        <StartSheet
          onClose={() => setStarting(false)}
          onStart={(args) => void start(args)}
        />
      )}
      {editingDesc && (
        <DescriptionSheet
          initial={description}
          onClose={() => setEditingDesc(false)}
          onSave={(next) => void saveDescription(next)}
        />
      )}
    </ConfigPageFrame>
  );
}

// ---------- sheets ----------

/** Optional JSON-object args, validated client-side before any request. */
function StartSheet({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (args?: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const parsed = parseArgsInput(text);
  return (
    <ConfigFormSheet
      title={t("zconfig.workflowStart")}
      submitDisabled={parsed.error !== undefined}
      onClose={onClose}
      onSubmit={() => onStart(parsed.args)}
    >
      <ConfigField
        label={t("zconfig.workflowStartArgs")}
        hint={parsed.error ? parsed.error : t("zconfig.workflowStartArgsHint")}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          spellCheck={false}
          className={`${configInputClass} font-mono`}
          placeholder={'{"target": "src/"}'}
        />
      </ConfigField>
    </ConfigFormSheet>
  );
}

function DescriptionSheet({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (next: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  // Upstream meta.description is a non-empty string — an empty save would be
  // rejected far away from here and surface as a confusing backend error.
  return (
    <ConfigFormSheet
      title={t("zconfig.workflowEditDescription")}
      submitDisabled={text.trim() === ""}
      onClose={onClose}
      onSubmit={() => onSave(text.trim())}
    >
      <ConfigField label={t("zconfig.workflowDescription")}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className={configInputClass}
        />
      </ConfigField>
    </ConfigFormSheet>
  );
}

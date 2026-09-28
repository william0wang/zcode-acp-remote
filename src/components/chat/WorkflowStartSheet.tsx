import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { argsDeclaration, parseArgsInput } from "../../lib/workflow-args";
import {
  WorkflowArgsForm,
  type ArgsFormState,
} from "../config/WorkflowArgsForm";
import type { WorkflowScope } from "../../lib/types";

/**
 * In-chat workflow launcher (bridge 0.48.0). Starting with `sessionId` pins
 * the run to the open session — the progress card streams into this
 * conversation, no session switch. Two views: pick a workflow, then edit the
 * optional args (same client-side validation as the config page's sheet).
 */
export function WorkflowStartSheet({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const workflowAction = useAppStore((s) => s.workflowAction);
  const startWorkflow = useAppStore((s) => s.startWorkflow);
  const notify = useAppStore((s) => s.notify);

  interface Picked {
    scope: WorkflowScope;
    name: string;
    description?: string;
  }
  const [entries, setEntries] = useState<Picked[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Args declaration for the picked workflow (its detail's meta). Undefined =
  // still fetching, null = no declaration (or fetch failed) → free-form JSON.
  const [declMeta, setDeclMeta] = useState<
    Record<string, unknown> | null | undefined
  >(undefined);
  const [form, setForm] = useState<ArgsFormState>({});
  // Guards the pick()'s fire-and-forget detail fetch: pick A, back out, pick
  // B — A's slower response must not overwrite B's declaration.
  const pickSeq = useRef(0);

  function pick(w: Picked) {
    setPicked(w);
    setText("");
    setForm({});
    setDeclMeta(undefined);
    const seq = ++pickSeq.current;
    // The list rows carry no args declaration — one detail GET buys the typed
    // form. Silent: on failure the JSON fallback below covers the launch.
    void (async () => {
      const detail = await workflowAction(
        "load workflow detail",
        (c, iid) => c.workflowGet(iid, w.scope, w.name),
        true,
      );
      if (pickSeq.current !== seq) return;
      setDeclMeta(detail?.meta ?? null);
    })();
  }

  // Both scopes in one shot, silent per scope: a failure surfaces as the
  // sheet's empty/failed state, not two toasts.
  useEffect(() => {
    void (async () => {
      const [project, globalScope] = await Promise.all([
        workflowAction(
          "load workflows",
          (c, iid) => c.workflowsList(iid, "project"),
          true,
        ),
        workflowAction(
          "load workflows",
          (c, iid) => c.workflowsList(iid, "global"),
          true,
        ),
      ]);
      if (!project && !globalScope) {
        setFailed(true);
        return;
      }
      setEntries([
        // Explicit pick (not spread): WorkflowEntry.scope is a loose wire
        // string and would widen the literal back to string.
        ...(project?.workflows ?? []).map((w) => ({
          scope: "project" as const,
          name: w.name,
          description: w.description,
        })),
        ...(globalScope?.workflows ?? []).map((w) => ({
          scope: "global" as const,
          name: w.name,
          description: w.description,
        })),
      ]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = parseArgsInput(text);
  const typed = declMeta !== undefined && argsDeclaration(declMeta) !== null;

  async function start() {
    if (!picked) return;
    const args = typed ? form.args : parsed.args;
    if (!typed && parsed.error) return;
    setBusy(true);
    const res = await startWorkflow({
      scope: picked.scope,
      name: picked.name,
      ...(args ? { args } : {}),
      sessionId,
    });
    setBusy(false);
    if (res) {
      notify(t("chat.workflowStarted"));
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="flex items-center gap-2 px-3 pt-3">
          {picked ? (
            <button
              onClick={() => setPicked(null)}
              aria-label={t("common.back")}
              className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <div className="size-8 shrink-0" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {picked ? picked.name : t("chat.workflowPickTitle")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("common.cancel")}
            className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/[0.06]"
          >
            <X className="size-4" />
          </button>
        </div>

        {!picked ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
            {failed ? (
              <p className="px-1 py-6 text-center text-xs text-faint">
                {t("chat.workflowLoadFailed")}
              </p>
            ) : entries === null ? (
              <p className="px-1 py-6 text-center text-xs text-faint">
                {t("zconfig.loading")}
              </p>
            ) : entries.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-faint">
                {t("chat.workflowEmptyList")}
              </p>
            ) : (
              entries.map((w) => (
                <button
                  key={`${w.scope}/${w.name}`}
                  onClick={() => pick(w)}
                  className="flex w-full items-baseline gap-2 rounded-xl px-2 py-2.5 text-left active:bg-white/[0.05]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm text-ink">
                      {w.name}
                    </span>
                    {w.description && (
                      <span className="block truncate text-xs text-faint">
                        {w.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-dim">
                    {t(`zconfig.workflowScope_${w.scope}`)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
            <p className="text-[11px] text-faint">
              {t("chat.workflowInSessionHint")}
            </p>
            {declMeta === undefined ? (
              <p className="py-6 text-center text-xs text-faint">
                {t("zconfig.loading")}
              </p>
            ) : typed ? (
              <>
                <div className="mt-3">
                  <WorkflowArgsForm meta={declMeta} onChange={setForm} />
                </div>
                {form.error ? (
                  <p className="mt-2 text-[11px] text-red-400">{form.error}</p>
                ) : null}
              </>
            ) : (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  className="mt-2 w-full resize-none rounded-xl bg-raised p-3 font-mono text-sm text-ink ring-1 ring-inset ring-hairline placeholder:text-faint focus:outline-none"
                  placeholder={'{"target": "src/"}'}
                />
                <p
                  className={`mt-1 text-[11px] ${parsed.error ? "text-red-400" : "text-faint"}`}
                >
                  {parsed.error ?? t("zconfig.workflowStartArgsHint")}
                </p>
              </>
            )}
            <button
              onClick={() => void start()}
              disabled={
                busy ||
                declMeta === undefined ||
                (typed ? form.error !== undefined : parsed.error !== undefined)
              }
              className="mt-3 w-full rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black transition active:scale-[0.99] disabled:opacity-40"
            >
              {t("zconfig.workflowStart")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

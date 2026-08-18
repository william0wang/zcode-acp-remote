import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ListChecks, Terminal } from "lucide-react";
import {
  useAppStore,
  type ApprovalContext,
  type PermissionOption,
} from "../store/appStore";
import type { HubInstance } from "../lib/types";

// Approval card (CONTEXT.md): one bottom sheet for every
// session/request_permission. Three shapes — Plan Approval, Tool Permission,
// Question — distinguished by the matched tool_call (ADR 0003).

// Common keys of tool inputs worth surfacing before the JSON fallback.
const INPUT_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "description",
] as const;

function rawInputHighlights(
  ctx: ApprovalContext,
): { label: string; value: string }[] {
  if (!ctx.rawInputText) return [];
  try {
    const v = JSON.parse(ctx.rawInputText) as Record<string, unknown>;
    const out: { label: string; value: string }[] = [];
    for (const k of INPUT_KEYS) {
      const val = v[k];
      if (typeof val === "string" && val) out.push({ label: k, value: val });
    }
    return out;
  } catch {
    return [];
  }
}

function optionClass(kind: string | undefined): string {
  if (kind === "allow_once") return "bg-blue-600 text-white active:bg-blue-700";
  if (kind === "allow_always")
    return "bg-blue-600/10 text-blue-400 ring-1 ring-inset ring-blue-500/40 active:bg-blue-600/20";
  if (kind?.startsWith("reject"))
    return "bg-red-600/10 text-red-400 ring-1 ring-inset ring-red-500/40 active:bg-red-600/20";
  return "bg-raised text-ink ring-1 ring-inset ring-hairline";
}

function sessionTitle(
  instances: HubInstance[],
  sessionId: string,
): string | null {
  for (const inst of instances) {
    const s = (inst.sessions ?? []).find((x) => x.sessionId === sessionId);
    if (s) return s.title ?? null;
  }
  return null;
}

function ActionButtons({
  options,
  onAnswer,
  plan,
}: {
  options: PermissionOption[];
  onAnswer: (optionId: string) => void;
  plan: boolean;
}) {
  // Plan approval: the two options are fixed and well-known — make them the
  // primary actions of the card.
  if (plan) {
    const approve = options.find(
      (o) => o.optionId === "approve" || o.kind?.startsWith("allow"),
    );
    const reject = options.find((o) => o !== approve);
    return (
      <div className="flex flex-col gap-2">
        {approve && (
          <button
            onClick={() => onAnswer(approve.optionId)}
            className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white active:bg-emerald-700"
          >
            {approve.name || "Approve — exit plan mode"}
          </button>
        )}
        {reject && (
          <button
            onClick={() => onAnswer(reject.optionId)}
            className="rounded-xl bg-red-600/10 px-4 py-3 text-sm font-medium text-red-400 ring-1 ring-inset ring-red-500/40 active:bg-red-600/20"
          >
            {reject.name || "Reject — keep planning"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => (
        <button
          key={o.optionId}
          onClick={() => onAnswer(o.optionId)}
          className={`rounded-xl px-4 py-3 text-sm font-medium ${optionClass(o.kind)}`}
        >
          {o.name || o.kind || o.optionId}
        </button>
      ))}
    </div>
  );
}

export function PermissionDialog() {
  const { t } = useTranslation();
  const permission = useAppStore((s) => s.permission);
  const answerPermission = useAppStore((s) => s.answerPermission);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const instances = useAppStore((s) => s.instances);
  if (!permission) return null;

  const ctx = permission.context;
  const optionIds = new Set(permission.options.map((o) => o.optionId));
  const isPlan =
    ctx?.kind === "switch_mode" ||
    (optionIds.has("approve") && optionIds.has("reject"));
  const isQuestion = ctx?.toolName === "AskUserQuestion";
  const highlights = isPlan ? [] : rawInputHighlights(ctx ?? {});
  const bodyText = isPlan
    ? (ctx?.plan ?? ctx?.detail)
    : isQuestion
      ? ctx?.detail
      : undefined;
  const otherSession =
    permission.sessionId !== activeSessionId
      ? sessionTitle(instances, permission.sessionId)
      : null;

  const onAnswer = (optionId: string) =>
    answerPermission(permission.requestId, optionId);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-surface">
        {otherSession != null && (
          <div className="border-b border-hairline bg-white/[0.03] px-4 py-1.5 text-[11px] text-faint">
            {t("permission.sessionLabel")}:{" "}
            <span className="text-dim">{otherSession}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            {isPlan ? (
              <>
                <ListChecks className="size-4 shrink-0 text-cyan-400" />
                {t("permission.planTitle")}
              </>
            ) : isQuestion ? (
              t("permission.questionTitle")
            ) : (
              t("permission.title")
            )}
          </h2>

          {ctx?.toolName && !isPlan && !isQuestion && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-dim">
              <Terminal className="size-3.5 shrink-0 text-amber-400" />
              <span className="font-mono">{ctx.toolName}</span>
            </p>
          )}

          {bodyText && (
            <div className="prose prose-sm prose-invert mt-2 max-w-none">
              <Markdown remarkPlugins={[remarkGfm]}>{bodyText}</Markdown>
            </div>
          )}

          {highlights.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {highlights.map((h) => (
                <div key={h.label} className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-faint">
                    {h.label}
                  </div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-xs text-dim">
                    {h.value}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {/* Unknown tool input: keep the raw JSON reachable, folded. */}
          {!isPlan &&
            !isQuestion &&
            highlights.length === 0 &&
            ctx?.rawInputText && (
              <details className="mt-2">
                <summary className="cursor-pointer select-none text-xs text-faint">
                  {ctx.toolName ?? "input"}
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 px-2.5 py-1.5 font-mono text-xs text-dim">
                  {ctx.rawInputText}
                </pre>
              </details>
            )}

          {/* Tool permission with no context at all: degrade gracefully. */}
          {!isPlan && !isQuestion && !ctx && permission.options.length > 0 && (
            <p className="mt-1 text-xs text-faint">
              {permission.options[0]?.name ?? t("permission.title")}
            </p>
          )}
        </div>
        <div className="px-4 pb-4 pt-3">
          <ActionButtons
            options={permission.options}
            onAnswer={onAnswer}
            plan={isPlan}
          />
          <p className="mt-2.5 text-center text-xs text-faint">
            {t("permission.hint")}
          </p>
        </div>
      </div>
    </div>
  );
}

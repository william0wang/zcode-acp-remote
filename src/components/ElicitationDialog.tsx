import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type ElicitField } from "../store/appStore";

// AskUserQuestion form (elicitation/create): the bridge's preferred channel
// once ANY client advertises elicitation.form — capabilities OR-merge across
// clients, so Zed's declaration routes our questions here too. One bottom
// sheet per question set; unanswered fields are skipped (the bridge's parser
// treats absent as skipped), Cancel declines the whole form.

function QuestionBlock({
  field,
  picked,
  checked,
  other,
  onPick,
  onToggle,
  onOther,
}: {
  field: ElicitField;
  picked: string | null;
  checked: Record<string, boolean>;
  other: string;
  onPick: (v: string) => void;
  onToggle: (v: string) => void;
  onOther: (v: string) => void;
}) {
  return (
    <div className="px-4 pb-3 pt-1">
      <p className="pb-1.5 text-sm text-ink">{field.question}</p>
      <div className="flex flex-col gap-1.5">
        {field.options.map((o) => {
          const on = field.multi ? checked[o.value] : picked === o.value;
          return (
            <button
              key={o.value}
              onClick={() =>
                field.multi ? onToggle(o.value) : onPick(o.value)
              }
              className={`rounded-xl px-3.5 py-2.5 text-left text-sm transition ${
                on
                  ? "bg-blue-600 font-medium text-white"
                  : "bg-raised text-dim ring-1 ring-inset ring-hairline active:bg-white/[0.08]"
              }`}
            >
              {o.label}
            </button>
          );
        })}
        {field.otherKey != null && (
          <input
            value={other}
            onChange={(e) => onOther(e.target.value)}
            placeholder={
              field.multi ? "or a custom value" : "or type a custom value"
            }
            autoCapitalize="none"
            className="rounded-xl bg-raised px-3.5 py-2.5 text-sm text-ink placeholder:text-faint ring-1 ring-inset ring-hairline focus:outline-none"
          />
        )}
      </div>
    </div>
  );
}

export function ElicitationDialog() {
  const { t } = useTranslation();
  // Per-session rendering (bridge 0.17.0 semantics): the form shows ONLY in
  // the session that asked — see PermissionDialog for the rationale.
  const elicitation = useAppStore(
    (s) => (s.activeSessionId ? s.elicitations[s.activeSessionId] : undefined) ?? null,
  );
  const answerElicitation = useAppStore((s) => s.answerElicitation);
  // Local answer state; keyed fresh per request (option sets can repeat q_0).
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const requestId = elicitation?.requestId;
  useEffect(() => {
    setPicked({});
    setChecked({});
    setOther({});
  }, [requestId]);

  if (!elicitation) return null;

  const submit = () => {
    const content: Record<string, string | string[]> = {};
    for (const f of elicitation.fields) {
      const free = f.otherKey != null ? (other[f.otherKey] ?? "").trim() : "";
      if (f.multi) {
        const sel = f.options
          .filter((o) => checked[o.value])
          .map((o) => o.value);
        if (sel.length > 0) content[f.key] = sel;
      } else if (!free) {
        // No custom text: the plain pick decides; no pick = skipped question.
        const v = picked[f.key];
        if (v) content[f.key] = v;
      }
      if (free && f.otherKey != null) content[f.otherKey] = free;
    }
    answerElicitation(elicitation.requestId, content);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="px-4 pt-3 text-sm font-semibold text-ink">
            {elicitation.message || t("permission.questionTitle")}
          </h2>
          {elicitation.fields.map((f) => (
            <QuestionBlock
              key={f.key}
              field={f}
              picked={picked[f.key] ?? null}
              checked={checked}
              other={f.otherKey != null ? (other[f.otherKey] ?? "") : ""}
              onPick={(v) => setPicked((p) => ({ ...p, [f.key]: v }))}
              onToggle={(v) => setChecked((c) => ({ ...c, [v]: !c[v] }))}
              onOther={(v) => setOther((o) => ({ ...o, [f.otherKey!]: v }))}
            />
          ))}
        </div>
        <div className="px-4 pb-4 pt-1">
          <button
            onClick={submit}
            className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white active:bg-blue-700"
          >
            {t("permission.submit")}
          </button>
          <button
            onClick={() => answerElicitation(elicitation.requestId, null)}
            className="mt-2 w-full rounded-xl bg-raised px-4 py-3 text-sm font-medium text-ink ring-1 ring-inset ring-hairline active:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

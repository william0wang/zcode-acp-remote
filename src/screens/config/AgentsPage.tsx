import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import type { AgentUpsert } from "../../lib/types";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";
import {
  ConfigField,
  ConfigFormSheet,
  configInputClass,
} from "../../components/config/ConfigFormSheet";
import { providerOptions, type ModelsPayload } from "./ModelsPage";

// Subagents (ADR-0009). Tapping an agent opens its configuration; the API
// splits the two kinds by what they are:
//   - a built-in (general-purpose, Explore) has no markdown file, so the only
//     editable thing is its model override, stored in the agents state file;
//   - a personal agent is a markdown file — the form edits the frontmatter
//     fields the server exposes (description, color, model, thoughtLevel) and
//     a PUT on a missing name creates it with a template body.
// The system-prompt body and the advanced frontmatter lists stay out: a body
// round-trip through a phone keyboard is how a broken agent gets committed,
// so the footer points at the desktop for that.

/** The eight colors the server's own form offers (agents-config.ts). */
export const AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

const SWATCH: Record<AgentColor, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  yellow: "bg-yellow-400",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
};

/** The server's name rule for a personal agent: 3–50 of [a-zA-Z0-9-]. */
export function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9-]{3,50}$/.test(name);
}

/**
 * Whether an agent's controls must be hidden, on the server's verdict.
 *
 * A built-in has no file to edit or delete, so the API refuses both with a 400
 * the user cannot act on. Reading the field the bridge sends (rather than
 * guessing from the name) is what keeps those controls off; the page's payload
 * type spells the same field.
 */
export function isAgentReadOnly(readOnly: boolean | undefined): boolean {
  return readOnly === true;
}

export interface AgentEntryView {
  name?: string;
  frontmatter?: {
    name?: string;
    description?: string;
    color?: string;
    model?: string;
    thoughtLevel?: string;
  };
  enabled?: boolean;
  /** Built-in agents cannot be edited or deleted — the server's word. */
  readOnly?: boolean;
  /** The resolved model override, when one is set. */
  modelSelection?: {
    providerId?: string;
    modelId?: string;
    thoughtLevel?: string | null;
  };
  path?: string;
}

export function AgentsPage() {
  const { t } = useTranslation();
  const agents = useAppStore((s) => s.configAgents);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const setAgentEnabled = useAppStore((s) => s.setAgentEnabled);

  const payload = agents as { ok?: boolean; agents?: AgentEntryView[] } | null;

  const rows = payload?.agents ?? [];

  const [editing, setEditing] = useState<AgentEntryView | null>(null);
  const [adding, setAdding] = useState(false);

  async function toggle(name: string, enable: boolean) {
    await applyConfigWrite(
      enable ? "enable subagent" : "disable subagent",
      () => setAgentEnabled(name, enable),
      ["agents"],
    );
  }

  return (
    <ConfigPageFrame
      title={t("zconfig.agents")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadConfigSection("agents")}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={agents !== null}
    >
      {rows.length === 0 ? (
        <ConfigEmpty text={t("zconfig.agentsEmpty")} />
      ) : (
        <ConfigBlock>
          {rows.map((a) => {
            const name = a.name ?? "";
            // `readOnly` is the server's verdict (a built-in has no file to
            // edit or delete). Trusting it — rather than guessing from the
            // name — is what keeps the enable control off agents the API
            // would refuse anyway.
            const readOnly = isAgentReadOnly(a.readOnly);
            const description = a.frontmatter?.description;
            // `modelSelection` is the built-ins' override; a personal agent's
            // model lives in its own frontmatter.
            const model = a.modelSelection?.modelId ?? a.frontmatter?.model;
            const thoughtLevel = a.modelSelection?.thoughtLevel;
            return (
              <div key={name} className="flex items-start gap-3 px-4 py-3">
                <button
                  onClick={() => setEditing(a)}
                  className="min-w-0 flex-1 text-left active:opacity-80"
                >
                  <span className="block text-sm text-ink">{name}</span>
                  {description && (
                    <span className="block truncate text-[11px] text-faint">
                      {description}
                    </span>
                  )}
                  {model && (
                    <span className="block truncate font-mono text-[10px] text-faint">
                      {model}
                      {thoughtLevel ? ` · ${thoughtLevel}` : ""}
                    </span>
                  )}
                  {readOnly && (
                    <span className="block text-[10px] text-faint">
                      {t("zconfig.agentBuiltIn")}
                    </span>
                  )}
                </button>
                {/* Immediate identity: the switch only exists where the API
                    accepts it — a built-in cannot be disabled. */}
                {!readOnly && (
                  <button
                    role="switch"
                    aria-checked={a.enabled !== false}
                    aria-label={t("zconfig.agentEnabled")}
                    onClick={() => void toggle(name, a.enabled === false)}
                    className={`mt-0.5 h-6 w-10 shrink-0 rounded-full transition ${
                      a.enabled !== false
                        ? "bg-emerald-500/80"
                        : "bg-white/[0.12]"
                    }`}
                  >
                    <span
                      className={`block size-5 rounded-full bg-white transition ${
                        a.enabled !== false
                          ? "translate-x-4.5"
                          : "translate-x-0.5"
                      }`}
                    />
                  </button>
                )}
                <ChevronRight className="mt-1 size-4 shrink-0 text-faint" />
              </div>
            );
          })}
        </ConfigBlock>
      )}

      <div className="px-4">
        <button
          onClick={() => setAdding(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-raised px-3 py-2.5 text-sm text-dim active:bg-white/[0.07]"
        >
          <Plus className="size-4" />
          {t("zconfig.agentsAdd")}
        </button>
      </div>

      <p className="px-4 pt-3 text-center text-[11px] text-faint">
        {t("zconfig.agentsCreateHint")}
      </p>

      {editing &&
        (isAgentReadOnly(editing.readOnly) ? (
          <BuiltInAgentForm
            key={editing.name}
            target={editing}
            onClose={() => setEditing(null)}
          />
        ) : (
          <PersonalAgentForm
            key={editing.name}
            target={editing}
            onClose={() => setEditing(null)}
          />
        ))}
      {adding && <NewAgentForm onClose={() => setAdding(false)} />}
    </ConfigPageFrame>
  );
}

/**
 * The model override for a built-in agent. The picker reads the models
 * section (provider → model → reasoning level), fetching it on first open if
 * the entry list's snapshot did not carry it.
 */
function BuiltInAgentForm({
  target,
  onClose,
}: {
  target: AgentEntryView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const configModels = useAppStore((s) => s.configModels);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const upsertAgent = useAppStore((s) => s.upsertAgent);

  const name = target.name ?? "";
  const override = target.modelSelection;

  // The models payload is the picker's data source; an entry screen that
  // never listed models leaves it null, so fetch it here.
  useEffect(() => {
    if (configModels === null) void loadConfigSection("models");
  }, [configModels, loadConfigSection]);

  const payload = configModels as ModelsPayload | null;
  const providers = providerOptions(payload);
  const available = payload?.models?.available ?? [];
  const rules = payload?.models?.modelRules ?? [];

  const [providerId, setProviderId] = useState(override?.providerId ?? "");
  const [modelId, setModelId] = useState(override?.modelId ?? "");
  const [reasoningLevel, setReasoningLevel] = useState(
    override?.thoughtLevel ?? "",
  );
  const [busy, setBusy] = useState(false);

  const modelIds = [
    ...new Set(
      available
        .filter((m) => m.providerId === providerId && m.modelId)
        .map((m) => m.modelId!),
    ),
  ];
  const levels =
    rules.find((r) => r.providerId === providerId && r.modelId === modelId)
      ?.reasoningLevels ?? [];

  async function submit() {
    setBusy(true);
    const level = reasoningLevel.trim();
    const ok = await applyConfigWrite(
      "set model override",
      () =>
        upsertAgent(name, {
          providerId,
          modelId,
          ...(level !== "" ? { reasoningLevel: level } : {}),
        }),
      ["agents"],
    );
    setBusy(false);
    if (ok) onClose();
  }

  async function clearOverride() {
    setBusy(true);
    // Both keys null TOGETHER is the server's spelling for "no override" —
    // one null alone is a malformed request.
    const ok = await applyConfigWrite(
      "clear model override",
      () => upsertAgent(name, { providerId: null, modelId: null }),
      ["agents"],
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <ConfigFormSheet
      title={`${t("zconfig.agentEdit")} · ${name}`}
      busy={busy}
      submitDisabled={providerId === "" || modelId === ""}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <p className="mt-3 text-[11px] text-faint">
        {override?.modelId
          ? `${override.providerId ?? "?"} / ${override.modelId}${override.thoughtLevel ? ` · ${override.thoughtLevel}` : ""}`
          : t("zconfig.agentOverrideNone")}
      </p>

      {configModels === null && (
        <p className="mt-3 text-xs text-faint">{t("zconfig.loading")}</p>
      )}

      <ConfigField label={t("zconfig.modelProvider")}>
        <select
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModelId("");
            setReasoningLevel("");
          }}
          className={configInputClass}
        >
          <option value="">—</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </ConfigField>

      <ConfigField label={t("zconfig.modelId")}>
        <select
          value={modelId}
          onChange={(e) => {
            setModelId(e.target.value);
            setReasoningLevel("");
          }}
          disabled={providerId === ""}
          className={configInputClass}
        >
          <option value="">—</option>
          {modelIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </ConfigField>

      {levels.length > 0 && (
        <ConfigField label={t("zconfig.agentReasoning")}>
          <select
            value={reasoningLevel}
            onChange={(e) => setReasoningLevel(e.target.value)}
            className={configInputClass}
          >
            <option value="">—</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </ConfigField>
      )}

      {override?.modelId && (
        <button
          type="button"
          onClick={() => void clearOverride()}
          className="mt-4 w-full rounded-xl px-3 py-2 text-xs font-medium text-dim active:bg-white/[0.06]"
        >
          {t("zconfig.agentOverrideClear")}
        </button>
      )}
    </ConfigFormSheet>
  );
}

/**
 * The frontmatter fields of a personal agent. Clearing a previously-set
 * model/thoughtLevel sends an explicit null — that is the server's "remove
 * the key" — while a field that was never set and stays empty is omitted.
 */
function PersonalAgentForm({
  target,
  onClose,
}: {
  target: AgentEntryView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const upsertAgent = useAppStore((s) => s.upsertAgent);

  const name = target.name ?? "";
  const modelWas = target.frontmatter?.model;
  const thoughtWas = target.frontmatter?.thoughtLevel;

  const [description, setDescription] = useState(
    target.frontmatter?.description ?? "",
  );
  const [color, setColor] = useState(
    (AGENT_COLORS as readonly string[]).includes(
      target.frontmatter?.color ?? "",
    )
      ? target.frontmatter!.color!
      : "",
  );
  const [model, setModel] = useState(modelWas ?? "");
  const [thoughtLevel, setThoughtLevel] = useState(thoughtWas ?? "");
  const [busy, setBusy] = useState(false);

  const canSubmit = description.trim() !== "";

  async function submit() {
    const body: AgentUpsert = { description: description.trim() };
    if (color !== "") body.color = color;
    if (model.trim() !== "") body.model = model.trim();
    else if (modelWas !== undefined) body.model = null;
    if (thoughtLevel.trim() !== "") body.thoughtLevel = thoughtLevel.trim();
    else if (thoughtWas !== undefined) body.thoughtLevel = null;

    setBusy(true);
    const ok = await applyConfigWrite(
      "update subagent",
      () => upsertAgent(name, body),
      ["agents"],
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <ConfigFormSheet
      title={`${t("zconfig.agentEdit")} · ${name}`}
      busy={busy}
      submitDisabled={!canSubmit}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <ConfigField label={t("zconfig.agentDescription")}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField label={t("zconfig.agentColor")}>
        <ColorPicker value={color} onChange={setColor} />
      </ConfigField>

      <ConfigField
        label={t("zconfig.agentModel")}
        hint={t("zconfig.agentInheritHint")}
      >
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField
        label={t("zconfig.agentThoughtLevel")}
        hint={t("zconfig.agentInheritHint")}
      >
        <input
          value={thoughtLevel}
          onChange={(e) => setThoughtLevel(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={configInputClass}
        />
      </ConfigField>
    </ConfigFormSheet>
  );
}

/**
 * Creating an agent = PUT on a new name. The server seeds a template system
 * prompt; the footer hint points at the desktop for refining it.
 */
function NewAgentForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const upsertAgent = useAppStore((s) => s.upsertAgent);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [model, setModel] = useState("");
  const [thoughtLevel, setThoughtLevel] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = isValidAgentName(name.trim()) && description.trim() !== "";

  async function submit() {
    const body: AgentUpsert = { description: description.trim() };
    if (color !== "") body.color = color;
    if (model.trim() !== "") body.model = model.trim();
    if (thoughtLevel.trim() !== "") body.thoughtLevel = thoughtLevel.trim();

    setBusy(true);
    const ok = await applyConfigWrite(
      "create subagent",
      () => upsertAgent(name.trim(), body),
      ["agents"],
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <ConfigFormSheet
      title={t("zconfig.agentsAdd")}
      busy={busy}
      submitDisabled={!canSubmit}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <ConfigField
        label={t("zconfig.agentName")}
        hint={t("zconfig.agentNameHint")}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField label={t("zconfig.agentDescription")}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField label={t("zconfig.agentColor")}>
        <ColorPicker value={color} onChange={setColor} />
      </ConfigField>

      <ConfigField
        label={t("zconfig.agentModel")}
        hint={t("zconfig.agentInheritHint")}
      >
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField
        label={t("zconfig.agentThoughtLevel")}
        hint={t("zconfig.agentInheritHint")}
      >
        <input
          value={thoughtLevel}
          onChange={(e) => setThoughtLevel(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={configInputClass}
        />
      </ConfigField>
    </ConfigFormSheet>
  );
}

/** The eight server colors as swatches; the dash chip means "leave unset". */
function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className={`size-7 rounded-full transition ${SWATCH[c]} ${
            value === c ? "ring-2 ring-white/80" : ""
          }`}
        />
      ))}
      <button
        type="button"
        onClick={() => onChange("")}
        className={`rounded-lg bg-raised px-3 py-1.5 text-xs ${
          value === "" ? "text-ink ring-1 ring-white/60" : "text-faint"
        }`}
      >
        {t("zconfig.agentColorNone")}
      </button>
    </div>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";
import {
  ConfigField,
  ConfigFormSheet,
  ConfigToggle,
  configInputClass,
} from "../../components/config/ConfigFormSheet";

// Selectable models (ADR-0009). The bridge builds the list as the union of
// config.json and provider_config.json, so a model added in the desktop app
// shows up here without the app merging anything itself.
//
// The payload is an OBJECT, not an array: `available` is the selectable list,
// `providers` describes each provider's rule, and `modelRules` carries the
// per-model properties (context window, reasoning levels) that `available`
// only names. The context window is therefore looked up from `modelRules`,
// joined on `{providerId}/{modelId}` — the only key both halves share.
//
// Editing goes through POST /settings/models, which is an UPSERT: one route
// adds a model to a provider and rewrites its personal rule (enabled, context
// window, reasoning levels). The write is `immediate` — the backend polls the
// provider table — so no restart note ever comes out of this page.
export interface ModelRef {
  providerId?: string;
  providerName?: string;
  modelId?: string;
}

export interface ModelRule {
  providerId?: string;
  modelId?: string;
  enabled?: boolean;
  contextWindow?: number;
  reasoningLevels?: string[];
}

export interface ModelsPayload {
  ok?: boolean;
  models?: {
    available?: ModelRef[];
    providers?: Array<{ providerId?: string; providerName?: string }>;
    modelRules?: ModelRule[];
  };
}

/**
 * The context window for one selectable model.
 *
 * Exported so the response-shape test asserts against the REAL decode rather
 * than a copy that can drift — a copied version passing while the page reads a
 * different path is how four screens once shipped dead.
 *
 * A model absent from the rules (a personal rule with no properties) simply
 * has no window rather than being an error.
 */
export function contextWindowFor(
  model: ModelRef,
  rules: ModelRule[] | undefined,
): number | undefined {
  return (rules ?? []).find(
    (r) => r.providerId === model.providerId && r.modelId === model.modelId,
  )?.contextWindow;
}

/** The rule row for one selectable model — the prefill source for editing. */
function ruleFor(model: ModelRef, rules: ModelRule[]): ModelRule | undefined {
  return rules.find(
    (r) => r.providerId === model.providerId && r.modelId === model.modelId,
  );
}

/**
 * Providers a new model may belong to: the rules block first, then any
 * provider the selectable list names that the block omits (an account plan,
 * typically) — the write accepts whatever provider id, but the picker should
 * offer the ones this machine actually uses.
 */
export function providerOptions(
  payload: ModelsPayload | null,
): Array<{ id: string; name: string }> {
  const out = new Map<string, string>();
  for (const p of payload?.models?.providers ?? []) {
    if (p.providerId) out.set(p.providerId, p.providerName ?? p.providerId);
  }
  for (const m of payload?.models?.available ?? []) {
    if (m.providerId && !out.has(m.providerId)) {
      out.set(m.providerId, m.providerName ?? m.providerId);
    }
  }
  return [...out].map(([id, name]) => ({ id, name }));
}

export function ModelsPage() {
  const { t } = useTranslation();
  const models = useAppStore((s) => s.configModels);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);

  const payload = models as ModelsPayload | null;
  const available = payload?.models?.available ?? [];
  const rules = payload?.models?.modelRules ?? [];

  const [editing, setEditing] = useState<ModelRef | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <ConfigPageFrame
      title={t("zconfig.models")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadConfigSection("models")}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={models !== null}
    >
      {available.length === 0 ? (
        <ConfigEmpty text={t("zconfig.modelsEmpty")} />
      ) : (
        <ConfigBlock>
          {available.map((m) => {
            const key = `${m.providerId ?? ""}/${m.modelId ?? ""}`;
            const contextWindow = contextWindowFor(m, rules);
            const provider = m.providerName ?? m.providerId ?? "—";
            return (
              <button
                key={key}
                onClick={() => setEditing(m)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-white/[0.05]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">
                    {m.modelId ?? key}
                  </span>
                  <span className="block truncate text-[11px] text-faint">
                    {provider}
                    {contextWindow
                      ? ` · ${(contextWindow / 1000).toFixed(0)}k context`
                      : ""}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" />
              </button>
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
          {t("zconfig.modelsAdd")}
        </button>
      </div>

      {editing && (
        <ModelForm
          key={`${editing.providerId}/${editing.modelId}`}
          payload={payload}
          target={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <ModelForm
          key="add"
          payload={payload}
          target={null}
          onClose={() => setAdding(false)}
        />
      )}
    </ConfigPageFrame>
  );
}

/**
 * Add/edit form for one model rule.
 *
 * Blank fields are OMITTED from the write, which under the route's merge
 * semantics means "unchanged" — the API has no way to clear a context window,
 * so the hints say keep rather than clear.
 */
function ModelForm({
  payload,
  target,
  onClose,
}: {
  payload: ModelsPayload | null;
  // Null = adding a model that may not exist yet.
  target: ModelRef | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const upsertModel = useAppStore((s) => s.upsertModel);

  const providers = providerOptions(payload);
  const rules = payload?.models?.modelRules ?? [];
  const rule = target ? ruleFor(target, rules) : undefined;

  const [providerId, setProviderId] = useState(target?.providerId ?? "");
  const [modelId, setModelId] = useState(target?.modelId ?? "");
  const [contextWindow, setContextWindow] = useState(
    rule?.contextWindow ? String(rule.contextWindow) : "",
  );
  const [reasoning, setReasoning] = useState(
    (rule?.reasoningLevels ?? []).join(", "),
  );
  const [enabled, setEnabled] = useState(rule?.enabled !== false);
  const [busy, setBusy] = useState(false);

  const canSubmit =
    providerId.trim() !== "" &&
    modelId.trim() !== "" &&
    (contextWindow.trim() === "" || Number.isFinite(Number(contextWindow)));

  async function submit() {
    const levels = reasoning
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const window = contextWindow.trim();
    setBusy(true);
    const ok = await applyConfigWrite(
      target ? "update model" : "add model",
      () =>
        upsertModel({
          providerId: providerId.trim(),
          modelId: modelId.trim(),
          enabled,
          ...(window !== "" ? { contextWindow: Number(window) } : {}),
          ...(levels.length > 0 ? { reasoningLevels: levels } : {}),
        }),
      ["models"],
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <ConfigFormSheet
      title={target ? t("zconfig.modelsEdit") : t("zconfig.modelsAdd")}
      busy={busy}
      submitDisabled={!canSubmit}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {target ? (
        <p className="mt-3 font-mono text-[11px] text-faint">
          {[target.providerId, target.modelId].filter(Boolean).join(" / ")}
        </p>
      ) : (
        <>
          <ConfigField label={t("zconfig.modelProvider")}>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
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
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="glm-4.6"
              className={configInputClass}
            />
          </ConfigField>
        </>
      )}

      <ConfigField
        label={t("zconfig.modelContextWindow")}
        hint={t("zconfig.modelKeepBlank")}
      >
        <input
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
          inputMode="numeric"
          autoCapitalize="none"
          placeholder="200000"
          className={configInputClass}
        />
      </ConfigField>

      <ConfigField
        label={t("zconfig.modelReasoningLevels")}
        hint={t("zconfig.modelKeepBlank")}
      >
        <input
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="high, medium, low"
          className={configInputClass}
        />
      </ConfigField>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs font-medium text-dim">
          {t("zconfig.enabled")}
        </span>
        <ConfigToggle
          checked={enabled}
          label={t("zconfig.enabled")}
          onChange={setEnabled}
        />
      </div>
    </ConfigFormSheet>
  );
}

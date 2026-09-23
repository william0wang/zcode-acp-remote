import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
  ConfigRow,
} from "../../components/config/ConfigPage";

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
// First cut is read-only: the write endpoints exist (provider enable/rename,
// model add/remove, contextWindow and reasoning-level edits) but a phone is
// the wrong surface for renaming a provider, and the list is what a remote
// user actually wants to check.
interface ModelRef {
  providerId?: string;
  providerName?: string;
  modelId?: string;
}

interface ModelRule {
  providerId?: string;
  modelId?: string;
  enabled?: boolean;
  contextWindow?: number;
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

export function ModelsPage() {
  const { t } = useTranslation();
  const models = useAppStore((s) => s.configModels);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);

  const payload = models as
    | {
        ok?: boolean;
        models?: {
          available?: ModelRef[];
          providers?: Array<{ providerId?: string; providerName?: string }>;
          modelRules?: ModelRule[];
        };
      }
    | null;

  const available = payload?.models?.available ?? [];
  const rules = payload?.models?.modelRules ?? [];

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
            return (
              <ConfigRow
                key={key}
                label={m.modelId ?? key}
                value={m.providerName ?? m.providerId ?? "—"}
                hint={
                  contextWindow
                    ? `${(contextWindow / 1000).toFixed(0)}k context`
                    : undefined
                }
              />
            );
          })}
        </ConfigBlock>
      )}
    </ConfigPageFrame>
  );
}

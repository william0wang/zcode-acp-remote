import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";

// Subagents (ADR-0009): the enable/disable list plus a model override for the
// built-ins. Creating one from the phone is not offered — a subagent is a
// markdown file with a system prompt, and writing that body on a touch
// keyboard is how a broken agent gets committed. The API supports it; the
// screen deliberately does not, and says so.

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

export function AgentsPage() {
  const { t } = useTranslation();
  const agents = useAppStore((s) => s.configAgents);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const setAgentEnabled = useAppStore((s) => s.setAgentEnabled);
  const deleteAgent = useAppStore((s) => s.deleteAgent);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const payload = agents as
    | {
        ok?: boolean;
        agents?: Array<{
          name?: string;
          /** Description lives in the file's frontmatter, not at the top. */
          frontmatter?: { name?: string; description?: string; model?: string };
          enabled?: boolean;
          /** Built-in agents cannot be edited or deleted — the server's word. */
          readOnly?: boolean;
          /** The resolved model override, when one is set. */
          modelSelection?: { modelId?: string; thoughtLevel?: string | null };
          path?: string;
        }>;
      }
    | null;

  const rows = payload?.agents ?? [];

  async function toggle(name: string, enable: boolean) {
    await applyConfigWrite(
      enable ? "enable subagent" : "disable subagent",
      () => setAgentEnabled(name, enable),
      ["agents"],
    );
  }

  async function remove(name: string) {
    setConfirmDelete(null);
    await applyConfigWrite("delete subagent", () => deleteAgent(name), ["agents"]);
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
            // name — is what keeps the enable/delete controls off agents the
            // API would refuse anyway.
            const readOnly = isAgentReadOnly(a.readOnly);
            const description = a.frontmatter?.description;
            // `modelSelection.modelId` is the server's spelling for the
            // override; the frontmatter value is the file's own, which the
            // override wins over when both exist.
            const model = a.modelSelection?.modelId ?? a.frontmatter?.model;
            const thoughtLevel = a.modelSelection?.thoughtLevel;
            return (
              <div key={name} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{name}</span>
                    {description && (
                      <span className="block truncate text-[11px] text-faint">
                        {description}
                      </span>
                    )}
                    {model && (
                      <span className="block font-mono text-[10px] text-faint">
                        {model}
                        {thoughtLevel ? ` · ${thoughtLevel}` : ""}
                      </span>
                    )}
                    {readOnly && (
                      <span className="block text-[10px] text-faint">
                        {t("zconfig.agentBuiltIn")}
                      </span>
                    )}
                  </span>
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
                </div>

                {/* A built-in agent is shipped with the app: there is no file
                    to delete, and the server refuses the enable toggle too —
                    so neither control is offered. */}
                {!readOnly && (
                  <div className="mt-2">
                    {confirmDelete === name ? (
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-[11px] text-amber-300">
                          {t("zconfig.confirmDelete")}
                        </span>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded-lg px-2 py-1.5 text-[11px] text-faint"
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          onClick={() => void remove(name)}
                          className="rounded-lg bg-red-500/20 px-2.5 py-1.5 text-[11px] font-medium text-red-300"
                        >
                          {t("zconfig.delete")}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(name)}
                        className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
                      >
                        <Trash2 className="size-3" />
                        {t("zconfig.delete")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </ConfigBlock>
      )}

      <p className="px-4 pt-3 text-center text-[11px] text-faint">
        {t("zconfig.agentsCreateHint")}
      </p>
    </ConfigPageFrame>
  );
}

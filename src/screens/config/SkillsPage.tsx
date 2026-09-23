import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";

// Discovered skills (ADR-0009): every SKILL.md the bridge found, with its
// enabled state and where it lives.
//
// What may be done to a skill follows its scope, which the bridge reports
// directly (`user` | `agents` | `plugin` | `project`):
//   - user / agents: the user's own trees — deletable, and copyable-to-user is
//     pointless (already there).
//   - plugin: shipped with a plugin — read-only here, deleting it would desync
//     the plugin install.
//   - project: a workspace skill — not deletable remotely (the bridge refuses
//     a path outside its controlled roots) but copyable into the user tree so
//     the user gets an editable copy.
// Enable is a switch for every scope: it is immediate and reversible.

/** Scope values the bridge reports (server skills.ts SkillEntry). */
export type SkillScope = "user" | "agents" | "plugin" | "project";

export const DELETABLE_SCOPES = new Set<SkillScope>(["user", "agents"]);

/** Whether a skill's directory may be deleted through the API. */
export function isDeletableScope(scope: SkillScope | undefined): boolean {
  return scope !== undefined && DELETABLE_SCOPES.has(scope);
}

export function SkillsPage() {
  const { t } = useTranslation();
  const skills = useAppStore((s) => s.configSkills);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const setSkillEnabled = useAppStore((s) => s.setSkillEnabled);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const copySkillToUser = useAppStore((s) => s.copySkillToUser);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const payload = skills as
    | {
        ok?: boolean;
        skills?: Array<{
          path?: string;
          name?: string;
          description?: string;
          scope?: SkillScope;
          enabled?: boolean;
        }>;
      }
    | null;

  const rows = payload?.skills ?? [];

  async function toggle(path: string, enable: boolean) {
    await applyConfigWrite(
      enable ? "enable skill" : "disable skill",
      () => setSkillEnabled(path, enable),
      ["skills"],
    );
  }

  async function remove(path: string) {
    setConfirmDelete(null);
    await applyConfigWrite("delete skill", () => deleteSkill(path), ["skills"]);
  }

  async function copyToUser(path: string) {
    await applyConfigWrite("copy skill", () => copySkillToUser(path), ["skills"]);
  }

  return (
    <ConfigPageFrame
      title={t("zconfig.skills")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadConfigSection("skills")}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={skills !== null}
    >
      {rows.length === 0 ? (
        <ConfigEmpty text={t("zconfig.skillsEmpty")} />
      ) : (
        <ConfigBlock>
          {rows.map((s) => {
            const path = s.path ?? s.name ?? "";
            const scope = s.scope;
            const deletable = isDeletableScope(scope);
            // Copy only makes sense for a skill that is NOT already in the
            // user tree — and it is the one action available for a project
            // skill, which cannot be deleted from here.
            const copyable = scope != null && !isDeletableScope(scope);
            return (
              <div key={path} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">
                      {s.name ?? path}
                    </span>
                    {s.description && (
                      <span className="block truncate text-[11px] text-faint">
                        {s.description}
                      </span>
                    )}
                    <span className="block truncate font-mono text-[10px] text-faint">
                      {scope ? `${t(`zconfig.scope${scope}`)} · ` : ""}
                      {path}
                    </span>
                  </span>
                  {/* Immediate effect, so a switch is the right control — no
                      confirm, no restart. */}
                  <button
                    role="switch"
                    aria-checked={s.enabled !== false}
                    aria-label={t("zconfig.skillEnabled")}
                    onClick={() => void toggle(path, s.enabled === false)}
                    className={`mt-0.5 h-6 w-10 shrink-0 rounded-full transition ${
                      s.enabled !== false ? "bg-emerald-500/80" : "bg-white/[0.12]"
                    }`}
                  >
                    <span
                      className={`block size-5 rounded-full bg-white transition ${
                        s.enabled !== false ? "translate-x-4.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>

                {(deletable || copyable) && (
                  <div className="mt-2 flex gap-2">
                    {copyable && (
                      <button
                        onClick={() => void copyToUser(path)}
                        className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
                      >
                        <Copy className="size-3" />
                        {t("zconfig.skillCopy")}
                      </button>
                    )}
                    {deletable &&
                      (confirmDelete === path ? (
                        <div className="flex flex-1 items-center gap-2">
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
                            onClick={() => void remove(path)}
                            className="rounded-lg bg-red-500/20 px-2.5 py-1.5 text-[11px] font-medium text-red-300"
                          >
                            {t("zconfig.delete")}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(path)}
                          className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-dim active:bg-white/[0.1]"
                        >
                          <Trash2 className="size-3" />
                          {t("zconfig.delete")}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </ConfigBlock>
      )}
    </ConfigPageFrame>
  );
}

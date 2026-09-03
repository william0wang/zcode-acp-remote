import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, Loader2, Search } from "lucide-react";
import { HubApiError, HubClient } from "../lib/hub";
import type { HubProject } from "../lib/types";
import { fmtRelative } from "../lib/time";
import { useAppStore } from "../store/appStore";

// Remote session-create (bridge 0.17.0, ADR-0014): pick one of the machine's
// known projects and start a NEW CLI session in it. The hub spawns (or
// reuses) a serve bridge for the project — a visible terminal REPL on the
// desktop since ADR-0016; the list below is exactly the hub's whitelist — no
// free-form path entry by design.

export function projectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function ProjectCreateDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const profile = useAppStore((s) => s.profile);
  const createProjectSession = useAppStore((s) => s.createProjectSession);
  const [projects, setProjects] = useState<HubProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    const client = new HubClient(profile.hubUrl, profile.token);
    let alive = true;
    client
      .projects()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch((e) => {
        if (!alive) return;
        // Older bridge (<0.17.0): 404 "not found" — the route doesn't exist.
        const msg =
          e instanceof HubApiError && e.status === 404
            ? t("projectDialog.tooOld")
            : `projects: ${e instanceof Error ? e.message : String(e)}`;
        setError(msg);
      });
    return () => {
      alive = false;
    };
  }, [profile, t]);

  const pick = async (workspacePath: string) => {
    if (creating) return;
    setCreating(workspacePath);
    setError(null);
    await createProjectSession(workspacePath);
    // Success swaps the route to ChatScreen and unmounts this dialog with
    // the picker. Failure sets `notice` — surface it HERE as well: this
    // dialog's full-screen overlay hides the picker's notice banner.
    if (useAppStore.getState().activeSessionId) return;
    const n = useAppStore.getState().notice;
    if (n) {
      setError(n.startsWith("notice.") ? t(n) : n);
      // Consumed here — don't repeat it on the picker banner after close.
      useAppStore.getState().dismissNotice();
    }
    setCreating(null);
  };

  const visible = (projects ?? []).filter((p) =>
    p.workspacePath.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 pb-[max(var(--safe-bottom),1rem)]">
      <div className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="flex items-center gap-2 px-4 pt-3">
          <FolderPlus className="size-4 shrink-0 text-cyan-400" />
          <h2 className="flex-1 text-sm font-semibold text-ink">
            {t("projectDialog.title")}
          </h2>
          <button onClick={onClose} className="text-faint" aria-label="close">
            ✕
          </button>
        </div>
        <p className="px-4 pt-1 text-xs text-faint">
          {creating ? t("projectDialog.creatingHint") : t("projectDialog.hint")}
        </p>

        <div className="flex items-center gap-2 px-4 py-2">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("projectDialog.filter")}
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {error && (
            <p className="mx-2 rounded-lg bg-amber-950 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-900">
              {error}
            </p>
          )}
          {!projects && !error && (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-faint">
              <Loader2 className="size-4 animate-spin" />
              {t("projectDialog.loading")}
            </div>
          )}
          {projects && visible.length === 0 && !error && (
            <p className="px-4 py-6 text-center text-xs text-faint">
              {t("projectDialog.empty")}
            </p>
          )}
          {visible.map((p) => (
            <button
              key={p.workspacePath}
              onClick={() => void pick(p.workspacePath)}
              disabled={creating !== null}
              className="mb-1 flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left active:bg-white/[0.05] disabled:opacity-50"
            >
              <span className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {projectName(p.workspacePath)}
                </span>
                {creating === p.workspacePath ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-cyan-400" />
                ) : (
                  <span className="shrink-0 text-[10px] text-faint">
                    {t("projectDialog.sessionCount", { count: p.sessions })}
                  </span>
                )}
              </span>
              <span className="flex w-full items-center gap-2 text-[10px] text-faint">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {p.workspacePath}
                </span>
                <span className="shrink-0">
                  {fmtRelative(p.lastActive, i18n.language)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

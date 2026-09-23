import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import {
  ConfigBlock,
  ConfigEmpty,
  ConfigPageFrame,
} from "../../components/config/ConfigPage";

// MCP servers (ADR-0009): the user config, with a per-server switch. Every
// write here is `needs-restart` — the bridge has to respawn its backend for a
// server list change to reach the agent — which `applyConfigWrite` surfaces
// and the restart affordance on the entry screen resolves.

/** One configured server as the bridge reports it (`readMcpView`). */
export interface McpServerRow {
  name?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
}

/**
 * The server list out of the route's payload.
 *
 * The route wraps it (`{ok, mcp:{servers}}`). Reading `servers` off the top
 * level yields undefined, `.length` is 0, and the page renders its empty state
 * on a machine that has servers configured — indistinguishable from a genuinely
 * empty list. Exported so the response-shape test asserts the REAL decode.
 */
export function mcpServers(payload: unknown): McpServerRow[] {
  const wrapped = payload as { mcp?: { servers?: McpServerRow[] } } | null;
  return wrapped?.mcp?.servers ?? [];
}

export function McpPage() {
  const { t } = useTranslation();
  const mcp = useAppStore((s) => s.configMcp);
  const supported = useAppStore((s) => s.configSupported);
  const loading = useAppStore((s) => s.configLoading);
  const error = useAppStore((s) => s.configError);
  const loadConfigSection = useAppStore((s) => s.loadConfigSection);
  const applyConfigWrite = useAppStore((s) => s.applyConfigWrite);
  const setMcpEnabled = useAppStore((s) => s.setMcpEnabled);
  const deleteMcpServer = useAppStore((s) => s.deleteMcpServer);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const rows = mcpServers(mcp);

  async function toggle(name: string, enable: boolean) {
    await applyConfigWrite(
      enable ? "enable MCP server" : "disable MCP server",
      () => setMcpEnabled(name, enable),
      ["mcp"],
    );
  }

  async function remove(name: string) {
    setConfirmDelete(null);
    await applyConfigWrite("remove MCP server", () => deleteMcpServer(name), ["mcp"]);
  }

  return (
    <ConfigPageFrame
      title={t("zconfig.mcp")}
      onBack={() => useAppStore.getState().openConfig(null)}
      onRefresh={() => void loadConfigSection("mcp")}
      refreshing={loading}
      unsupported={supported === false}
      error={error}
      hasLoaded={mcp !== null}
    >
      {rows.length === 0 ? (
        <ConfigEmpty text={t("zconfig.mcpEmpty")} />
      ) : (
        <ConfigBlock>
          {rows.map((s) => {
            const name = s.name ?? "";
            return (
              <div key={name} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{name}</span>
                    {s.command && (
                      <span className="block truncate font-mono text-[10px] text-faint">
                        {[s.command, ...(s.args ?? [])].join(" ")}
                      </span>
                    )}
                  </span>
                  <button
                    role="switch"
                    aria-checked={s.enabled !== false}
                    aria-label={t("zconfig.mcpEnabled")}
                    onClick={() => void toggle(name, s.enabled === false)}
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

                {/* Every server here is the user's own: the bridge reads
                    `mcp.servers` from cli/config.json, which holds nothing a
                    plugin contributed — plugin enablement lives in a separate
                    block the settings API does not expose. */}
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
              </div>
            );
          })}
        </ConfigBlock>
      )}
    </ConfigPageFrame>
  );
}

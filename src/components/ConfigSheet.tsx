import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/appStore";

// Bottom sheet listing one config option's values (model / mode / thought).
// Selecting dispatches session/set_config_option; the bridge broadcasts the
// resulting config_option_update to every client.
export function ConfigSheet({ optionId, onClose }: { optionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const option = useAppStore((s) => s.configOptions.find((o) => o.id === optionId));
  const setConfigOption = useAppStore((s) => s.setConfigOption);

  if (!option) return null;
  const label = t(`config.${option.id}`, { defaultValue: option.name ?? option.id });

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={onClose}>
      <div
        className="max-h-[65%] w-full overflow-y-auto rounded-t-2xl bg-zinc-950 px-2 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pb-2 text-sm font-medium text-zinc-100">{label}</div>
        {(option.options ?? []).map((v) => {
          const active = v.value === option.currentValue;
          return (
            <button
              key={v.value}
              onClick={() => {
                onClose();
                if (!active) void setConfigOption(option.id, v.value);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${
                active ? "text-blue-400" : "text-zinc-300 active:bg-zinc-900"
              }`}
            >
              <span className="truncate">{v.name}</span>
              {active && <span className="ml-2 shrink-0">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

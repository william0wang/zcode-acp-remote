import { useTranslation } from "react-i18next";
import { useAppStore } from "../store/appStore";

// ACP session/request_permission dialog. First response wins across all
// clients; if we lose the race, $/cancel_request dismisses this dialog.
export function PermissionDialog() {
  const { t } = useTranslation();
  const permission = useAppStore((s) => s.permission);
  const answerPermission = useAppStore((s) => s.answerPermission);
  if (!permission) return null;

  function optionClass(kind: string | undefined): string {
    if (kind?.startsWith("allow")) return "bg-blue-600 text-white";
    if (kind?.startsWith("reject")) return "bg-red-600 text-white";
    return "bg-zinc-800 text-zinc-100";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 pb-[max(env(safe-area-inset-bottom),1.5rem)]">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">{t("permission.title")}</h2>
        <div className="mt-3 flex flex-col gap-2">
          {permission.options.map((o) => (
            <button
              key={o.optionId}
              onClick={() => answerPermission(permission.requestId, o.optionId)}
              className={`rounded-xl px-4 py-3 text-sm font-medium ${optionClass(o.kind)}`}
            >
              {o.name || o.kind || o.optionId}
            </button>
          ))}
        </div>
        <p className="mt-3 text-center text-xs text-zinc-500">{t("permission.hint")}</p>
      </div>
    </div>
  );
}

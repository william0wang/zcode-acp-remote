import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);

// Relative timestamps for the session list (dayjs, ADR 0004). `locale` is the
// app's i18n code ("en" | "zh-CN").
export function fmtRelative(ts: number | undefined, locale: string): string {
  if (!ts) return "";
  return dayjs(ts)
    .locale(locale === "zh-CN" ? "zh-cn" : "en")
    .fromNow();
}

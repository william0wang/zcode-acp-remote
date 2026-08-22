import type { ConnectionProfile, PromptDraft } from "./types";

// Thin wrapper over localStorage (ADR: app-private WebView storage is
// acceptable for a sideloaded personal client; swap implementations here).

const PROFILE_KEY = "zcode-acp:profile";
const LANG_KEY = "zcode-acp:lang";
const PENDING_KEY = "zcode-acp:pending";

export type Lang = "en" | "zh-CN";

export function loadProfile(): ConnectionProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionProfile>;
    if (typeof parsed.hubUrl === "string" && typeof parsed.token === "string") {
      return { hubUrl: parsed.hubUrl, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: ConnectionProfile): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearProfileStorage(): void {
  localStorage.removeItem(PROFILE_KEY);
}

export function loadLang(): Lang {
  return localStorage.getItem(LANG_KEY) === "zh-CN" ? "zh-CN" : "en";
}

export function saveLang(lang: Lang): void {
  localStorage.setItem(LANG_KEY, lang);
}

// Queued (pending) prompt drafts per session id — they must survive session
// switches and app restarts, so they persist alongside the profile. Legacy
// entries (plain strings, pre-attachments) load as text-only drafts.

export type PendingPromptMap = Record<string, PromptDraft[]>;

function isDraft(v: unknown): v is PromptDraft {
  if (!v || typeof v !== "object") return false;
  const d = v as { text?: unknown; images?: unknown };
  if (typeof d.text !== "string" || !Array.isArray(d.images)) return false;
  return d.images.every(
    (img) =>
      img &&
      typeof img === "object" &&
      typeof (img as { data?: unknown }).data === "string" &&
      typeof (img as { mimeType?: unknown }).mimeType === "string",
  );
}

export function loadPending(): PendingPromptMap {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PendingPromptMap = {};
    for (const [sid, val] of Object.entries(parsed)) {
      if (!Array.isArray(val)) continue;
      const drafts = val
        .map((v): PromptDraft | null =>
          typeof v === "string"
            ? { text: v, images: [] }
            : isDraft(v)
              ? v
              : null,
        )
        .filter((v): v is PromptDraft => v !== null);
      if (drafts.length > 0) out[sid] = drafts;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePending(map: PendingPromptMap): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(map));
  } catch {
    // Image payloads can blow past the localStorage quota (a 5 MB passthrough
    // GIF is ~6.7 MB base64). Degrade to text-only drafts rather than losing
    // the queue — staged images then survive only in memory for this run.
    try {
      const stripped = Object.fromEntries(
        Object.entries(map).map(([sid, drafts]) => [
          sid,
          drafts.map((d) => ({ ...d, images: [] })),
        ]),
      );
      if (Object.keys(stripped).length === 0)
        localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(stripped));
    } catch {
      // Storage unavailable — drafts stay in memory for this run.
    }
  }
}

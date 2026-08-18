import type { ConnectionProfile } from "./types";

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

// Queued (pending) prompts per session id — drafts must survive session
// switches and app restarts, so they persist alongside the profile.

export type PendingPromptMap = Record<string, string[]>;

export function loadPending(): PendingPromptMap {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PendingPromptMap = {};
    for (const [sid, val] of Object.entries(parsed)) {
      if (!Array.isArray(val)) continue;
      const texts = val.filter((t): t is string => typeof t === "string");
      if (texts.length > 0) out[sid] = texts;
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
    // Storage full/unavailable — drafts stay in memory for this run.
  }
}

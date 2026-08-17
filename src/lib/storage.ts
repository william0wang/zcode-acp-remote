import type { ConnectionProfile } from "./types";

// Thin wrapper over localStorage (ADR: app-private WebView storage is
// acceptable for a sideloaded personal client; swap implementations here).

const PROFILE_KEY = "zcode-acp:profile";
const LANG_KEY = "zcode-acp:lang";

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

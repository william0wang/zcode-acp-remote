// APP-side launch memory for dynamic workflows (bridge 0.48.0, ADR-0029).
//
// `POST …/start` is the ONLY moment a run's backend id and its ACP session
// id are both in the app's hands — history rows carry the backend
// `parentSessionId`, and nothing server-side maps it back for a remote
// client. So every successful start is recorded here, and this table is the
// single source for "which session owns this run" (open session, run
// detail, resume). Entries can go stale (the bridge restarts, the session
// is closed): consumers treat a 404 `unknown_session` as "read-only row"
// rather than an error.

import type { WorkflowScope } from "./types";

export interface WorkflowLaunch {
  runId: string;
  acpSessionId: string;
  instanceId: string;
  name: string;
  scope: WorkflowScope;
  at: number;
}

// Newest-first array; capped so a long-lived install does not grow it
// without bound. 200 runs ≈ months of launches at any realistic pace.
const STORAGE_KEY = "zcode.workflowLaunches";
const CAP = 200;

function readAll(): WorkflowLaunch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkflowLaunch[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: WorkflowLaunch[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, CAP)));
  } catch {
    // Quota/private-mode failures just lose the memory, never the feature.
  }
}

/** Record one successful launch (re-inserting a runId moves it to the front). */
export function rememberLaunch(launch: WorkflowLaunch): void {
  const rest = readAll().filter((e) => e.runId !== launch.runId);
  writeAll([launch, ...rest]);
}

export function lookupLaunch(runId: string): WorkflowLaunch | undefined {
  return readAll().find((e) => e.runId === runId);
}

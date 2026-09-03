# ADR 0008: Session history is a per-project, on-demand browse/resume surface

## Status

Accepted (2026-09-03). Consumes the server's per-project history endpoint
(bridge 0.19.0, server ADR-0015); pairs with the terminal-REPL session-create
behavior (server ADR-0016).

## Context

Discovery (`GET /api/instances`) only ever listed RUNNING-scoped sessions —
once a conversation was closed on the desktop, the phone had no way to find
it again. The server now exposes the project's full backend session store at
`GET /api/projects/sessions?workspacePath=` (paginated, newest first, rows
carry `live`/`running` and an ISO-string `updatedAt`), and `session/load`
accepts those store ids as-is ("pass-through resume"). Two server-side
behaviors shape the client design: a cold project's first listing incubates
its serve bridge (~12s), and `POST /api/instances` (the resume prerequisite,
and session-create) now opens a visible terminal REPL on the desktop with a ~20s
registration budget (ADR-0016) — closing that window retires the bridge.

## Decision

- **Dedicated dialog, not a merged list**: the picker header gains a History
  entry opening a full-screen sheet (same pattern as ProjectCreateDialog).
  Discovery stays the live-attention list; history is the browse/resume one.
  The same conversation may appear in both under different ids — no
  reconciliation (server ADR-0015 §5).
- **Project first, sessions second**: a two-step drill-down (choose project →
  its paged history) because the endpoint is per-project. No cross-project
  fan-out: every cold project touched would incubate a serve bridge, so
  history is fetched strictly on demand for the one chosen project.
- **Cursor passthrough**: "load more" sends the previous response's
  `nextCursor` (`{before, beforeId}`) back verbatim. Rows carry `updatedAt`
  as an ISO string while the cursor's `before` is epoch ms — recomputing the
  cursor from a row would be wrong; the composite pair is what keeps rows
  tied across a page boundary from being skipped.
- **Read-only rows**: `SessionList` grows a `readOnly` mode (no long-press
  rename/retire — both endpoints are instance-scoped and a closed session
  may not be held by any bridge) plus a `footer` slot for the load-more
  button. `running` rows reuse the existing heartbeat badge; the local
  search box filters loaded pages.
- **Resume reuses the connect path**: `resumeProjectSession` = `POST
  /api/instances` (usually `reused:true` with the listing's instance) →
  `connectInstance(id, sessionId)`, whose auto-attach already issues
  `session/load` with tail replay. No new connection code.
- **Dead bridge is already handled**: a REPL window closed on the desktop
  retires its instance; the existing reconnect probe bounces the user to the
  picker with `notice.instanceGone`, and the next resume/create re-incubates.
- **Long waits are copy, not timeouts**: cold first page (~12s) shows a
  "waking the bridge" spinner; session-create shows "a terminal window opens
  on the desktop, ~20s". No client-side fetch timeouts.

## Consequences

- Closed conversations are resumable from the phone with one tap; live ones
  may appear twice (discovery + history) under different ids — accepted
  duplication, documented in both list hints.
- Browsing history for many projects in sequence incubates a bridge per
  project on the desktop machine; acceptable because each was explicitly
  opened by the user, and serve instances retire with their REPL window or
  after idle per the server's lifetime rules.
- History titles/timestamps are the store's authoritative ones; they can
  differ from discovery rows for the same conversation.
- Bridges older than 0.19.0 answer 404 on the listing — surfaced as a
  "bridge 0.19.0+ required" hint, same pattern as session-create's 0.17.0
  gate.

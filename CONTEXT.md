# zcode-acp-remote

ZCode ACP: mobile Remote Client for zcode-acp-server. A Tauri 2 + React app
that attaches to a Hub over WebSocket and drives the same agent sessions as
the desktop editor. Android-first; iOS deferred.

## Language

Protocol terms (Hub, Bridge, Instance, Remote Client, Session, Broadcast,
Session Authority) are defined by the server glossary at
`../zcode-acp-server/CONTEXT.md`; this app inherits them unchanged.

**Connection Profile**:
The saved Hub URL and bearer token the app dials. Exactly one active profile
in v1.
_Avoid_: server config, account

**Active Session**:
The single session currently loaded in the chat view. Switching sessions is a
`session/load` on the same connection.
_Avoid_: open tab, current chat

**Replay**:
The tail history catch-up a `session/load` (`_meta.zcode.limit`) produces as
`session/update`s; the recovery path after any disconnect. Older history
arrives on demand as prepended `session/load_earlier` pages (cursor from the
attach response's `replayMeta`).
_Avoid_: sync, history download

**Permission Race**:
First-response-wins semantics of interaction requests across clients; losing
clients receive `$/cancel_request`.
_Avoid_: permission conflict

**Approval Card**:
The bottom-sheet surface rendering `session/request_permission` requests —
shown ONLY in the session that raised it (bridge 0.17.0 per-session
semantics); another session's request surfaces through the session list's
awaiting-confirmation badge instead. Three shapes: Plan Approval
(ExitPlanMode), Tool Permission, and Question (AskUserQuestion). Context
shown on the card comes from the tool_call matched by `toolCallId`, never
guessed from the options alone.
_Avoid_: permission dialog, confirm popup

**Remote Session Create**:
Starting a NEW CLI session from the app by picking one of the machine's known
projects (bridge 0.17.0, server ADR-0014): the hub spawns — or reuses — a
serve bridge for the workspace, and the fresh session's cwd is that project.
Since server ADR-0016 the spawn opens a VISIBLE terminal REPL on the desktop
(~20s registration budget), and the owner closing that window retires the
bridge — the app treats the vanished instance like any dead bridge. The
known-project list doubles as the create whitelist; there is no free-form
path entry.
_Avoid_: new tab, project open

**Session History**:
The per-project browse/resume listing of the backend session store (bridge
0.19.0, server ADR-0015) — closed conversations included, newest first,
paged via the server's composite cursor (`{before, beforeId}` passed back
verbatim, never recomputed client-side). Fetched strictly on demand for the
one chosen project: a cold project's first page incubates its serve bridge
(~12s). Resuming loads the store id via `session/load` on the listing's
instance; the same conversation may also appear in discovery under a
different (ACP) id — the surfaces are deliberately not reconciled.
_Avoid_: archive, all-sessions list

**Session Activity**:
The per-session display state in the session list: awaiting confirmation,
running, just finished (60s window after a turn ends), or idle. Derived from
bridge-wide broadcasts; not persisted and unknown for other sessions until the
first broadcast after a reconnect.
_Avoid_: session status, online status

**Session Root**:
The directory a session was created or loaded with; the anchor every
session-file path resolves against. Absolute paths must land inside it;
escapes are rejected server-side.
_Avoid_: workspace, project folder

**Session Files**:
The read-only, hub-proxied view of the active session's files. Breadcrumb
navigation over single-level listings; dotfiles hidden by default with a
toggle. Requires the bridge to advertise the fs capability.
_Avoid_: file manager, explorer

**File Viewer**:
The full-screen reader for one session file: syntax-highlighted text loaded
in line windows, image preview, or a download fallback for other kinds.
_Avoid_: file preview dialog

**Attachment**:
A user-supplied image riding a prompt into the session (gallery pick, camera
shot, or web paste). Travels in-band as an ACP image block, unlike Session
Files which the agent reads and writes in the Session Root.
_Avoid_: upload, media message

# zcode-acp-app

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

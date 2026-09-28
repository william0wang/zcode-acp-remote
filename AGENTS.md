# Agent Instructions

## Project overview

**zcode-acp-remote** (repo directory `~/Develop/tools/zcode-acp-app`) — the
mobile app of the zcode-acp family: talks to a `zcode-acp-server` bridge
(ACP over the hub's WebSocket + the bridge's Settings API) for sessions,
dynamic workflows, push notifications, and settings.

Cross-repo requirement specs and ADRs live in this repo's `.zcode/docs/`
(e.g. `workflow-parity-backend-requirements.md`, `push-backend-requirements.md`).
The backend halves of those specs are implemented in the bridge repo.

## Related project directories (one product family, this machine)

| Path                               | What it is                                                       |
| ---------------------------------- | ---------------------------------------------------------------- |
| `~/Develop/tools/zcode-acp-app`    | This app                                                          |
| `~/Develop/tools/zcode-acp-server` | The bridge (Node: `zcode app-server` ↔ ACP) — implements the backend halves of this repo's specs |
| `~/Develop/tools/zcode-acp-martty` | Source of the Rust `martty` TUI (the bridge's CLI frontend)       |
| `~/Develop/NoBackup/ZCode`         | Open-source ZCode upstream (protocol + desktop source)            |

# ADR 0005: Session Files UI built from off-the-shelf libraries

## Status

Accepted (2026-08-20)

## Context

The bridge (server 0.7.0+) exposes session-scoped, read-only file access over
hub-proxied REST: one-level directory listings (`fs/list`, up to 2000 entries
with a `truncated` marker), file bytes with Content-Type by extension
(`fs/file`), and a text line-window mode (default 200, cap 5000 lines,
`X-Zcode-First-Line` header; server memory is O(limit) so any file size is
safe). The hub accepts the auth token as a Bearer header or `?token=` query
parameter, so `<img src>` and download links work directly. Capability probe:
`initialize` returns `agentCapabilities._meta.zcode.fs === true`.

Project constraint: build the app side from existing, maintained libraries —
no hand-rolled wheels.

## Decision

- **Navigation**: breadcrumb + single-level list (no tree component).
  Virtualize with `@tanstack/react-virtual` (7.4 KB gz, React 19 peers,
  actively maintained). A tree library such as react-arborist drags in
  ~410 KB of drag-and-drop dependencies that are dead weight on Android.
- **Text viewer**: reuse the already-shipped highlight.js (zero new bytes,
  line numbers and incremental loading are ours anyway). Shiki's full bundle
  (1.2 MB gz) and react-syntax-highlighter (527 KB gz) are non-starters on a
  mobile APK; neither provides line numbers or incremental loading built in.
- **Image viewer**: `yet-another-react-lightbox` + its Zoom plugin (12 KB gz,
  zero deps, documented touch pinch-zoom). The zoom plugin wants intrinsic
  image dimensions to compute the max zoom factor; `fs/list` exposes none, so
  a default fallback is used.
- **Everything else**: size + download fallback (`pretty-bytes` optional,
  ~0.6 KB).
- **Auth on media**: the token rides the query string for `<img>`/download
  URLs; the Bearer header stays for JSON calls.
- **Capability gating**: hide the entry point when the bridge does not
  advertise the fs capability (server < 0.7.0).
- **Dotfiles**: filtered client-side by default (server includes them),
  with a visibility toggle.

## Consequences

- ~20 KB gz added to the web bundle.
- "Jump to file tail" is deferred: the line-window protocol is forward-only
  (`X-Zcode-First-Line`), tail-seeking would need a total-line probe that the
  API does not offer.
- Downloads do NOT use `<a download>`: wry 0.55.1 registers no
  DownloadListener on Android (verified in source; its download handler only
  exists for Windows/Linux), so anchor downloads are silently ignored there —
  and the fetch→blob fallback dies on the same path. Instead the binary
  viewer offers Web Share with the fetched file (`navigator.share({files})`,
  works in the system share sheet → save or send anywhere) plus a
  copy-link fallback; both stay pure web so the standalone SPA build keeps
  working.
- A 404 immediately after a bridge upgrade (hub self-learning the route)
  is retried once transparently.

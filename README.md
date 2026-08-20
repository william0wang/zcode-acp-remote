# zcode-acp-remote

[简体中文](README.zh-CN.md) | English

Mobile remote client for [zcode-acp-server](https://github.com/william0wang/zcode-acp):
attach to your Hub over WebSocket from an Android phone and drive the same
agent sessions as your editor. See the server's
[REMOTE-CLIENTS.md](https://github.com/william0wang/zcode-acp/blob/main/docs/REMOTE-CLIENTS.md)
for the transport contract this app implements.

Attach-only — sessions are created in the editor, never here.

## Features

- Session list with live activity badges (running / idle / just finished),
  long-press to retire a session remotely
- Chat with streaming assistant replies, Markdown + code highlight, diff views
- Approve tool permission requests and answer AskUserQuestion forms, even ones
  that fired while the phone was offline (re-delivered after reconnect)
- Prompt queue per session — drafts survive app restarts
- Slash command completion, including `$`-prefixed skills
- Usage quota card with green→yellow→red heat colors
- Reconnect with replay catch-up; transient connection drops stay quiet
- English / 简体中文 UI

## Install

Grab the latest APK from [Releases](../../releases), sideload it, and enter
your Hub URL + remote token in the app.

The app is also a plain SPA — no Tauri APIs are used — so the web build runs
on iOS, desktop, and any other browser. See
[Standalone web deployment](#standalone-web-deployment).

## Server setup

This app is a client; it needs a running zcode-acp-server hub:

1. Install and run [zcode-acp-server](https://github.com/william0wang/zcode-acp)
   in your editor (it bridges the agent over a Hub WebSocket).
2. Set a remote token (`ZCODE_ACP_REMOTE_TOKEN`) when starting the bridge.
3. Expose the hub over `https://` (a tunnel works — the app upgrades
   https→wss itself) or use plain `http://` on your LAN.

## Stack

- Tauri 2 shell (no custom Rust code) — `docs/adr/0001`
- React + TypeScript + Vite, Tailwind CSS v4
- assistant-ui + shadcn-style custom components — `docs/adr/0002`
- Zustand store, native WebSocket + custom reconnect manager
- i18next (default `en`, ships `zh-CN`)

## Development

```bash
pnpm install
pnpm dev                # browser at http://localhost:5173 (fastest loop)
pnpm tauri android dev  # on a device/emulator via adb
pnpm build              # type-check + bundle to dist/
```

## Android APK

```bash
pnpm build:android          # release APK -> dist/, needs a signing key
pnpm build:android:debug    # debug APK -> dist/, no key needed
```

Release builds are signed with a key in `.signing/` (gitignored; create your
own `keystore.jks` + `keystore.properties` there). Identifier: `app.zcode.acp`
(immutable once installed).

The icon set is generated from `scripts/gen-icon.mjs` (SVG via `sharp` →
1024px source) — rerun
`node scripts/gen-icon.mjs && pnpm tauri icon src-tauri/icons/app-icon.png`
after changing the design.

Releasing (maintainers): `pnpm release <version>` bumps all version files,
builds the APK, commits, tags, pushes, and publishes the GitHub Release in
one shot.

## Standalone web deployment

The app is a plain SPA — no Tauri APIs are used — so the web build runs on
iOS, desktop, and any other browser. Deploy it yourself; no backend of your
own is needed: the hub serves `Access-Control-Allow-Origin: *`.

**One click (Netlify)** — forks the repo into your own GitHub account and
builds it for you:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/william0wang/zcode-acp-remote)

**Cloudflare Pages** — fork the repo, then in the Pages dashboard connect it
with build command `pnpm build`, output directory `dist`, and environment
variable `NODE_VERSION=22`.

**Any static host** — the Netlify config ships in `netlify.toml`; Vercel
detects the Vite build automatically; or build locally and upload:

```bash
pnpm build              # -> dist/ (static, self-contained)
pnpm exec vite preview  # local smoke test of the built bundle
```

Caveats:

- A page served over `https://` can only open `wss://` — enter the hub's
  tunneled `https://` URL.
- The token is stored in the browser's localStorage: don't use a shared
  machine, and prefer a private/incognito window for one-off access.

## Docs

- `README.zh-CN.md` — 简体中文文档
- `CONTEXT.md` — glossary for this context
- `docs/adr/` — architecture decisions

## License

[MIT](LICENSE)

# ZCode ACP

Mobile Remote Client for [zcode-acp-server](../zcode-acp-server): attach to
your Hub over WebSocket from an Android phone and drive the same agent
sessions as your editor. See the server's
[REMOTE-CLIENTS.md](../zcode-acp-server/docs/REMOTE-CLIENTS.md) for the
transport contract this app implements.

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

In the app: enter Hub URL + `ZCODE_ACP_REMOTE_TOKEN`, pick a bridge instance,
pick a session. Attach-only — sessions are created in the editor, never here.

## Android APK

```bash
pnpm tauri android build --apk --debug
# -> src-tauri/gen/android/app/build/outputs/apk/universal/debug/
```

Identifier: `app.zcode.acp` (immutable once installed). The icon set is
generated from `scripts/gen-icon.mjs` (SVG via `sharp` → 1024px source) —
rerun `node scripts/gen-icon.mjs && pnpm tauri icon src-tauri/icons/app-icon.png`
after changing the design.

## Standalone web deployment

The app is a plain SPA — no Tauri APIs are used — so `dist/` from
`pnpm build` can be hosted on any static file server (GitHub Pages, Netlify,
Cloudflare Pages, a directory behind nginx…). This gives you iOS, desktop,
and any other browser for free. The hub serves `Access-Control-Allow-Origin:
*`, so no backend of your own is needed.

```bash
pnpm build              # -> dist/ (static, self-contained)
pnpm exec vite preview  # local smoke test of the built bundle
```

Caveats:

- A page served over `https://` can only open `wss://` — enter the hub's
  tunneled `https://` URL (the app upgrades http→ws / https→wss itself).
- The token is stored in the browser's localStorage: don't use a shared
  machine, and prefer a private/incognito window for one-off access.


## Docs

- `CONTEXT.md` — glossary for this context
- `docs/adr/` — architecture decisions

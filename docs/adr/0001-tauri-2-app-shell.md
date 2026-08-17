# Tauri 2 as the app shell

The app is a pure WebSocket client (discovery API + ACP over WS) with no
native API needs beyond what the system WebView provides, so the Rust layer
stays at template default. We choose Tauri 2 over Capacitor (Rust ecosystem
preference, no custom native code needed either way) and over a plain PWA
(installed-app storage that survives, proper resume handling for the
protocol's reconnect-on-resume pattern). Android is the only build target for
now; iOS is deferred, not excluded — adding it later is `tauri ios init` away.

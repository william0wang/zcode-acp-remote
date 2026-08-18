# Off-the-shelf UI primitives before hand-rolled code

Standing rule for this app: for any general-purpose UI capability, use an
existing implementation before writing our own. Concretely — stick-to-bottom
and scroll-to-bottom come from assistant-ui's `useThreadViewportAutoScroll` /
`ThreadPrimitive.ScrollToBottom`, message copy from `ActionBarPrimitive.Copy`,
diff rendering from `react-diff-viewer-continued` (eats the bridge's
`{oldText, newText}` strings with zero conversion; `@git-diff-view/react` was
rejected because it needs pre-computed git diffs and is pre-1.0), relative
timestamps from dayjs, and icon assets from SVG rendered by `sharp` into the
official `tauri icon` pipeline. Only domain logic (the approval card's
protocol mapping, the session-activity state machine) is hand-written, because
no library models ACP's JSON-RPC interaction semantics.

Reversal cost is real (each choice is baked into a rendering layer), and the
choice is deliberate: earlier versions hand-rolled scroll anchoring and a
planned hand-written PNG encoder, which this rule replaces.

# ADR 0007: Attachments travel in-band as base64 ACP image blocks

## Status

Accepted (2026-08-22). Numbering note: "ADR-0006" was already referenced in
code comments for the (never-written-up) session-retire decision, so this
one takes 0007.

## Context

The bridge's prompt handler already accepts ACP image content blocks
(`{ type: "image", data: <base64>, mimeType }`), extracts them via
`extractAttachments`, and forwards them to the backend's `session/send` as
attachments. Its `file://` → `localPath` fast path is only usable by
same-machine editors — a remote phone's filesystem is not the backend host's,
so remote clients must send base64. The hub is a method-agnostic JSON-RPC
passthrough with a 100 MiB frame cap; no upload endpoint exists (adding one
means server work, a second auth path, and orphan-file cleanup). Mobile
photos are 3–8 MB and base64 inflates them by 33%. wry 0.55.1 implements
`onShowFileChooser` on Android (accept filter, `capture` → camera with
permission fallback), so the picker path is available — unlike downloads
(ADR 0005).

## Decision

- **In-band only**: attachments ride the `session/prompt` array as ACP image
  blocks with base64 `data`. No upload endpoint, no capability probing — a
  rejected or ignored block surfaces as a notice.
- **Client-side downsampling**: canvas resample to a 1568px max edge (the
  common multimodal-API safe value). Opaque output → JPEG q≈0.85; transparent
  → WebP. GIF bypasses the canvas (it would drop the animation) and passes
  through if ≤5 MB, otherwise it is rejected with a notice.
- **Limits**: at most 4 images per prompt; images with no text are a valid
  prompt (the server already treats that as non-empty).
- **Sources**: gallery (`accept="image/*" multiple`) and camera (`capture`,
  rendered only on coarse-pointer devices); web additionally gets clipboard
  paste. No drag-and-drop.
- **Queueing**: pending prompts become drafts (text + images) so attachments
  can be staged while a turn is running and flush with their message.

## Consequences

- One wire path (the ACP prompt) and zero server changes for sending; works
  with any bridge that has `extractAttachments`.
- Replay gap: `session/load` replays user messages as text only, so after a
  reconnect the history keeps the text but drops the images (the agent saw
  them; display-only loss). The app renders image parts wherever they appear,
  so a future server-side replay fix lights up with no app change. That fix
  is backlogged on the server repo.
- Payload size is bounded by compression, not by the server: worst case is
  4 passthrough GIFs ≈ 27 MB on the wire — under the ws cap but heavy on
  mobile networks; the 4-image cap keeps it rare.
- Queued drafts persist to localStorage with their base64 payloads; when
  that exceeds the quota, persistence degrades to text-only drafts (staged
  images survive only in memory for the running session).
- Usefulness depends on the backend model being multimodal; a text-only
  model ignores or rejects the block (surfaced as a notice, no pre-flight
  detection).

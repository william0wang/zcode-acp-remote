import type { AttachmentDraft } from "./types";

// Client-side downsampling before base64 hits the wire (ADR 0007).

/** Max images per prompt. */
export const MAX_IMAGES = 4;
/** Longest edge after resampling — the common multimodal-API safe value. */
const MAX_EDGE = 1568;
const QUALITY = 0.85;
// Animated/vector formats must not pass through the canvas (frame/vector
// loss); small ones ride as-is, big ones are rejected.
const PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024;
// Re-encoding only pays off past this size; smaller originals stay untouched.
const REENCODE_MIN_BYTES = 300 * 1024;

export type PrepareResult =
  | { ok: true; image: AttachmentDraft }
  | { ok: false; reason: "tooLarge" | "unsupported" };

export function attachmentDataUrl(img: AttachmentDraft): string {
  return `data:${img.mimeType};base64,${img.data}`;
}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      resolve(typeof url === "string" ? (url.split(",")[1] ?? "") : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

// Sampled alpha scan (~16k pixels): decides JPEG (opaque) vs WebP (alpha).
function hasTransparency(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  const step = Math.max(4, Math.floor((w * h) / 16384)) * 4;
  for (let i = 3; i < data.length; i += step) {
    if (data[i] < 255) return true;
  }
  return false;
}

export async function prepareImage(file: File): Promise<PrepareResult> {
  const mime = file.type || "image/png";
  if (mime === "image/gif" || mime === "image/svg+xml") {
    if (file.size > PASSTHROUGH_MAX_BYTES) {
      return { ok: false, reason: "tooLarge" };
    }
    try {
      return {
        ok: true,
        image: { data: await readAsBase64(file), mimeType: mime },
      };
    } catch {
      return { ok: false, reason: "unsupported" };
    }
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size <= REENCODE_MIN_BYTES) {
      bitmap.close();
      return {
        ok: true,
        image: { data: await readAsBase64(file), mimeType: mime },
      };
    }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return { ok: false, reason: "unsupported" };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const alpha = hasTransparency(ctx, w, h);
    const type = alpha ? "image/webp" : "image/jpeg";
    const blob = await toBlob(canvas, type, QUALITY);
    if (!blob) return { ok: false, reason: "unsupported" };
    // A WebView that cannot encode WebP may answer with PNG — trust the blob.
    return {
      ok: true,
      image: {
        data: await readAsBase64(blob),
        mimeType: blob.type || type,
      },
    };
  } catch {
    // Formats the WebView cannot rasterize (e.g. HEIC on some devices).
    return { ok: false, reason: "unsupported" };
  }
}

// Renders the app icon (SVG -> 1024px PNG) for `tauri icon` to expand into
// the full set. Uses sharp (ADR 0004) — no hand-rolled image encoding.
// Design: dark rounded tile, white terminal chevron, amber cursor block.
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="228" fill="#0d0d0f"/>
  <rect x="56" y="56" width="912" height="912" rx="180" fill="#1e1e22"/>
  <path d="M 330 318 L 566 512 L 330 706"
        stroke="#ececf1" stroke-width="118"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <rect x="628" y="596" width="98" height="114" rx="22" fill="#fbbf24"/>
</svg>`;

await sharp(Buffer.from(svg))
  .resize(1024, 1024)
  .png()
  .toFile("src-tauri/icons/app-icon.png");

console.log("wrote src-tauri/icons/app-icon.png");

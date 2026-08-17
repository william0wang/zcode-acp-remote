import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: true, // reachable from adb devices during `tauri android dev`
    port: 5173,
    strictPort: true,
  },
});

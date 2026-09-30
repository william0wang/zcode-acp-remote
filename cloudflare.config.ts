import { defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "zcode-acp-remote",
    compatibilityDate: "2026-09-25",
    // Keep the workers.dev URL alive alongside the custom-domain route —
    // a trigger deploy disables it when left unspecified.
    workersDev: true,
    observability: {
      enabled: true,
    },
    assets: {
      // SPA fallback: serve index.html for unknown paths (the app's own
      // in-JS routing takes over).
      notFoundHandling: "single-page-application",
    },
    // Serves the production hostname. A zone route takes precedence over the
    // old Pages custom-domain binding on the same host, so the cutover from
    // Pages needed no unbind — drop this to fall back to the Pages project.
    triggers: [triggers.fetch({ pattern: "zcode-acp.10ln.com/*" })],
  },
});

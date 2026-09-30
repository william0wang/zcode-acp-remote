#!/usr/bin/env bash
# Deploy the web bundle to Cloudflare via cf (Workers static assets).
# cf replaced wrangler, and wrangler's Pages direct upload is "legacy Pages"
# in cf — the web app now ships as a Worker; the old Pages project stays
# frozen on its last release as a rollback URL.
# Usage: pnpm deploy:web
# Config via env (or .env.local, gitignored — see .env.local.example):
#   CLOUDFLARE_API_TOKEN    token with Workers deploy permission
#   CLOUDFLARE_ACCOUNT_ID   account ID (dashboard right sidebar)
# `cf deploy` runs the Vite build itself (@cloudflare/vite-plugin) and takes
# the worker name, SPA assets, and the zcode-acp.10ln.com trigger from
# cloudflare.config.ts; without a token cf falls back to its own OAuth login
# (`cf login`). cf runs via pnpm exec (devDependency), no global install.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env.local ]]; then
  set -a; . ./.env.local; set +a
fi

pnpm exec cf deploy

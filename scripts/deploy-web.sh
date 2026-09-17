#!/usr/bin/env bash
# Build the web bundle and push it to a Cloudflare Pages project via direct
# upload (no Git integration). Deploys to *your* Cloudflare account.
# Usage: pnpm deploy:web
# Config via env (or .env.local, gitignored — see .env.local.example):
#   CF_PAGES_PROJECT        Pages project name (default: zcode-acp-remote)
#   CLOUDFLARE_API_TOKEN    token with "Cloudflare Pages: Edit" permission
#   CLOUDFLARE_ACCOUNT_ID   account ID (dashboard right sidebar)
# Without a token wrangler falls back to its own OAuth login
# (`pnpm dlx wrangler login`).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env.local ]]; then
  set -a; . ./.env.local; set +a
fi
: "${CF_PAGES_PROJECT:=zcode-acp-remote}"

pnpm build
# First run creates the project; "already exists" errors are fine — any real
# credential problem resurfaces in the deploy step right after.
# --allow-build: pnpm >=11 hard-fails dlx installs on unapproved postinstall
# scripts (esbuild/workerd ride along with wrangler); the project workspace
# file can't cover the dlx temp dir, so approve them on the command line.
pnpm dlx --allow-build=esbuild --allow-build=workerd wrangler@4 pages project create "$CF_PAGES_PROJECT" --production-branch main 2>/dev/null || true
pnpm dlx --allow-build=esbuild --allow-build=workerd wrangler@4 pages deploy dist --project-name="$CF_PAGES_PROJECT" --branch main

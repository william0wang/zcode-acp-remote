#!/usr/bin/env bash
# Build an Android APK and copy it into dist/ for easy access.
# Usage: scripts/build-android.sh [--debug]
# Release builds are signed with the local key in .signing/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

DEBUG_FLAG=""
BUILD_TYPE="release"
if [[ "${1:-}" == "--debug" ]]; then
  DEBUG_FLAG="--debug"
  BUILD_TYPE="debug"
fi

VERSION=$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")
APK="src-tauri/gen/android/app/build/outputs/apk/universal/${BUILD_TYPE}/app-universal-${BUILD_TYPE}.apk"
OUT="dist/ZCode-ACP-v${VERSION}-${BUILD_TYPE}.apk"

echo "==> building ${BUILD_TYPE} APK (v${VERSION})"
# arm64-only: real devices running this app are all aarch64; the other ABIs
# (armv7/x86/x86_64) only tripled the APK size (36M -> 12M).
pnpm exec tauri android build --apk --target aarch64 ${DEBUG_FLAG}

mkdir -p dist
cp "${APK}" "${OUT}"
echo "==> ${OUT}"
ls -lh "${OUT}" | awk '{print $5, $9}'

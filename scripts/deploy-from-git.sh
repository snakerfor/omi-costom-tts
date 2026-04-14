#!/usr/bin/env bash
set -euo pipefail

REF="${1:-origin/master}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "$APP_DIR"

echo "[deploy] app dir: $APP_DIR"
echo "[deploy] fetching refs"
git fetch --all --tags

echo "[deploy] checking out $REF"
git checkout "$REF"

echo "[deploy] installing dependencies"
npm ci

echo "[deploy] building"
npm run build

echo "[deploy] reloading pm2"
pm2 startOrReload ecosystem.config.js --only omi-custom-tts

echo "[deploy] done"

#!/usr/bin/env bash
set -euo pipefail

# Non-interactive SSH/cron often has no nvm on PATH; load it when present.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[deploy] error: npm not found. Install Node or ensure nvm is at \$NVM_DIR ($NVM_DIR)." >&2
  exit 1
fi

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

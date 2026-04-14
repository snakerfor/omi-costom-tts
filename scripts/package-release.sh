#!/usr/bin/env bash
set -euo pipefail

OUT_FILE="${1:-omi-custom-tts.tar.gz}"

tar -czvf "$OUT_FILE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='*.tar.gz' \
  --exclude='app.db' \
  --exclude='data/*.db' \
  --exclude='data/omi-videos' \
  --exclude='audio-uploads' \
  --exclude='raw_results' \
  --exclude='finalized_results' \
  --exclude='preview_results' \
  --exclude='tests/.tmp' \
  .

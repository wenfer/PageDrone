#!/usr/bin/env bash
# 本地打包扩展为 zip（与 CI 逻辑一致）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
NAME="auto-checkin-v${VERSION}"
OUT_DIR="dist"
ZIP_NAME="${NAME}.zip"

rm -rf "$OUT_DIR/$NAME"
mkdir -p "$OUT_DIR/$NAME"

rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'dist' \
  --exclude 'node_modules' \
  --exclude '.claude' \
  --exclude '.gitignore' \
  --exclude 'scripts' \
  --exclude 'fixtures' \
  --exclude 'market' \
  ./ "$OUT_DIR/$NAME/"

# 附带说明
cp -f README.md "$OUT_DIR/$NAME/" 2>/dev/null || true

(
  cd "$OUT_DIR"
  rm -f "$ZIP_NAME"
  zip -r "$ZIP_NAME" "$NAME" -x "*.DS_Store"
)

echo "Packed: $OUT_DIR/$ZIP_NAME"
ls -lh "$OUT_DIR/$ZIP_NAME"

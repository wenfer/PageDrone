#!/usr/bin/env bash
# 本地打包扩展为 zip。
# WXT 构建后从 .output/chrome-mv3/ 取可加载扩展，再打包到 releases/。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# —— 1. 构建 ——
if [ -d node_modules ]; then
  npm install --no-audit --no-fund
elif [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npm run build

EXTENSION_DIR=".output/chrome-mv3"
[ -f "$EXTENSION_DIR/manifest.json" ] || {
  echo "构建产物缺失：$EXTENSION_DIR/manifest.json" >&2
  exit 1
}

# —— 2. 版本与路径 ——
VERSION=$(python3 -c "import json; print(json.load(open('$EXTENSION_DIR/manifest.json'))['version'])")
NAME="auto-checkin-v${VERSION}"
OUT_DIR="releases"
STAGE="$OUT_DIR/$NAME"
ZIP_NAME="${NAME}.zip"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# —— 3. 从 WXT Chrome 产物取件 ——
rsync -a \
  --exclude '*.pem' \
  --exclude '*.ts' \
  --exclude '*.map' \
  --exclude '*.md' \
  --exclude '*.docx' \
  --exclude 'patent-fig-*' \
  --exclude '.DS_Store' \
  "$EXTENSION_DIR/" "$STAGE/"

# 附带说明
cp -f README.md "$STAGE/" 2>/dev/null || true

# —— 4. 打包 ——
(
  cd "$OUT_DIR"
  rm -f "$ZIP_NAME"
  zip -rq "$ZIP_NAME" "$NAME" -x "*.DS_Store"
)

echo "Packed: $OUT_DIR/$ZIP_NAME"
ls -lh "$OUT_DIR/$ZIP_NAME"

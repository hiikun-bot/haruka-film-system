#!/usr/bin/env bash
# Premiere パネル（ADR 050）を配布用の .ccx にまとめる。
#   ./scripts/build-premiere-plugin.sh
# 出力: public/downloads/haruka-precheck.ccx（/premiere-plugin.html からダウンロードされる）
# パネルを直したら manifest.json の version を上げてから実行し、.ccx も一緒にコミットする。
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=plugins/premiere-precheck
OUT=public/downloads/haruka-precheck.ccx
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$SRC" && zip -q -X -r "../../$OUT" manifest.json index.html main.js telop-parse.js)
echo "built $OUT ($(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['version'])"))"

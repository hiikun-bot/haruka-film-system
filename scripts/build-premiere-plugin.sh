#!/usr/bin/env bash
# Premiere パネル（ADR 050）を配布用の .ccx にまとめる。
#   ./scripts/build-premiere-plugin.sh
# 出力: public/downloads/haruka-precheck.ccx（/premiere-plugin.html からダウンロードされる）
# パネルを直したら manifest.json の version を上げてから実行し、.ccx も一緒にコミットする。
#
# 手元テスト用:
#   ./scripts/build-premiere-plugin.sh --dev <出力先.ccx> <サーバーURL> <トークン>
#   → 接続先に手元サーバーを足し、開いた瞬間に診断とチェックを流す版（dev.json 同梱）。配布しない
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=plugins/premiere-precheck
FILES=(manifest.json index.html main.js telop-parse.js icons)

if [ "${1:-}" = "--dev" ]; then
  OUT="$2"; SERVER="$3"; TOKEN="$4"
  TMP="$(mktemp -d)"
  cp -R "${FILES[@]/#/$SRC/}" "$TMP/"
  python3 - "$TMP" "$SERVER" "$TOKEN" <<'PY'
import json, sys
tmp, server, token = sys.argv[1:4]
m = json.load(open(f"{tmp}/manifest.json"))
# 手元サーバー（http・ポート付き）は domains の書き方では許可されないため、テスト版だけ全許可にする
m["requiredPermissions"]["network"]["domains"] = "all"
v = m["version"].split(".")
v[2] = "99"  # 手元テスト版は x.y.99（4 桁にするとインストーラーが manifest 不正で弾く）
m["version"] = ".".join(v)
json.dump(m, open(f"{tmp}/manifest.json", "w"), ensure_ascii=False, indent=2)
json.dump({"server": server, "token": token, "autorun": True}, open(f"{tmp}/dev.json", "w"))
PY
  rm -f "$OUT"
  (cd "$TMP" && zip -q -X -r "$OUT" "${FILES[@]}" dev.json)
  rm -rf "$TMP"
  echo "built dev $OUT"
  exit 0
fi

OUT=public/downloads/haruka-precheck.ccx
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$SRC" && zip -q -X -r "../../$OUT" "${FILES[@]}")
echo "built $OUT ($(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['version'])"))"

#!/usr/bin/env bash
# つぶやきリアクション用の「動く絵文字」（Noto Emoji Animation・CC BY 4.0）を取得して
# public/img/emoji-anim/<codepoint>.webp（96px・アニメ WebP）に変換する。ADR 044 追補（2026-09-26）
#
# 使い方:  bash scripts/build-emoji-anim.sh            … utils/reactions.js の全種別ぶん（既存はスキップ）
#          bash scripts/build-emoji-anim.sh 1f923 1f525 … 指定コードポイントだけ（上書き）
# 必要なもの: curl / ffmpeg / img2webp（brew install ffmpeg webp）
#
# 経路: 512.gif → ffmpeg で 96px PNG 連番 → img2webp（lossy q65・30ms/frame・loop）
#   ・512.webp を直接使わないのは、手元の ffmpeg が アニメ WebP をデコードできないため。
#     Noto の GIF は全フレーム 30ms 固定なので -d 30 でよい（変わったら ffprobe で確認）。
#   ・96px にするのは、表示先が 18〜26px（Retina で 2〜3 倍）だから。1 個 ≒ 90KB。
# 出力先に無い絵文字（Noto 側に素材が無い 🍺 🙇 💦 💤 など）は 404 でスキップし、静止絵文字のまま。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/img/emoji-anim
mkdir -p "$OUT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

if [ $# -gt 0 ]; then
  CPS=("$@"); FORCE=1
else
  # utils/reactions.js の全種別のコードポイント（FE0F を除き、複数は _ 連結）
  CPS=()
  while IFS= read -r cp; do CPS+=("$cp"); done < <(node -e '
    const R = require("./utils/reactions");
    for (const r of R.ALL_REACTIONS) console.log(R.emojiCodepoint(r.emoji));')
  FORCE=0
fi

ok=0; skip=0; miss=0
for cp in "${CPS[@]}"; do
  dst="$OUT/$cp.webp"
  if [ "$FORCE" = 0 ] && [ -f "$dst" ]; then skip=$((skip+1)); continue; fi
  gif="$TMP/$cp.gif"
  code=$(curl -s -o "$gif" -w "%{http_code}" "https://fonts.gstatic.com/s/e/notoemoji/latest/$cp/512.gif")
  if [ "$code" != "200" ]; then echo "  - $cp: 素材なし ($code) → 静止のまま"; miss=$((miss+1)); continue; fi
  fr="$TMP/fr_$cp"; mkdir -p "$fr"
  ffmpeg -hide_banner -loglevel error -y -i "$gif" -vf "scale=96:96:flags=lanczos" "$fr/%03d.png"
  img2webp -loop 0 -d 30 -lossy -q 65 -m 6 -min_size "$fr"/*.png -o "$dst" >/dev/null
  echo "  + $cp: $(wc -c < "$dst" | tr -d ' ') bytes"
  ok=$((ok+1))
done
echo "done: 変換 $ok / スキップ(既存) $skip / 素材なし $miss  → $(du -sh "$OUT" | cut -f1)"

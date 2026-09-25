# 動く絵文字（emoji-anim）の出どころとライセンス

このフォルダの `*.webp` は **Google の Noto Emoji Animation**（Animated Emoji）を
96px のアニメ WebP に変換したものです（変換手順: `scripts/build-emoji-anim.sh`）。

- 出どころ: https://googlefonts.github.io/noto-emoji-animation/
- ライセンス: **Creative Commons Attribution 4.0 International (CC BY 4.0)**
  https://creativecommons.org/licenses/by/4.0/
- 帰属表示: "Noto Emoji Animation" © Google LLC, licensed under CC BY 4.0. 変更あり（96px に縮小・WebP 再エンコード）。

HFS 内での表示先: つぶやきのリアクション（ピッカーのホバー中・自分が押した直後のピル）。
利用者向けのクレジットは `public/guide-navigation.html` の「つぶやき」欄に記載しています。

ファイル名は絵文字のコードポイント（16 進・FE0F 除く・複数は `_` 連結）です。例: `1f923.webp` = 🤣

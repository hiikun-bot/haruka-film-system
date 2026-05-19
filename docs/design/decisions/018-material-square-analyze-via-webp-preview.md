---
adr: 018
status: Accepted
date: 2026-05-19
tags: [material-square, gemini, ai-analysis, preview, webp, storyboard, cost]
related_tables: [video_file_organization_tests]
supersedes: null
superseded_by: null
extends: null
---

# 018. 素材広場の AI 解析を「プレビュー WebP（60枚ストーリーボード）」経由で行う

- **Status**: Accepted
- **Date**: 2026-05-19
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

素材広場（material-square）では、動画アップロード後に Gemini で自動解析を行い、
タグ・概要・シーン・推奨ファイル名等を生成して整理を支援する。

しかし、現実の運用で次の問題が出ていた：

- **動画長ガード**（`MAX_DURATION_SECONDS=30`）で 30 秒超の動画が `skipped` になる
- **inline 20MB ガード**で 20MB 超の動画も `skipped` になる
- 例: 95.6 秒 / 84.9MB の原本 mp4 は両方の制限に引っかかり解析不能
- ユーザーの動画素材は 1 分超や数十 MB が普通で、「ほとんど解析されない」状態

一方、システムは既に **PR #696 / #697 で「全動画一律 WebP 60枚ストーリーボード
プレビュー」を生成済み** である：

- 動画の 2% 地点〜98% 地点を等間隔 60 枚サンプリングして 1 枚の WebP に並べた絵コンテ
- 通常 ~3MB / `image/webp`
- `preview_drive_file_id` / `preview_status='done'` / `preview_mime_type` に記録
- もともと「一覧画面の高速表示」用に作っていたが、Gemini に渡しても十分タグ/概要/
  シーン抽出ができる品質

## Decision

**`preview_status='done'` のレコードは、Gemini への解析入力を原本ではなくプレビュー
WebP に切り替える。**

実装上のルール：

1. `auto-analyze.js` および `POST /analyze` で、解析ソースを以下の条件で選ぶ：
   - `preview_status === 'done' && preview_drive_file_id` のとき → WebP
   - それ以外 → 原本（従来通り）
2. WebP 使用時：
   - `mimeType` = `image/webp`（または `preview_mime_type`）
   - `mediaKind` = `'image'`
   - 動画長ガード（`MAX_DURATION_SECONDS`）はスキップ
   - 20MB ガードは残す（WebP ~3MB なので通常通る）
3. Gemini プロンプトは、WebP 使用時は専用バリアント
   `video-storyboard-webp` を使う：
   - 「これは動画から等間隔 60 枚サンプリングしたストーリーボードである」と明示
   - `scenes[].time` は `mm:ss` ではなく `frame N/60` 形式
   - 音声情報がない旨を伝える
   - JSON スキーマ（summary/scenes/tags/mood/...）は従来と同じ
4. `prompt_version` を `v3-webp-storyboard-2026-05-19` に上げる（再現性のため）
5. 解析対象 status は `waiting_approval` / `failed` に **`skipped` を追加** する：
   - 既存の skipped レコード（長尺/大容量で弾かれた分）を WebP 経由で救済可能

## Consequences

### Pros

- **動画長制限が実質撤廃**：原本何時間でも、プレビュー WebP さえできれば解析可能
- **サイズ制限が実質撤廃**：原本何 GB でも WebP は ~3MB なので通る
- **課金が大幅減**：Gemini 入力サイズが 84MB → 3MB レベル（28 倍削減）
- **既存 skipped レコードを救済可能**：UI から再解析ボタンが押せる
- **プロンプトは「動画全体の文脈」を保てる**：60 枚の連続フレームから動きや進行を読める

### Cons / Trade-offs

- **音声情報が失われる**：BGM / セリフ / 効果音は解析に使えない
  - 素材広場の解析は「タグ・概要・シーン・推奨ファイル名」が主目的なので影響は限定的
  - 将来必要になれば「音声のみ別途 Gemini に投げる」拡張は可能
- **シーンタイムスタンプが `frame N/60` 表記になる**：従来の `mm:ss` と表記が変わる
  - UI 側で `frame N/60` を時刻表記に戻す変換は今後の検討（動画長が分かるので可能）
- **プレビュー未生成のレコードは従来通り**：30 秒超/20MB 超で skipped になる
  - ただしプレビューは新規アップロードでは自動生成されるため、新規分は問題ない

## Alternatives Considered

### A. 原本の先頭 10 秒だけ切り出して Gemini に渡す

- Pros: 音声が残る
- Cons: 動画全体の構成（オチ・展開）が分からない。広告動画は最後にロゴが出ることが多く、見落とす
- 却下理由：「全体把握」が解析の最重要要件

### B. 原本を等間隔 10 箇所で切り出して連結

- Pros: 音声が一部残る
- Cons: 実装複雑（ffmpeg 切り出し＋連結）。Gemini API への動画長制限にまだ縛られる
- 却下理由：既に WebP 60 枚で十分な情報量があり、追加実装コストに見合わない

### C. Gemini File API（インライン 20MB 制限を回避）に切り替え

- Pros: 原本をそのまま渡せる
- Cons: 動画長制限（Vertex AI 側）は別途残る。課金は減らない。実装も大きい
- 却下理由：WebP 方式で目的（長尺対応・コスト削減）の両方が達成できる

### D. 何もしない（現状維持）

- 却下理由：1 分超の動画が解析されないので、素材広場としての価値が大きく毀損

## Migration / Operational Notes

- DB 列の追加なし。`preview_status` / `preview_drive_file_id` / `preview_mime_type` は
  既存（PR #696 で確定）。
- `prompt_version` が `v2-scenes-2026-05-11` → `v3-webp-storyboard-2026-05-19` に上がる
  ため、`raw_response` 比較などで差異が出る場合がある（後方互換は維持）。
- 既存の `skipped` レコードは UI から再解析ボタンを押せば WebP 経由で救済される。
- `MAX_DURATION_SECONDS` / `MAX_INLINE_BYTES` 環境変数は意味が変わる：
  - 原本にのみ適用される（プレビュー未完成時のフォールバック）
  - プレビュー完成時はバイパスされる

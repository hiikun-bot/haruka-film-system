---
adr: 039
status: Accepted
date: 2026-09-13
tags: [material-square, gemini, ai-analysis, preview, storyboard, cost, guards, filename]
related_tables: [video_file_organization_tests]
supersedes: null
superseded_by: null
related_adrs: [018, 019, 020]
---

# 039. 素材広場 AI 解析 v2 — 「1 コマしか見ていない」解析の是正と、件数上限から予算上限への切替

- **Status**: Accepted（2026-09-14 ユーザー承諾「D1,2,3すべてすすめて」）
- **Date**: 2026-09-13
- **Proposed by**: Claude（調査依頼: 2026-09-13 髙橋聖）

## Context

### きっかけ（2026-09-13 夜）

素材広場「ストリート占い四柱推命はっすい / ショート動画」に iPhone 動画 9 本をアップロード。
先に上げた 5 本は解析・振り分けまで完了したが、後から上げた 4 本（IMG_7245 / 7247 / 7246 / 7248）が
「AI解析待ち」のまま止まり、ファイル名も IMG_xxxx のまま。

### 原因 1（直接）: 日次件数上限 `DAILY_ANALYSIS_LIMIT=5` を使い切った

- 本番の `guards.checkDailyLimit()` は **UTC 日付**で `processed_at` を数える。9/13 は 09:00 JST 起点。
- 19:58〜20:00 JST に 5 本が解析完了 → 上限到達。20:01〜20:11 JST にアップした 4 本は
  `auto-analyze-skip (daily-limit-exceeded)` で待機（`attempt_count=0`, `analysis_status=null`）。
- 「未解析をまとめて解析」ボタンも残り枠 0 なので何も起きない。
- 一方、行を選択して押す「🤖 AI解析する」（`POST /analyze`）は admin の明示操作として
  日次上限を無視する設計（IMG_7251 は 21:38 JST にこの経路で 6 本目として解析済み）。
- UI には「なぜ待機しているか」が一切出ない。ユーザーには「壊れている」ように見える。

### 原因 2（本質）: 解析用 WebP が「60 コマの絵コンテ」ではなく「アニメーション」になっている

ADR 018 は「60 枚を **1 枚の WebP に並べた絵コンテ**」を Gemini に渡す前提で、プロンプトも
「frames are arranged in reading order (left-to-right, top-to-bottom)」と書いている。
しかし実装 `lib/faststart.js` の `_buildWebpFromFrames()` は

```
ffmpeg -framerate 1 -i frame_%03d.jpg -c:v libwebp -loop 0 ...
```

つまり **1fps のアニメーション WebP** を作っている。Gemini は静止画として先頭フレームだけを
読む。本番データで裏が取れている（`needs_human_review=true` の `reason` に Gemini 自身が記述）:

| ファイル | 尺 | Gemini の reason |
|---|---|---|
| 価値の種類は4つある_1_資格に価値があるか？.MOV | 383s | 「提供された画像が **1枚のみ** であり、動画全体の展開や他のシーンが確認できないため」 |
| 価値の種類は4つある_2_自分に価値があるか？.MOV | 79s | 「提供された画像が60フレームのストーリーボードではなく **単一のフレーム** であるため」 |

`scenes` が `frame 10/60 … frame 60/60` と埋まっている行もあるが、1 コマしか渡っていない以上
これは推測で埋めた値。要約・タグ・推奨ファイル名も「先頭 1 コマ + 元ファイル名」だけから作られている。

副次的に、ADR 018 が期待した「動画全体の文脈を読む」効果は出ておらず、
現状の解析単価は本来想定より安い（入力 ≒ 画像 1 枚 + プロンプト ≒ 1k トークン弱）。
**是正すると入力トークンは増える**ので、費用判断が必要。

### 原因 3（品質）: 撮影日が「アップロード日」になる

`auto-apply.js ensureShootDateInFilename()` は元ファイル名に日付が無ければ `created_at`（アップロード日）を使う。
iPhone の `IMG_xxxx.MOV` には日付が無いので、過去に撮った素材を後日まとめて上げると全部その日の日付になる。
QuickTime/MP4 には `creation_time` メタデータがあり、ffprobe（既に同梱）で読める。

### 現状フローと問題点（絵コンテ）

```
[ブラウザ] --原本(〜2.3GB) Drive直送--> [Drive]
                                          |
[Railway] <-- 原本を丸ごとDL(79s/2.3GB) --+
   | ffmpeg: 60コマ抽出 → アニメWebP(3MB) → Drive (UI一覧用プレビュー)   ← ここは良い
   | 自動解析: 日次5件ガード ──X→ 静かに待機（理由はログにしか出ない）
   | Gemini 3.1 Pro に WebP を inline 送信 → 先頭1コマだけ解釈       ← 本質バグ
   | 自動振り分け: 撮影日=アップロード日                                 ← 日付ずれ
```

## Decision（提案）

### D1. 解析入力を「解析用プロキシ動画（低解像度 mp4 + 音声）」にする

UI 用の WebP プレビューはそのまま残し（人が見る分には動く絵コンテとして優秀）、
**Gemini 用に別ファイル**を同じ ffmpeg セッションで作る。

```
原本 ──ffmpeg──┬─> preview.webp   (60コマ 1fps アニメ)   → 一覧UI 用（現状維持）
               └─> analysis.mp4   (60コマ 1fps 480p H.264 + 音声AAC mono 48kbps) → Gemini 用
```

- 映像: 既に抽出している 60 コマをそのまま 1fps の動画に並べる（尺は常に 60 秒）。
  Gemini は動画をネイティブに時系列で読むので、`scenes[].time` を **原本の mm:ss** に戻せる
  （コマ i ↔ 原本秒 = startT + span·i/59 の対応表をプロンプトに添える）。
- 音声: 原本の音声トラック全体を等速で入れる（講演・インタビュー素材は **話している内容**が
  そのまま推奨ファイル名・タグの根拠になる。ADR 018 が捨てた情報を回収）。
  長尺で 20MB inline 上限を超える場合は音声ビットレートを落とす／先頭 15 分に切る。
- 20MB 超・音声ゼロの素材は映像のみ。

### D2. 「1 日 N 件」ガードを「月次予算（円）」ガードに置き換える

- Gemini 応答の `usageMetadata`（prompt/candidates/total tokens）を行に保存し、
  モデル単価表から **1 解析あたりの概算円**を出して `analysis_cost_jpy` に記録。
- ガードは `MONTHLY_ANALYSIS_BUDGET_JPY`（例 3,000 円）。月初〜現在の合計が超えたら自動解析を止める。
  件数ではなく金額で止めるので、短い素材を大量に上げても長尺を数本上げても「使いすぎ」の意味が一貫する。
- 日付の境界は JST（`DAILY_ANALYSIS_LIMIT` を残す場合も JST 日付に直す）。
- 待機中の行には UI に **理由を表示**（「本日/今月の解析枠を使い切ったため待機中。管理者は行を選んで
  『AI解析する』で個別に実行できます」）。

### D3. モデルは用途で分ける（既定は Flash）

タグ・要約・ファイル名提案は Flash 系で十分な可能性が高い。Pro は `needs_human_review=true` の再解析や
手動「AI解析する」時だけに限定する。まず **同じ 10 本を Flash / Pro で解析して比較**してから既定を決める。

### D4. 撮影日は `creation_time` メタデータを最優先にする

`ffprobe` の `format.tags.creation_time`（QuickTime）→ 元ファイル名の日付 → アップロード日 の順。
JST に変換して YYYYMMDD。

## 費用の見立て（1 解析あたり、USD→JPY 150 円換算・概算）

Gemini API 公開単価（2026-09 時点、Vertex も同水準）:

| モデル | 入力 /1M tok | 音声入力 /1M tok | 出力 /1M tok |
|---|---|---|---|
| Gemini 3.1 Pro Preview | $2.00 | $2.00 | $12.00 |
| Gemini 3 Flash Preview | $0.50 | $1.00 | $3.00 |
| Gemini 2.5 Flash | $0.30 | $1.00 | $2.50 |

トークン量の目安（Google 公開の換算: 動画 ≈ 260 tok/秒（既定解像度）、音声 ≈ 32 tok/秒、出力 ≈ 800 tok）:

| 方式 | 入力トークン | Pro | Flash 3 |
|---|---|---|---|
| 現状（実質 1 コマ + プロンプト） | ≈ 1k | ≈ ¥2 | ≈ ¥0.5 |
| D1 映像のみ（60 コマ = 60 秒動画） | ≈ 16k | ≈ ¥6 | ≈ ¥1.6 |
| D1 映像 + 音声 5 分 | ≈ 26k | ≈ ¥9 | ≈ ¥2.9 |
| D1 映像 + 音声 14 分（IMG_7246 級） | ≈ 43k | ≈ ¥14 | ≈ ¥4.5 |

※ Gemini 3 系は `mediaResolution` で動画トークンを下げられる（低解像度で 1/3 程度）。
※ 正確な値は D2 の `usageMetadata` 記録で実測してから予算を決める。

月 100 本・平均 5 分・Flash なら **月 ¥300 前後**、Pro でも **¥1,000 前後**。
現行の「1 日 5 件」は、この単価に対して過度に保守的で、運用上は「止まっているように見える」害の方が大きい。

## 検討した代替案

### A. 60 コマを本当に 1 枚のタイル画像（ffmpeg `tile=6x10`）にして送る

- Pros: 実装最小（フィルタ 1 行）。ADR 018 の意図どおり。
- Cons: Gemini 3 系は 1 画像あたりのトークン上限（≈1.1k）に合わせて縮小するため、
  3840×2160 の絵コンテは 1 コマあたり実質 100px 程度になり、細部（スライド文字・表情）が潰れる。音声も取れない。
- 判断: **暫定パッチとしては可**（D1 実装までのつなぎ）。本命にはしない。

### B. 60 コマを個別の画像パーツとして 60 枚送る

- Pros: 各コマの解像度を保てる。
- Cons: 60 × ≈560 tok ≈ 34k tok と D1 より高く、時系列理解は動画パーツの方が自然。音声も別送が必要。
- 判断: 却下。

### C. 原本をそのまま Files API / GCS 経由で送る

- Pros: 実装は分かりやすい。
- Cons: 14 分動画で ≈ 220k tok（Pro なら 1 本 ¥70 超）。2GB の転送も毎回発生。
- 判断: 却下（ADR 018 と同じ理由）。

### D. ブラウザ側でコマ抽出（canvas）して Railway の原本ダウンロードを省く

- Pros: 2GB の Drive→Railway 往復（79 秒）が消え、アップロード中に解析を先行できる。
- Cons: HEVC の `.MOV` はブラウザ依存でデコードできない環境がある。実装が大きい。
- 判断: 今回は見送り。将来 Railway の帯域・時間がボトルネックになったら再検討。

## 実装順（承諾後）

1. **即日**: 待機理由の UI 表示 + `DAILY_ANALYSIS_LIMIT` の JST 化（費用影響なし）。
2. D4 撮影日（費用影響なし）。
3. D2 `usageMetadata` 記録 + 予算ガード（記録だけ先に入れて実測）。
4. D1 解析プロキシ動画（`prompt_version` を `v4-proxy-video-2026-09` に上げる）。
5. D3 Flash/Pro 比較 → 既定モデル決定。

## 今すぐの運用（コード変更なし）

- 止まっている 4 本は、行を選択 → 「🤖 AI解析する」を 1 本ずつ押せば今日中に解析できる（admin の手動経路は日次上限を無視）。
- または Railway の `DAILY_ANALYSIS_LIMIT` を引き上げる（現状単価 ≈ ¥2/回なので 30 でも上限 ¥60/日）。
- 何もしなければ 翌 09:00 JST（UTC 日付境界）に枠が戻り、「未解析をまとめて解析」で 5 本まで流れる。

## 実装メモ（2026-09-14）

- 費用影響なし分: #1158（待機理由表示・JST 化）/ #1159 + #1160（撮影日 `media_created_at`）
- D1/D2/D3: migration #1161（`analysis_proxy_*` / `analysis_*_tokens` / `analysis_cost_jpy` / `analysis_source`）+ コード PR
- **D1 の実体**: プレビュー WebP は UI 用に据え置き。同じ ffmpeg セッションで
  `<原本名>.analysis.mp4`（60コマ 1fps 480p H.264 無音）と `<原本名>.analysis.aac`（AAC mono 48kbps、最長 30 分）を作り、
  プレビューと同じ Drive フォルダに置く。Gemini には 2 パーツ（video/mp4 + audio/aac）で渡し、
  プロンプト `v4-proxy-video-2026-09-14` でコマ↔原本時刻の対応と「発話内容を名前付けの根拠にする」指示を与える。
  合計 20MB を超える場合は音声を落として映像のみで解析（skip にしない）。
- **旧行の扱い**: `analysis_proxy_video_drive_file_id` が無い行は従来どおり WebP（実質 1 コマ）で解析される。
  v2 品質にしたい行は「プレビュー再生成」（POST /preview/:fileId）でプロキシが作られる（原本の再ダウンロードが要る）。
- **D2 の実体**: `usageMetadata` の promptTokensDetails（AUDIO は音声単価）と candidates+thoughts（出力単価）から
  `guards.estimateCostJpy()` で概算円を出し行に保存。`MONTHLY_ANALYSIS_BUDGET_JPY` が設定されていれば
  月初（JST）からの合計で自動解析・一括解析を待機させる（手動「AI解析する」は止めない）。未設定なら従来の日次件数。
  単価表は `guards.MODEL_PRICING_USD_PER_M`（未知モデルは Pro 単価で安全側）。`USD_JPY_RATE` 既定 150。
- **D3 の実体**: `GEMINI_MODEL`（自動）と `GEMINI_MODEL_MANUAL`（手動「AI解析する」）を分離。
  Vertex で実在確認済みのモデル ID: `gemini-3-flash-preview`（自動の既定に採用）/ `gemini-3.1-pro-preview`（手動）。
  `gemini-3.1-flash-*` / `gemini-3-flash`（preview なし）は 2026-09-14 時点で 404。
- 手動 `POST /analyze` は自動解析と同じ `triggerAutoAnalyzeIfEligible` に集約（重複 200 行を削除）。
- 本番 env（Railway）: `MONTHLY_ANALYSIS_BUDGET_JPY=3000` / `GEMINI_MODEL=gemini-3-flash-preview` / `GEMINI_MODEL_MANUAL=gemini-3.1-pro-preview`。
  `DAILY_ANALYSIS_LIMIT=5` は予算モード中は参照されない（残しておけば予算を外した時に従来動作へ戻る）。

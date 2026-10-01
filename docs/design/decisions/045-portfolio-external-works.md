# ADR 045: 🌐 みんなのポートフォリオ — 案件外の作品は creatives と分離した専用テーブルで持ち、URL／アップロードから AI 提案つきで登録する

- Status: Accepted
- Date: 2026-09-25
- Related: 作品ギャラリー（`migrations/2026-07-23_portfolio_gallery.sql` / ADR 035 系統）, ADR 042（👏 / 💬・ショーケース）, ADR 039（素材広場 AI 解析 v2・月次予算ガード）, Drive resumable 直送（PR #798 / #1155 `driveUploadToSession`）, ADR 015（VIEW AS チェックリスト）, philosophy.md 4 項, feedback「コスト発生は専用フラグでガード」

## Context

🏆 作品ページは `creatives`（＝HFS の案件で納品した成果物）だけを並べる。メンバーが HFS 以外で作った作品（個人制作・前職・他社案件・自分の YouTube 公開作）は載せる場所が無く、「みんなのポートフォリオ」として見せ合うことができなかった。

要望（2026-09-25）:

1. URL を貼れば YouTube に飛べる／Google ドライブで共有してくれれば見られる／データをアップロードすれば取り込む、と**入口を選ばせずに何でも貼れる**こと。
2. 登録に手間をかけない。**1 アップロード → 2 情報は AI が勝手に書く → 3 微修正して登録**の 3 ステップで済むこと。

論点は 4 つ。

1. **データをどこに持つか** — `creatives` に「外部」の印を付けて相乗りするか、専用テーブルにするか。
2. **入口が 4 種類（YouTube / Drive 共有 / 直送アップロード / その他リンク）ある**ことをどう扱うか。
3. **AI 提案の課金**をどう抑えるか（feedback: 外部 API 課金は専用フラグ・予算ガード必須）。
4. **既存の 👏 / 💬 / ⭐（creative_id 前提）**を外部作品にも付けるか。

## Decision

### 1. 専用テーブル `portfolio_external_works` に分離する（creatives に相乗りしない）

- `creatives` は案件・請求・作成本数集計・納期・ボールの起点で、`projects!inner` が無いと一覧に出ない。外部作品を入れると「案件なしの creative」が請求・集計・ホームの全経路に漏れる。
- philosophy.md 4 項「概念の統合より分離」・ADR 042 の判断を継続し、専用テーブルにする。一覧 API（`GET /portfolio`）の**応答の中でだけ**合流させ、`external: true` / `creative_id: null` の item として返す（グループは持ち主単位 `project_id = 'ext:<owner_id>'`）。
- 持ち主は `owner_user_id`（登録者本人）。担当者フィルタ（👤 自分 / 👥 全員 / 担当者）は `owner_user_id` で効く。クライアントで絞ったときとマイベスト表示のときは出さない（外部作品はクライアントも ⭐ も持たない）。
- 系統は既存の 2 軸をそのまま使う。業種は `portfolio_genre_code`（継承元が無いので作品自身の値のみ）、表現は `media_kind` と向きから `derivePortfolioStyle` に流して自動導出＋`portfolio_style_code` で上書き。ファセット集計も通常の作品と同じ判定を通す。
- 削除は論理削除（`deleted_at`）。Drive 上のファイル・元の動画は消さない。

### 2. 入口は「1 つの入力欄」に集約し、種類はサーバーが判定する（`utils/portfolio-external.js`）

- モーダルの入力は URL 欄 1 つとドロップ領域 1 つ。URL の種類判定は純関数 `detectExternalSource`（YouTube → Drive ファイル → その他リンク。Drive の**フォルダ**は登録不可として案内）。
- `source_type` ごとの扱い:
  - `youtube` … oEmbed（キー不要）でタイトル・チャンネル名、`i.ytimg.com` のサムネ、Shorts なら縦。ライトボックスは `youtube.com/embed` の iframe。
  - `drive` … 共有 URL のファイル ID を SA で `files.get`。読めなければ「リンクを知っている全員」にするか SA メールへ共有、と**具体的に案内**する（黙って失敗しない）。再生は既存の `/files/:driveId/direct-url` → `/stream`（`creative_files` に無くても Drive 直で動く）。
  - `upload` … クリエイティブと同じ **ブラウザ → Drive resumable 直送**（`driveUploadToSession` を流用。Railway 5 分 502 を踏まない）。置き場は `<Drive ルート>/🌐 みんなのポートフォリオ/<メンバー名>`。完了後に anyone-reader を付与。
  - `link` … HTML を 512KB まで読んで OGP（`og:title` / `og:image` / `description`）。画像直リンクなら静止画として扱う。カードは画像＋「🔗 リンクを開く」。
- サムネは `youtube` / `link` は URL をそのまま持ち、`drive` / `upload` は `/portfolio/external-works/:id/thumbnail` で代理配信（既存の `/portfolio/thumbnail/:fileId` と同じ方式: 短命 thumbnailLink の隠蔽＋動画は ffmpeg ポスター）。

### 3. AI 提案は「サムネ 1 枚＋テキスト」だけを送り、専用フラグと月次予算でガードする（`lib/portfolio-external-ai.js`）

- 送るのはサムネ画像 1 枚（最大 3MB）とタイトル・説明・チャンネル名・ファイル名。**動画本体は送らない**（1 回あたり 1 円未満の想定）。
- 有効化は `ENABLE_PORTFOLIO_AI_SUGGEST=true` **のみ**（キーやプロジェクト ID の存在では動かさない）。`STOP_ALL` で止まり、`MONTHLY_ANALYSIS_BUDGET_JPY` を超えたら「今月の予算を使い切りました」と返して提案なしで進む。費用は `portfolio_external_works.ai_cost_jpy` に記録し、`guards.checkMonthlyBudget` が素材広場の解析費と**合算**する（ADR 039 D2 の予算を共有）。
- モデルは `PORTFOLIO_AI_MODEL` → `GEMINI_MODEL`（既定 Flash 系）。Gemini 呼び出しは `lib/video-organization/gemini.js` の `analyzeMedia` に `promptText` 上書きを足して共用（認証・IPv4 リトライ・usage 記録をそのまま引き継ぐ）。
- 提案 JSON は `sanitizeAiSuggestion` で**許可された code だけ**に落とす（未知の系統コードは捨てる）。どの項目を AI が埋めたかは `ai.fields` で返し、画面では「AI」バッジと 1 行の注記（モデル・概算円）で見せる。
- AI が使えなかった理由（無効 / 停止中 / 予算超過 / 失敗）は必ず画面に出す。AI が無くても oEmbed / Drive メタ / OGP から初期値は埋まる。
- inspect（読み取り）は 1 人 1 時間 40 回まで（課金の暴走防止）。登録せず閉じた分の費用は記録されない（1 件 1 円未満のため許容。将来増えるなら inspect 時点で記録に変える）。

### 4. 外部作品には 👏 / 💬 / ⭐ を付けない（今回）

- `portfolio_reactions` / `portfolio_comments` / `portfolio_favorites` はすべて `creative_id` の FK。外部作品に付けるには 3 テーブルの列追加＋UNIQUE 変更＋API のキー一般化が要る。
- まず「載せられる・見られる・自分で直せる」を届け、反応は次の段階にする。フロントの部品は `creative_id` が無ければ描かないので、混在しても壊れない。

### 5. 認可は作品ページと同じ（全ロール）。編集・削除は本人 or admin

- 一覧・登録は `requireAuth`（作品ページは全ロール閲覧可）。登録者＝持ち主。
- 編集・削除・実寸の書き戻しは `canEditExternalWork`（本人判定はロールに依らず `req.user.id`、admin は `getEffectiveRoleCodes`・ADR 015）。フロントは API が返す `can_edit_external` で出し分ける。

## Consequences

- 作品ページのツールバーに「＋ 作品を追加」。モーダルは ① 貼る・上げる → ② 読み取り（AI 提案） → ③ 確認して登録 の 3 段。登録後は一覧を引き直してその作品のライトボックスを開く。
- 一覧に「🌐 みんなのポートフォリオ ／ 名前」のグループが持ち主ごとに並ぶ。カード右上に 🌐 / ▶ YouTube / 🔗 のチップ。件数サマリーに「（うち 🌐 外部作品 N件）」。
- ライトボックス右カラムは外部作品専用（元のページを開く／✏️ 編集／🗑 削除。👏 / 💬 / ⭐ は出ない）。
- migration 未適用の環境では `GET /portfolio` が外部作品なしで動く（テーブル無しは warn ログのみ）。登録 API は 503 で「migration を適用してください」と返す。
- Verup 情報: 画面「作品」・機能「🌐 みんなのポートフォリオ」。

トレードオフ:
- 外部作品はショーケース（直近 7 日の納品）には出ない（納品ではないため。ADR 042 の「祝う場」の対象外）。
- Drive の外部共有ファイルは SA からの `permissions.create` ができないので、direct-url が失敗したら `/stream`（サーバー経由）にフォールバックする。大きい動画では Railway の帯域を使う。

## 次の段階（候補）

- 外部作品への 👏 / 💬（3 テーブルの `external_work_id` 化）。
- admin / P が他メンバーの代理で登録（`owner_user_id` の選択）。
- 動画本体から代表フレームを複数抜いて AI に見せる（費用は上がる。ADR 039 のプロキシ生成を流用できる）。

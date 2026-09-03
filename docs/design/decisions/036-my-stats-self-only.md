# ADR 036: マイ実績（自分の納品数・納期遵守・👍）はホームで本人にだけ見せ、admin バイパスも順位・メンバー間比較も設けない

- Status: Accepted
- Date: 2026-09-03
- Related: ADR 032（マイゴール＝本人専用データの前例）, ADR 033（チーム状況＝メンバー間比較を避ける）, ADR 015（VIEW AS チェックリスト）, ADR 009（納品時スナップショット）, ADR 026（delivered_at 基準）, ADR 034（初稿提出 first_draft_submitted_at）

## Context

ホーム画面（editor/designer 向け `renderEditorDash()`、director 向け `renderDirectorDash()`）は「担当中／直近3日／今日の納期／自分の担当」と締切・タスクだけを出しており、**自分が何本納品したか・納期を守れているか・作ったものにどれだけ 👍 が付いたか**をメンバー本人が見る場所が無かった。分析タブ（クリエイター別集計・納期品質）は `analytics.view`＝管理層専用で、メンバーには開かれていない。

一方で ADR 033 は、負荷ダッシュボードを admin＋プロデューサー層に限定した。理由は「メンバー同士の比較・詮索の材料にしない」ことであり、**自分の数字を自分にだけ見せること**はこの原則と矛盾しない。ADR 032（マイゴール）で「本人専用データ＝requireAuth＋`req.user.id` 固定・admin バイパス無し」のパターンが確立しているので、その 2 例目として設計する。

集計の「自分の分」の定義がスレッドごとに割れると、請求プレビュー（`/invoices/preview-items`）や分析（`/analytics/creator-summary`）と本数が食い違って信頼を失う。既存ロジックの再利用が必須。

## Decision

1. **`GET /api/haruka/my-stats` は `requireAuth` のみ。permission key を作らない。**
   見せる範囲を制御する対象（他人の数字）が存在しないため、`role_permissions` に行を足さず、全ロールが自分の分を取得できる。
2. **全クエリを `req.user.id` に固定し、`user_id` パラメータ・admin バイパス・VIEW AS（`X-View-As`）による他人参照は将来も追加しない。**
   コード内コメントに明記。VIEW AS でロールを切り替えても本人のデータが出続けるのは仕様であり、ADR 015 上の権限漏れではない（表示内容が実効ロールに依存しない）。
3. **順位・ランキング・メンバー間比較・他人の数値は今後もこの API／カードから出さない（ADR 033 と整合）。**
   「チーム平均との比較」「今月のトップ」等はメンバー間比較そのものなので、要望が出ても本 ADR を改訂しない限り実装しない。
4. **「自分のクリエイティブ」の判定は共通純関数 `isCreativeOfUser()`（`utils/my-stats.js`）に一本化する。**
   基準は `/invoices/preview-items` と同一: `creative_assignments` に自分の行がある（role 問わず）OR 納品時スナップショット `delivered_director_ids[0]`（無ければ `projects.director_id`）が自分 OR `delivered_producer_ids[0]`（無ければ `projects.producer_id`）が自分（ADR 009）。`snapshotDirectorId` / `snapshotProducerId` も同ファイルへ移し、`routes/haruka.js`（creator-summary / creator-detail / creative-by-assignee / preview-items）はそこを require する。二重定義を作らない。
5. **指標の定義（JST 固定）。**
   | 指標 | 定義 |
   |---|---|
   | 今月納品 / 先月納品 / 累計納品 | `creatives.delivered_at` の JST 月（ADR 026）。累計は `delivered_at IS NOT NULL` の本数 |
   | 今月初稿 | `first_draft_submitted_at` の JST 月（ADR 034）。案件の `billing_timing` によらず「初稿を出した本数」として出す |
   | 納期遵守率（直近3ヶ月） | 当月を含む直近3 JST 月に納品したもののうち `final_deadline` 設定ありを分母、`delivered_at` の JST 日付 `<= final_deadline` を分子（`/analytics/delivery-quality` と同じ判定式）。分母 0 は null（画面は「—」） |
   | 今月の👍 | `creative_file_likes → creative_files → creatives` で、自分の creative のファイルに**他人**が付けた当月分。自分の like は除外 |
   | マイルストーン | サーバー算出・最大2件。優先順: 累計 10/30/50/100/300/500/1000 本を今月跨いだ「🎉 累計N本達成！」→ 次の節目まで10本以内「🎯 あとK本！」→ 直近3ヶ月遵守100%かつ分母≥3 → 今月納品が先月超え |
   時刻は `toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })` で JST 化し、`new Date('Y-M-D')` / `getMonth()` 等のサーバーローカル依存は使わない。jest で `TZ=UTC` / `TZ=Asia/Tokyo` の両方を通す。
6. **配置と表示。**
   カードはホームの挨拶ヒーロー直下（`#dash-my-stats`）。`renderEditorDash()` / `renderDirectorDash()` から `renderMyStatsCard()` を呼び、**`renderAdminDash()` には出さない**（経営数値と混ざるため。admin/secretary/producer は管理者ダッシュ側）。取得失敗時はカードを静かに省略しホームを壊さない。全 0 の新人には「🌱 最初の納品がここに刻まれます」の空状態を出しカードは消さない。フロントにロール分岐は書かない。
7. **パフォーマンス。**
   creatives は「担当（aliased inner join）／自分が D・P の案件／スナップショット D・P」の経路を range ページングで一括取得（PostgREST 1000 行打ち切り対策）。likes は当月分を `creative_files!inner` の embed で 1 経路取得し JS で自分の creative に絞る（大量 ID の `.in()` は URL 長超過事故があるため禁止）。base64 列は select しない。

## Consequences

- メンバーがログインするたびに、自分の納品数・納期遵守・👍 を自分だけが確認できる。他人の数字は出ないので、比較・詮索の材料にならない（ADR 033 の意図を保つ）。
- 請求プレビュー（`/invoices/preview-items`）と同じ `isCreativeOfUser` を使うため、「請求に載る本数」と「マイ実績の本数」の判定基準が一致する（月判定は前者が ADR 034 の計上月、後者は納品月そのものという違いは残す）。
- admin であっても他人のマイ実績は API から取得できない。運用者が誰かの実績を確認したい場合は従来どおり分析タブ（`analytics.view`）を使う。
- permission key が無いため、権限管理画面からカードを特定ロールに非表示にはできない（必要になれば key を追加するが、その際も「本人の分だけ」の原則は変えない）。
- 新テーブル・migration 無し。既存列（`delivered_at` / `first_draft_submitted_at` / `final_deadline` / `delivered_*_ids` / `creative_file_likes`）のみで成立する。

## Alternatives considered

- **A. 分析タブの `analytics.view` を全ロールに開放する**: 他人の数字・金額まで見えてしまい ADR 033 に反する。却下。
- **B. 経営ダッシュボード（`renderAdminDash`）にも本人カードを出す**: 売上予実・全体 KPI と個人実績が同じ画面に並ぶと「会社の数字 vs 自分」の比較に読まれやすく、管理層は分析タブで足りる。却下。
- **C. チーム平均や順位を添えてモチベーションにする**: メンバー間比較そのもの。ADR 033 で退けた懸念（比較・自己防衛的な調整）が再燃するため却下。将来も出さない。
- **D. 「自分の分」を `creative_assignments` の editor/designer だけに絞る**: ディレクター・プロデューサーの納品関与（スナップショット含む）が落ち、preview-items と本数が食い違う。却下。
- **E. フロントの `allCreatives` から集計する**: `GET /creatives` は limit=500 かつ既定で納品除外のため累計が出せない（ADR 033 と同じ理由）。サーバー集計にする。

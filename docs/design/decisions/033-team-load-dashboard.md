# ADR 033: チーム状況（チーム負荷ダッシュボード）は実務データの自動集計とし、閲覧を admin + プロデューサー層に限定する

- Status: Proposed
- Date: 2026-08-21
- Related: ADR 003（roles-as-master-data）, ADR 015（VIEW AS チェックリスト）, #1052（producer_director 合成ロールは兼任者のみ）

## Context

「誰にどれくらい仕事が乗っているか」をプロデューサー・admin が把握する手段が、これまで各画面（クリエイティブ一覧のフィルタ・ダッシュボードのマイタスク等）を目視で行き来する運用しかなかった。仕事を配る側が負荷を見誤ると、特定メンバーへの偏り・納期超過の見落としにつながる。

検討にあたってのチームビルディング上の論点が 2 つあった。

1. **自己申告か、実データか。** 「忙しさ」を本人の申告で集めると、申告のうまさ・遠慮の差が数字に混ざり、負荷把握が目標管理・評価の話に滑りやすい。個人の目標管理ツールとは完全に分離し、システム上の実務データ（creatives / creative_assignments / ボール保持者 / 納期）の自動集計だけを扱う。
2. **誰に見せるか。** メンバー全員に開放すると「あの人は少ない」「自分ばかり多い」といったメンバー同士の比較・詮索の材料になる。負荷の把握は「仕事を配る責任者」の業務であり、比較の道具ではない。

## Decision

- 新ページ「📊 チーム状況」（`#page-team-load` / `GET /api/haruka/team-load`）を追加する。
- **閲覧は admin + プロデューサー層のみ**。新 permission key `team_load.page` を新設し、既定 seed は admin / producer / producer_director（#1052 以降、合成 TEXT 行は producer と director を両方持つ兼任者のみに適用）を true、それ以外（secretary / director 単独 / editor / designer / external_director）を false とする。
- **集計はサーバー側一括**（フロント allCreatives からの集計は禁止。`GET /creatives` は limit=500 上限で取りこぼすため）。集計ロジックは `utils/team-load.js` の純関数（DB 非依存・jest テスト `tests/utils/team-load.test.js`）に置き、routes 側はデータ取得＋純関数呼び出しのみ。

### 集計定義（数値の意味）

| 指標 | 定義 |
|---|---|
| 進行中CR数 | 担当（`creative_assignments.role IN ('editor','designer','director_as_editor')`）かつ status が「保留」以外の未納品クリエイティブ数 |
| 持ちボール数 | `getBallHolder()` の `user_ids[]`（複数ホルダー対応）に本人が含まれる未納品クリエイティブ数。`ball_holder_id` キャッシュ列は通知用の単数値（複数ホルダーの先頭しか入らない）のため**使わない** |
| 今週期限数 | 担当クリエイティブのうち `final_deadline` が今日〜今週日曜（JST・週=月〜日。`_todayStrJST()` / `_thisSundayStrJST()` を再利用し既存 UI と週定義を一致） |
| 期限超過数 | 担当クリエイティブのうち `final_deadline` < 今日（JST）・未納品。**保留も期限系には含める**（保留でも納期は生きており超過リスクの可視化が目的） |
| 高負荷判定 | `isHighLoad()`: balls>=4 または dueThisWeek>=5 または overdue>=1 → high ／ balls>=2 または dueThisWeek>=3 → mid ／ それ以外 low。閾値根拠は `utils/team-load.js` のコメント参照 |

## Consequences

- プロデューサー・admin がアサイン判断の前に負荷の偏り・超過リスクを 1 画面で確認できる。
- メンバーには表示されないため、数字がメンバー間比較・自己防衛的な申告調整の材料にならない。
- 実データ集計なので「入力してもらう」運用コストがゼロ。逆に、assignments やステータスの登録が雑な案件は数字に出ない（データ整備のインセンティブにもなる）。
- 閾値（high/mid）は実務感覚の初期値であり、運用しながら `utils/team-load.js` の定数で調整する。

## Alternatives

- **自己申告ベースの負荷入力**: 申告の個人差が混ざり、目標管理・評価と癒着する。却下。
- **全員閲覧（透明性重視）**: 比較・詮索のコストがメリットを上回ると判断。将来「本人にだけ自分の行を見せる」拡張は検討余地あり（その場合も他人との比較 UI は出さない）。
- **ball_holder_id キャッシュ列での集計**: 複数ホルダー（Dチェック複数・Wチェック複数等）の 1 人しか数えられず、チェック系ロールの負荷が過少になる。却下。

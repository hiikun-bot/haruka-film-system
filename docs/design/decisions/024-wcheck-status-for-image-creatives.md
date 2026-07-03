# ADR 024: 静止画クリエイティブの「Wチェック」工程

- Status: Accepted
- Date: 2026-06-24
- 関連: バグ報告 aa11784a / [016-project-work-type-and-ball-state](016-project-work-type-and-ball-state.md) / [012-creative-category-field-visibility](012-creative-category-field-visibility.md) / [003-roles-as-master-data](003-roles-as-master-data.md)

## Context

静止画クリエイティブでは、ディレクターによる **Dチェック** の前に、別担当者が確認する **Wチェック（ダブルチェック）** を行う運用が増えている。
現状システムには Wチェックのステータスが無く、Dチェックに移行したうえで Wチェック担当者を追加メンションして代替している。その結果:

- Dチェック画面に「担当ディレクター」と「Wチェック担当者」が同列に並び、今誰の番か判別できない
- Wチェック完了の引き継ぎがチャット連絡に依存し、連絡漏れ・進捗分散が起きる

目的は「画面を見ただけで “今は誰が確認する番か” が分かる」状態にし、WチェックからDチェックへの引き継ぎをシステム内で完結させること。

Wチェックは **静止画（`creative_categories.code = 'image'`）でのみ** 使う。動画編集等では不要。

## ステータス系統の前提（016 / 既存実装）

クリエイティブのステータスは 2 系統に分裂している:

- **固定ステータス系**（動画 / 静止画）: `creatives.status`（日本語ラベル）。`ALLOWED_STATUS`（routes/haruka.js）と `_CV_STATUS_LIST`（haruka.html）で定義。進捗バーは `updateCreativeStepIndicator()`。
- **テンプレート駆動系**（LP / HP / LINE）: `creatives.status_code`。

静止画は **固定ステータス系** を使う。よって Wチェックは固定ステータス系に追加する。
ただし固定ステータスは動画と静止画で共有されるため、Wチェックの **UI/動線は静止画カテゴリのときだけ** 出す。

## Decision

### 1. 新ステータス（固定ステータス系に追加）
- `Wチェック`（制作 → **Wチェック** → Dチェック → Pチェック → CL確認 → 納品）
- `Wチェック後修正`（Wチェックでの修正依頼で制作担当へ差し戻す先。`Dチェック後修正` と同型）

進捗バーの段階は静止画かつ Wチェック有効案件のときだけ「制作 → Wチェック → Dチェック → …」を表示する。

### 2. 必要 / 不要の判定（**2層: 案件の初期値 ＋ クリエ個別**）※2026-06-24 改訂2
設計を2回見直した。最終形は **2層モデル**:

| 層 | 列 | 意味 |
|---|---|---|
| カテゴリ既定 | `creative_categories.wcheck_default`（image=true seed） | 新規案件作成時の初期値の素 |
| **案件の初期値** | `projects.wcheck_required`（NULL=カテゴリ既定継承） | その案件のクリエイティブ初期値（案件マスターで設定） |
| **クリエ個別** | `creatives.wcheck_required`（NULL=案件初期値継承） | そのクリエイティブだけのON/OFF（詳細モーダルで設定） |

- 実効値 `effective = creatives.wcheck_required ?? projects.wcheck_required ?? category.wcheck_default`
- **案件マスター** = その案件で新しく開くクリエイティブの**初期値**を決める（案件全体の既定）。
- **クリエイティブ詳細のチェック** = **そのクリエイティブだけ**でWチェックするか（案件の初期値を個別に上書き）。
- どちらも image カテゴリのときだけ表示。ハードコードせずマスタ駆動。

**静止画案件は基本「あり」**。既存の静止画案件は `projects.wcheck_required = true`（PR #869 migration 済）。`creatives.wcheck_required` は NULL（=案件初期値を継承）が基本で、個別に変えたいクリエだけ true/false を持つ。

### 2-b. 操作UI（誤操作防止）
- クリエイティブ詳細モーダルのチェックボックス = **このクリエ個別**（`PUT /creatives/:id { wcheck_required }`）。ON/OFF 変更時は**確認ダイアログ必須**（誤って外す事故防止）。
- 案件マスター（案件編集モーダル）= **案件のクリエイティブ初期値**（`PUT/POST /projects { wcheck_required }`）。カテゴリが静止画のときだけ表示・初期値あり。

### 2-c. 列の経緯（migration 不要・コードのみ）
`creatives.wcheck_required`（#867）・`projects.wcheck_required`（#869）・`creative_categories.wcheck_default`（#867）は全て適用済み。本改訂は resolution と UI の結線変更のみで **DB変更なし**。

### 3. ボール管理（016 の getBallHolder を踏襲）
- `creative_assignments.role = 'wcheck'`（単数。`role` に CHECK 制約は無いため値追加のみ）
- `getBallHolder('Wチェック')` → `wcheck` assignee（type `'wcheck'`）
- `getBallHolder('Wチェック後修正')` → editor（`Dチェック後修正` と同じく制作担当へ戻す）
- `ball_holder_id` キャッシュ同期（`syncBallHolderId`）と `notify_ball_returned` トリガーはそのまま機能する

### 4. 操作と認可（バックエンド強制）
すべて既存の `PUT /creatives/:id` に統合（遷移 audit `creative_status_transitions` / ball 同期 / 通知 / version-history snapshot を再利用）:

- **Wチェックへ回す**（制作系 → `Wチェック`）: `wcheck_user_id` で担当者を `role='wcheck'` に同期。静止画カテゴリ以外は 400。担当ディレクターを `wcheck_user_id` に指定したら 400。
- **Wチェック承認**（`Wチェック` → `Dチェック`）: **Wチェック担当者本人または admin のみ**（それ以外 403）。以降は既存 Dチェック通知でディレクターへ引き継ぎ。
- **Wチェック修正依頼**（`Wチェック` → `Wチェック後修正`）: **Wチェック担当者本人または admin のみ**。コメント（`director_comment`）必須。ボールは制作担当へ。
- 修正後は再提出で `Wチェック後修正` → `Wチェック`（再度Wチェックへ）。

`wcheck_required` トグルは `project.create_edit` 権限が必要。

#### 改訂3（2026-07-03・バグ報告 892c2fea）: トグル権限を `creative.wcheck_toggle` に変更
実際に制作・提出を行うデザイナー / ディレクターが「Wチェック不要 → Dチェック直行」を選べず、
Wチェックを必ず経由しなければならなかった。専用 permission_key **`creative.wcheck_toggle`** を新設し、
既定で **admin / secretary / producer / director / designer** に付与（editor は既定 OFF・権限管理画面で変更可）。
判定は `creative.wcheck_toggle` **または** 従来の `project.create_edit` の OR（migration 未適用環境の後退防止）。
producer_director 行は seed しない（dual-read 互換分岐の副作用回避。producer / director 行の継承でカバー）。
migration: `migrations/2026-07-03_creative_wcheck_toggle_permission.sql`。

### 5. 通知（既存 notification_type 'creative_status' を再利用）
`notifications.js#notifyCreativeStatusChange` に分岐追加。新しい notification_settings 列は作らない（D/P チェックと同じ 'creative_status' 型）:
- `→ Wチェック`: Wチェック担当者へ「Wチェックを依頼されました」
- `→ Wチェック後修正`: 制作担当へ「Wチェックから修正依頼があります」
- `→ Dチェック`（Wチェックから承認）: 既存 Dチェック通知でディレクターへ「Dチェックをお願いします」

### 6. 履歴
`creative_status_transitions`（誰が・いつ・コメント snapshot）で依頼/修正依頼/承認の各遷移を記録（既存自動 INSERT）。
加えて現在の Wチェック情報パネル表示用に `creatives.wcheck_requested_by / wcheck_requested_at / wcheck_comment` を保持。

## Consequences
- 動画 / LP / HP / LINE / 既存静止画は `wcheck_required` 不要扱いで完全に従来通り。`getBallHolder` / transitions / 通知は **拡張のみ**（破壊変更なし）。
- スキップ機能（権限者が個別に飛ばす）は v1 範囲外（次段）。v1 はカテゴリ単位の要否トグル + 本体フローを最優先で実装。

## Alternatives considered
- **テンプレート駆動系へ移行**: 静止画を `status_code` 化する案。影響範囲が過大で却下。固定ステータス系のまま最小拡張する。
- **案件(project)単位フラグ**: クリエ個別の例外設定がしづらく却下。カテゴリ既定 + クリエ個別上書きを採用。
- **専用エンドポイント新設**: transitions/ball/通知/snapshot を再実装する必要があり重複。既存 `PUT /creatives/:id` に統合し認可ガードのみ追加。

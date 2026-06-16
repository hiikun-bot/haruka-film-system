# ADR 019: 素材広場 / AI 解析完了で自動振り分け（適用ボタン廃止）

- Status: Accepted
- Date: 2026-05-19
- Related: ADR 018 (WebP プレビュー経由解析), Stage 1 (DRY_RUN apply MVP)

## Context

旧仕様 (Stage 1) では、AI 解析完了後に管理者が右パネルの「✅ 適用する」ボタンを押すと
`POST /apply` が呼ばれ、Drive 上のファイル名変更・フォルダ移動を実行する設計だった。
ところが実体は DRY_RUN モードのまま放置されていて、ボタンを押しても
「予定差分を返すだけ・Drive 上は無変更」の挙動が継続していた。

UX 観点でも以下の問題があった:

- アップロード→解析→確認→適用 の手数が多く、ほぼ全件「適用する」を押すだけになっていた
- DRY_RUN だと気付かず「整理が走ったはず」とユーザーが誤認識する
- 素材広場フォルダは Shared Drive に置かれており、SA はメンバーではないため
  そもそも SA で適用しても 403/204(no-op) になる構造的問題があった

## Decision

1. AI 解析完了 (`status='analysis_completed'`) になった直後、サーバ側で自動的に Drive 適用を実行する。
2. Drive 操作（フォルダ作成・親変更・リネーム）は **user OAuth** で実行する（Shared Drive メンバー権限を持つ本人のトークン）。
3. `needs_human_review=true` のときは自動適用せず、`status='awaiting_review'` で停止する。UI の右パネルに「確認して適用」ボタンを出す。
4. Drive 操作が失敗したときは `status='apply_failed'` + `error_message` を残し、「再適用」ボタンで再実行できる。
5. UI から「✅ 適用する」ボタン (`ms-btn-apply`) を撤去する。`POST /apply` は手動再実行口（awaiting_review / apply_failed 限定）として残す。

### 詳細手順（auto-apply.js）

1. `recommended_folder` を `/` で split し、各階層フォルダを user OAuth で `files.list`→無ければ `files.create`。
2. 終端フォルダ ID を取得後、`recommended_filename` が同名で既にあれば `_2`, `_3`, ... を末尾に付与。
3. 原本ファイルを `files.update`（`addParents`/`removeParents` + `name`）で移動＋リネーム。
4. プレビュー webp も同フォルダへ移動（ファイル名はそのまま）。失敗してもログのみで致命としない。
5. DB 更新: `status='applied'`, `current_filename`, `current_parent_folder_id`, `current_parent_folder_name`, `applied_at`, `applied_by`。

### Status 拡張

```
waiting_approval → processing → analysis_completed
                                    ├─→ applied            (自動 or 手動 / 成功)
                                    ├─→ awaiting_review    (needs_human_review=true)
                                    └─→ apply_failed       (Drive 操作失敗)
awaiting_review / apply_failed → (手動 /apply 再実行) → applied | apply_failed
```

migration: `migrations/2026-05-19_video_org_apply_statuses.sql`

## Consequences

### Positive
- アップロードしておけば数秒〜数十秒後に整頓された状態になる（手数ゼロ）。
- DRY_RUN の混乱が消える。
- needs_human_review が真の意味で「人の確認が必要」を表す状態になる。
- Drive 操作は user OAuth で正規に動くため、Shared Drive で 403/no-op になる問題が解消。

### Negative / Risks
- user OAuth トークンが切れている場合に自動適用が必ず失敗する → `apply_failed` で UI に通知し、再連携→再適用の動線で復旧可能。
- 自動適用は fire-and-forget なので、即時のエラー通知はトーストでなく一覧の状態カラムに表示される。

## Alternatives Considered

- **SA で適用する案**: Shared Drive にメンバー追加すれば可能だが、運用上 SA を共有ドライブに常駐させたくなく、削除フローと同じく user OAuth に統一する方が一貫性が高い。
- **手動ボタンを残す案**: UX の手数が増え、Stage 1 同様に「押し忘れ・押し過ぎ」運用負荷がある。確認が必要なケースだけ手動を残す方が良い。

## 改訂履歴

### 2026-06-16 改訂（PR #812 + ファイル名編集 / 確認ボタン廃止）

運用実態に合わせて Decision 2・3 を改訂し、手動リネームを追加した。

- **Decision 2 を撤回 → Drive 操作は SA（サービスアカウント）に統一**（PR #804 / #812）。
  アップロード（resumable セッション発行含む）・案件フォルダ作成・メタ取得・削除フォールバックが
  すべて SA 所有に統一された結果、適用だけが user OAuth（`drive.file`）のままだと SA 所有の共有
  ドライブのフォルダ/ファイルを「存在しない」扱いで `404 File not found` を返し、再適用が必ず失敗
  していた。`applyForRow` の Drive 操作（フォルダ作成・移動/リネーム・プレビュー移動）を
  `driveLib.getDriveService()`（SA）に統一。当初 Alternatives で退けた「SA で適用する案」を採用した
  形（SA は実運用上すでに共有ドライブのメンバー）。
- **Decision 3 を撤回 → `needs_human_review` でも止めず常に自動適用**。
  「確認して適用する」(`ms-btn-apply-review` / `awaiting_review`) 動線を廃止。AI 解析完了で必ず
  Drive 振り分けまで走らせる。`awaiting_review` ステータス自体は旧データ互換のため残すが、新規には
  発生しない。`apply_failed` の「↻ 再適用」だけ手動口として残す。
- **追加: ファイル名のインライン編集**（`POST /rename`）。
  右パネル「振り分け提案」欄の📄ファイル名を ✏️ でインライン編集 → 💾 保存で、Drive 上の実ファイルを
  SA でリネームし、`current_filename` / `recommended_filename` を揃える。拡張子はユーザー入力に拡張子
  が無ければ元ファイルの拡張子を補完して保護する。提案名が気に入らない場合は適用後にこの編集で直す運用。

### Status 遷移（改訂後）

```
waiting_approval → processing → analysis_completed
                                    ├─→ applied        (needs_human_review に関わらず自動 / 成功)
                                    └─→ apply_failed   (Drive 操作失敗)
apply_failed → (手動 /apply 再実行) → applied | apply_failed
applied → (画面ファイル名編集 /rename) → applied（current/recommended_filename 更新）
```

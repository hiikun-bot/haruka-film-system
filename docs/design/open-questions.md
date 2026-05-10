# 進行中・未決の設計議題

確定したら `decisions/NNN-*.md` に移す。

---

## Q1. ball_holder_id の冗長カラム化を解消するか

**現状**: [creatives.ball_holder_id](../../supabase_schema.sql) に「今このクリエイティブのボールを持っている人」が冗長カラムとして保存されている。`creative_assignments` + `creative_status_audit` から導出可能。

**問題**:
- 状態変化のたびに ball_holder_id を手動更新する責務がコード側に分散
- 更新漏れ = silent skip バグの温床

**選択肢**:
- (A) **ビュー化**（推奨）: `v_creative_ball_holder` を作って ball_holder_id カラム廃止
- (B) **状態テーブル分離**: `creative_state` テーブルに切り出してトリガで自動更新
- (C) **現状維持＋関数集約**: `updateBallHolder(creativeId)` 1関数に集約、全ての status 変更経路から必ず呼ぶ
- (C → A の段階移行) 既存資産を活かしつつ最終的に DB に寄せる

**未決ポイント**: 案A/B/C のどれにするか、および移行の段階分け。

---

## Q2. users.role の合成 enum をどう解体するか

**現状**: `users.role` に admin / secretary / producer / **producer_director** / director / editor / designer の enum 値。`producer_director` が合成値で破綻のサイン。

**問題**:
- 「サブディレクター」「アシスタントプロデューサー」のような派生ロールが追加できない
- 1人が2つのロールを持てない

**選択肢**:
- (A) `user_roles(user_id, role, scope_id)` の M:N に分離、`role_permissions` と統合
- (B) 現状維持＋合成 enum を増やす（破綻方向）

**未決ポイント**: 移行戦略。`users.role` を見ているコードが多そう（影響範囲調査必要）。

**緊急度**: 低（現状動いているし、新ロール要求が来てから着手で良い）。

---

## Q3. Feed/通知/お知らせの4系統をどう整理するか

**現状**:
| 概念 | テーブル | 状態 |
|---|---|---|
| 全体連絡 | `announcements` / `announcement_acks` | 旧版 |
| 通知 | `notification_logs` / `notification_settings` | Phase 1 現役 |
| 投稿(死蔵) | `posts` / `post_reactions` / `post_comments` | 未使用 |
| つぶやき | `tweets` / `tweet_likes` / `tweet_reactions` / `tweet_comments` | 現役 |

**問題**:
- `posts` は統一の試みが頓挫した跡
- `announcements` と `notification_logs` が並走

**選択肢**:
- (A) 統一: `feed_items(type, actor_id, target, payload_jsonb)` + `reactions` 統一
- (B) 死蔵テーブル削除のみ（`posts` 系を消す）、残り3系統は並走続行
- (C) 現状維持

**未決ポイント**: そもそも統合する価値があるか。philosophy.md 4 項に従えば「安易な統合は危険」。
**推奨**: (B) の死蔵テーブル削除だけ先にやる。完全統合は急がない。

---

## Q4. マスタ系統の3重実装を整理するか

**現状**:
- `master_categories` / `master_items`（汎用マスタ）
- `creative_categories` / `creative_status_templates`（Stage A 新マスタ）
- `appeal_types` / `client_appeal_axes` / `client_products`（ドメイン専用）

**問題**: 「マスタ」概念が3回作り直されている。

**選択肢**:
- (A) `master_categories` / `master_items` の役割を明確化（何のためのマスタか）
- (B) `appeal_types`（旧）を `client_appeal_axes`（新）に統一 — これは ADR 001 の付随作業

**緊急度**: 低。

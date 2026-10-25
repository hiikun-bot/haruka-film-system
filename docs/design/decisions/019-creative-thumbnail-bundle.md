---
adr: 019
status: Proposed
date: 2026-05-18
tags: [creatives, thumbnail, submission-bundle, dcheck, client-review, notifications]
related_tables: [creatives, creative_files, creative_versions, notification_logs]
supersedes: null
superseded_by: null
extends: 008
---

# 019. クリエイティブ提出物セット化（動画 ＋ サムネイル）

- **Status**: Proposed
- **Date**: 2026-05-18
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

ショート動画案件では、編集者が「動画ファイル」だけでなく「サムネイル（カバー静止画）」をセットで提出する運用が定着している。SNS（Instagram Reels / TikTok / YouTube Shorts 等）で再生前に表示される静止画は、再生率を大きく左右するため、動画と同等の制作物として扱われている。

ところが現状の HFS では、

- **動画ファイル**は creative_files に Drive アップロード経由で保存・履歴管理されている
- **サムネイル**は HFS 上に保存場所がなく、Chatwork で画像ファイルとして直接やり取りされている

その結果、以下の事故・摩擦が継続的に発生している。

### 直近の事故例（2026-05-16 〜 2026-05-17）

「アート占い師りヲぢ / 勝負神社」案件で、編集者が動画提出後にサムネイルを Chatwork へ画像投稿。Dチェック担当・秘書ともに「動画が見当たらない」「サムネが流れて行方不明」となり、編集者が再投稿。その後ユーザー（高橋）から「クリエイティブのサムネイルが見れていないし、追えてもいなかった。HFS へ落とし込む必要がある」とコメント。

### 問題の構造

1. **取りこぼし**: Chatwork タイムラインに画像投稿として流れるため、後続メッセージで埋もれて発見漏れが発生する
2. **動画とサムネの突合困難**: 「v3 の動画」と「最新サムネ」がどの組み合わせか、会話を遡らないと確定できない
3. **Dチェック画面で並べて確認できない**: レビュアーは動画は HFS、サムネは Chatwork という二箇所参照を強いられる
4. **クライアント送付の手動作業**: `routes/notifications.js` のクライアント送付メッセージ案は動画 Drive リンクのみ自動付与し、サムネは秘書が手動で別途添付する必要がある

### 既存類似機能との関係

- `learning_videos.thumbnail_url` — 教材動画用。本ADR対象外
- `video_file_organization_tests.thumbnail_url`（kv-thumb-fix ブランチ、素材広場 Phase 2）— 静止画案件・素材ライブラリ用の KV（キービジュアル）サムネ。本ADR対象外
- `creative_files`（`drive_file_id` / `faststart_drive_file_id`）— 動画本体。本ADRはここに**サムネ用カラムを追加**して同テーブルで完結させる

## Decision

動画とサムネイルを「**提出物セット**」として扱い、creative_files の1行に動画とサムネを同居させる。

### データモデル

```sql
-- creative_files に1カラム追加
ALTER TABLE creative_files
  ADD COLUMN thumbnail_drive_file_id TEXT;
COMMENT ON COLUMN creative_files.thumbnail_drive_file_id IS
  'クリエイティブのサムネイル（カバー静止画）の Drive file ID。動画ファイル行に紐付く。NULL 可。';
```

- **動画と独立した行は作らない**。サムネは creative_files の動画行に付帯する属性として扱う（1動画＝最大1サムネ）
- バージョン管理は今フェーズではスコープ外。creative_files の最新行（latest = true）の `thumbnail_drive_file_id` のみが「現行サムネ」
- 過去の動画バージョン行に紐付くサムネは「その時点のサムネ」として残置（参照用）

### UI（クリエイティブ詳細モーダル）

```
┌─ クリエイティブ詳細 ─────────────────────────────────────────┐
│ 260507_P001_FB_mv_ap001_1080_1920_0000003  v3              │
│                                                              │
│  ┌─ 動画 ──────────────┐  ┌─ サムネイル ────────────┐    │
│  │                       │  │  ┌──────────────────┐  │    │
│  │  [▶ 動画プレビュー]   │  │  │   [サムネ画像]    │  │    │
│  │                       │  │  │                   │  │    │
│  │  faststart.mp4 ✓     │  │  └──────────────────┘  │    │
│  │  [Drive で開く]       │  │  勝負神社_thumb.png    │    │
│  │                       │  │  [差し替え] [削除]    │    │
│  └───────────────────────┘  └────────────────────────┘    │
│                                                              │
│  ⚠️ サムネ未提出（クライアント送付時に必要）  ← 未提出時のみ │
│                                                              │
│  [動画を差し替え]  [サムネを追加 / 差し替え]                │
│                                                              │
│  ── コメント ─────────────────────────────────              │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

- 動画プレビュー枠の**右側**にサムネ枠を新設（モバイルでは縦並びにフォールバック）
- サムネ未提出時は警告バナーを出すが、**承認はブロックしない**（運用裁量を残す）
- サムネ単独提出（動画行が存在しない状態でのサムネアップ）は不可。動画行に追加する形のみ
- 表示対象: 後述「対象カテゴリ」を満たす creative のみ。それ以外は枠ごと非表示

### Dチェック・クライアントチェック画面

- 同じ「動画 ＋ サムネ並列レイアウト」を read-only で表示
- ラウンド比較モード（ADR 011, `#cd-round-right`）でも左右両カラムにサムネを表示し、サムネ差し替え履歴が読めるようにする

### クライアント送付メッセージ案（routes/notifications.js）

クライアントへ送るメッセージ案を、サムネ提出済みの場合は自動拡張する。

**現状**（動画のみ）:
```
〇〇様、いつもお世話になっております。
「{ファイル名}」のクライアント確認版を共有いたします。
{動画 Drive URL}
ご確認のほどよろしくお願いいたします。
```

**本ADR後**（サムネ提出済みの場合）:
```
〇〇様、いつもお世話になっております。
「{ファイル名}」のクライアント確認版を共有いたします。
▼ 動画
{動画 Drive URL}
▼ サムネイル
{サムネ Drive URL}
ご確認のほどよろしくお願いいたします。
```

サムネ未提出の場合は現状と同じ（動画のみ）出力。

### 対象カテゴリ

ADR 012（creative_category_fields）の枠組みに統合する。`creative_category_fields` テーブルに `thumbnail` フィールドの可視性を持たせ、デフォルトはショート動画系カテゴリのみ ON。

- カテゴリマスタの編集UIで「サムネイル枠を出す / 出さない」をトグル可能にする
- 既存カテゴリへの初期値投入は migration 内で実施（ショート動画 = ON、それ以外 = OFF）

## Out of Scope（本ADRで扱わない）

1. **サムネのバージョン履歴管理（v1/v2）**
   - 動画のバージョンに連動した差し替え履歴の正規化（仮想テーブル `creative_thumbnail_versions` 等）は次フェーズ
   - 現フェーズは「最新サムネのみ保持。過去動画行に紐付いたサムネは参照用に残置」
2. **動画なしのサムネ単独 creative**
   - 「サムネだけ作る」案件は本ADR対象外。必要になれば別 ADR で creative_categories の構造ごと検討
3. **KV サムネ（素材広場 Phase 2 / kv-thumb-fix）との統合**
   - KV は静止画案件・素材ライブラリ用途で別目的。本ADRと独立して維持
4. **Chatwork / Slack へのサムネ画像直接投稿**
   - メッセージ案は Drive リンク添付に統一。画像バイナリの直接転送はしない

## Migration Plan

並行マージ事故防止のため、Stage 分割＋逐次マージで進める（feedback_db_migration_staging.md ルールに従う）。

| Stage | 内容 | PR | 前提 |
|---|---|---|---|
| A | `creative_files.thumbnail_drive_file_id` カラム追加 migration | DB only PR | - |
| B | クリエイティブ詳細モーダルにサムネアップロード UI 追加（ショート動画カテゴリのみ） | UI PR | Stage A 適用済み |
| C | Dチェック・クライアントチェック画面でサムネ並列表示 | UI PR | Stage B マージ済み |
| D | `routes/notifications.js` クライアント送付メッセージ案にサムネリンク自動付与 | backend PR | Stage B マージ済み |
| E | `creative_category_fields` に thumbnail フィールド可視性を統合（カテゴリマスタUI からトグル化） | DB + UI PR | Stage C/D マージ済み |

Stage A は `needs-db-migration` ラベル付与＆本番適用後に `db-migration-applied` ラベル → 以降の Stage を順次マージ。

## Consequences

### Positive

- サムネ取りこぼし事故が物理的に発生しなくなる（HFS 上に保存場所ができる）
- Dチェック・クライアントチェックの片手間でサムネも確認できる
- クライアント送付メッセージの手動編集が不要になり、秘書工数削減
- 編集者・秘書・ハル・クライアントの全員が「動画＋サムネ」を1画面で確認できる
- 将来的なサムネ用 AI 解析（顔判定、文字読み取り、CTR 予測等）の基盤ができる

### Negative / Risk

- **既存案件のサムネは遡及紐付き不可**: マージ前に提出されたサムネは Chatwork に残存。手動アップロード or 諦め（運用判断）
- **サムネ未提出のままクライアント送付に進める運用ルールが必要**: 警告のみ / ブロック / カテゴリ別設定 — 今回は「警告のみ」採用。事故が再発したら ADR 改訂で締める
- **動画と独立したサムネ差し替え履歴は追えない**（バージョン管理 Out of Scope のため）

## Alternatives Considered

### A. 動画と独立した creative_thumbnails テーブル新設

- メリット: バージョン履歴・複数サムネ提案・サムネ単独運用が将来拡張しやすい
- デメリット: テーブル数増・JOIN 増・現フェーズの要件にオーバースペック
- **却下理由**: 1動画＝1サムネで運用が回っている現状に対して構造が重い。必要になったら本ADR後継で正規化する

### B. KV（キービジュアル）テーブルに相乗り

- メリット: 既存スキーマ流用
- デメリット: KV は静止画案件・素材広場用で目的が違う。意味論が混ざる
- **却下理由**: 用途が分かれている既存テーブルへの相乗りは負債化リスクが高い

### C. Drive フォルダ運用 + URL 列のみ追加

- メリット: 最小実装
- デメリット: アップロード動線が既存と分かれる、Drive 公開設定の自動化が個別実装になる
- **却下理由**: 既存 `creative_files.drive_file_id` の Drive 共有設定ロジック（`lib/drive-share.js`）を再利用する方が運用が揃う

## Related

- [ADR 008](008-creative-file-comments-threading.md) — creative_files テーブル定義の本体（本ADRはここに1カラム追加）
- [ADR 012](012-creative-category-field-visibility.md) — カテゴリ別フィールド可視性（Stage E で統合）
- [ADR 011](011-creative-round-comparison-ui.md) — ラウンド比較UI（サムネも並列表示対象に追加）
- [glossary.md](../glossary.md) — 「サムネイル」用語定義の追記が必要（実装 PR で対応）
- 関連 feedback memory: `feedback_db_migration_staging.md`（Stage 分割・逐次マージ厳守）

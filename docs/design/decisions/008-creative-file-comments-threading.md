# ADR 008 — creative_file_comments の返信スレッド構造

- Status: Accepted
- Date: 2026-05-08
- Owner: feature/creatives
- Related: ADR 001 (creative-first設計)

## Context

Frame.io 風レビュー画面（fp- UI）で、ディレクター指摘コメントに対して
編集者が「直下に返信」できるようにしたい。
現状の `creative_file_comments` は flat 構造（親子関係なし）。

旧 TEXT 列（`creatives.director_comment` / `editor_comment` / `client_comment`）は
互換のため残すが、新規ロジックは `creative_file_comments` にスレッド構造を持たせる方向で進める。

## Decision

`creative_file_comments` に `parent_comment_id UUID REFERENCES creative_file_comments(id) ON DELETE CASCADE` を追加。

- `parent_comment_id IS NULL` → ルートコメント
  - タイムライン上のドット表示対象
  - bbox overlay 描画対象
  - 「↩ 返信」ボタンを出す
- `parent_comment_id IS NOT NULL` → 返信
  - タイムコード / bbox は親に継承（独自に持たない、UIでも表示しない）
  - ドット非表示・bbox overlay 非表示
  - 返信への返信は当面サポートしない（深さ1の単純スレッド）

API:
- `POST /creative-files/:fid/comments` で `parent_comment_id` を受け取る
- 親コメントが同じ `creative_file_id` に属するかを検証（クロスファイル参照拒否、400）
- `GET` は flat レスポンス継続。フロントでツリー化（描画コストよりも将来の柔軟性を優先）

通知:
- ルート投稿 → `creative_assignments` の担当者全員へ `post_comment` 通知
- 返信投稿 → 親コメント投稿者へ `post_comment` 通知
- 自分自身への通知は除外
- `link_url` は `/haruka.html?creative=<creative_id>`

## Consequences

良い点:
- 既存テーブルに列追加だけで完結。データ移行不要
- flat レスポンスを維持するので既存の knowledge 一覧などは影響なし
- ON DELETE CASCADE で親削除時に返信も自動削除（孤児防止）
- 返信は親のタイムコード/bbox に紐づくので、ドット数が増えず UI が散らからない

悪い点・トレードオフ:
- 深さ1固定（返信への返信は不可）。将来必要になったら再帰描画に拡張
- フロントで毎回ツリー化する（コメント件数が数百件超えるとパフォーマンス懸念）→ そうなったら親IDでクエリ分割を検討

## Alternatives

1. **別テーブル `creative_file_comment_replies` を作る**
   - 却下: スキーマが二重化して通知ロジックも分岐。同じドメイン概念を分けるメリットが薄い
2. **既存 `comment` 列に親IDを埋め込んだ JSON を使う**
   - 却下: 検索・通知で SQL クエリが書きづらい
3. **`creatives.director_comment` を構造化して JSON 配列化**
   - 却下: ファイル単位ではなくクリエイティブ単位の文字列を活用する設計。タイムコード紐付けと相性が悪い

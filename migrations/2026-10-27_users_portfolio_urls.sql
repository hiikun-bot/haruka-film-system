-- メンバーのポートフォリオ（実績）URL
-- メンバー編集モーダル「基本情報」で 1 行 1 件のテキストとして入力し、
-- [{ "url": "https://…", "title": "見出し" | null }, …] の配列で保存する（最大 20 件）。
-- 検証・表示ロジックは utils/member-portfolio-urls.js（フロントと共用）。
-- users は既存テーブル（RLS は ADR 048 で有効化済み）なので列追加のみ。
ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

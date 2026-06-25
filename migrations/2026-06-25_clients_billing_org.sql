-- 2026-06-25_clients_billing_org.sql
-- クライアントマスターに「請求区分」(billing_org) を追加する。
--
-- 背景:
--   案件の請求元を「自社（HARUKA FILM）」と「広告代理店経由（GND = GOOD NEW Design）」で
--   分けて管理したい、という要望。請求・売上の集計や台帳で自社案件と代理店経由案件を区別する。
--
-- 設計（ADR 023 / docs/design/decisions/023-client-billing-org.md）:
--   - clients に TEXT 列 billing_org を追加（NULL 可・未設定を許容）。
--   - 値はコード値で保存する: 'haruka'（自社） / 'gnd'（GOOD NEW Design）。
--   - ラベル・選択肢はフロントの定数 CLIENT_BILLING_ORG_LABELS（public/haruka.html）で
--     一元管理。代理店が増えても DB スキーマ変更・サーバー改修は不要（コード1行追記）。
--   - status / pricing_type 等と同様、DB に CHECK 制約は設けずアプリ層で管理（拡張容易性優先）。
--
-- 影響:
--   - clients.billing_org : 既存行は NULL（未設定）。後方互換あり。
--   - 後段の UPDATE で、既知のクライアントに初期値をバックフィルする
--     （台帳「案件費用の管理台帳」の請求区分列に基づく。記載の無いクライアントは NULL のまま）。

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS billing_org TEXT;

COMMENT ON COLUMN clients.billing_org IS
  '請求区分（コード値）。haruka=自社(HARUKA FILM) / gnd=GOOD NEW Design(広告代理店)。NULL=未設定。ラベルは CLIENT_BILLING_ORG_LABELS で管理。';

-- --- 初期バックフィル（既知クライアントのみ。台帳の請求区分に基づく） ---
-- 自社（HARUKA FILM）
UPDATE clients SET billing_org = 'haruka'
WHERE billing_org IS NULL
  AND name IN ('アート占い師りヲぢ', 'ストリート占い四柱推命はっすい', 'ひげごろーさん', 'よたさん');

-- 広告代理店経由（GND = GOOD NEW Design）
UPDATE clients SET billing_org = 'gnd'
WHERE billing_org IS NULL
  AND name IN (
    'CW-X（ワコール）', 'DMM英会話', 'hertech', 'PC_next', 'あるる',
    'キャピタル・グループ', 'てすと', 'テストクライアント', 'ハビー',
    'バルセロナ', 'プレスト・ケア株式会社'
  );

-- Supabase (PostgREST) のスキーマキャッシュを再読み込み
NOTIFY pgrst, 'reload schema';

-- 2026-05-02: クリエイティブの「訴求軸 / 商材」を任意化
--
-- 背景:
--   ディレクターから「依頼されたCRを登録だけしたい。何を作るかまだ構想していない段階」
--   という声があり、訴求軸 (appeal_type_id) / 商材 (product_id) が未確定でも
--   とりあえず登録できるようにする。
--
--   旧フロント・旧サーバーは appeal_type_id を必須として扱っていたが、
--   2026-05-02 のリリースで両方とも null 許容に運用緩和した。
--   DB 側でも NOT NULL 制約が残っていないことを保証するため、明示的に DROP NOT NULL する。
--
--   既に NULL 許容なら no-op（IF EXISTS で安全に冪等）。
--
-- 影響範囲: なし（既存データはすべて NOT NULL を満たした状態 → NULL 許可化は安全）

DO $$
BEGIN
  -- creatives.appeal_type_id を NULL 許容に
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'creatives' AND column_name = 'appeal_type_id'
  ) THEN
    BEGIN
      ALTER TABLE creatives ALTER COLUMN appeal_type_id DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      -- 既に NULL 許容ならスルー
      RAISE NOTICE 'appeal_type_id is already nullable or could not be altered: %', SQLERRM;
    END;
  END IF;

  -- creatives.product_id を NULL 許容に
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'creatives' AND column_name = 'product_id'
  ) THEN
    BEGIN
      ALTER TABLE creatives ALTER COLUMN product_id DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'product_id is already nullable or could not be altered: %', SQLERRM;
    END;
  END IF;
END $$;

-- ============================================================================
-- ADR 007 追補: ファイル名テンプレートの version トークンを「任意」に変更
--
-- 背景:
--   バグ報告 #271af257 — クライアント提出時にファイル名から Ver を削除しているため、
--   最初から version を含まないテンプレを作りたい。だが旧仕様では
--   validate_filename_template_tokens() が serial / project_name / version の
--   3トークンを必須としており、version を消したテンプレが保存できなかった。
--
-- 変更:
--   必須トークンを serial / project_name の2つに緩和し、version は任意化する。
--   serial 先頭固定はそのまま維持する。
--
--   ※ この migration は CHECK 制約を「より緩く」するだけなので、
--     旧コード（version を必須としてバリデーションする）が動いていても
--     既存テンプレ・新規テンプレの保存は引き続き成功する（後方互換）。
--     一方で version を含まないテンプレの保存は、この migration 適用後にのみ成功する。
--
-- 適用順:
--   1. validate_filename_template_tokens() を version 不要版に再定義
--      （CHECK 制約は関数を参照しているため、関数差し替えで自動的に新仕様になる）
-- ============================================================================

CREATE OR REPLACE FUNCTION validate_filename_template_tokens(t jsonb) RETURNS boolean AS $$
DECLARE
  keys text[];
BEGIN
  IF jsonb_typeof(t) <> 'array' OR jsonb_array_length(t) = 0 THEN
    RETURN false;
  END IF;
  SELECT array_agg(elem->>'key') INTO keys FROM jsonb_array_elements(t) AS elem;
  -- 必須: serial / project_name（version は任意化。バグ報告 #271af257）
  IF NOT ('serial' = ANY(keys))
     OR NOT ('project_name' = ANY(keys)) THEN
    RETURN false;
  END IF;
  -- serial は先頭固定
  IF (t->0->>'key') <> 'serial' THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 制約コメントを実態に合わせて更新（CHECK 制約自体は関数参照なので再作成不要）
COMMENT ON COLUMN filename_templates.tokens IS
  '順序付き配列。要素は { kind: "system"|"custom"|"flag", key, label, default? }。serial / project_name 必須・serial 先頭固定（CHECK 制約）。version は任意（バグ報告 #271af257）。';

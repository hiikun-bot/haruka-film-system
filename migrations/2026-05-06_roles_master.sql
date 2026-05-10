-- =====================================================
-- Roles Master (Stage 0 / Step 1: ロールをマスタテーブル化)
-- =====================================================
-- ADR 003: docs/design/decisions/003-roles-as-master-data.md
-- ADR 002: docs/design/decisions/002-estimate-lines-unify-deliverable-rates.md
--
-- 目的:
--   現状 `users.role` は単一 enum で、合成値 'producer_director' を含む等、
--   ロールが第一級概念になっていない。
--   `role_permissions.role TEXT` も同様の問題を抱える。
--   ADR 002 の `project_estimate_line_costs.role_id` を成立させる足場として、
--   ロールマスタ `roles` と関連 `user_roles` を導入する。
--
-- このPRのスコープ（Step 1: migration のみ）:
--   1) `roles` テーブル新設 + 初期 8 件投入
--   2) `user_roles` テーブル新設 + 既存 `users.role` からデータ移行
--   3) `role_permissions.role_id` 列追加 + バックフィル + INDEX
--
-- このPRでやらないこと（Step 2 以降）:
--   - `users.role` 列の DROP（コードがまだ読んでいる）
--   - `role_permissions.role` TEXT 列の DROP
--   - アプリコードの参照書き換え（dual-read 期間を経て段階移行）
--
-- 冪等性:
--   `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` を徹底。
--   再実行してもエラーにならない構造とする。
--
-- 原子性:
--   BEGIN ... COMMIT で全体をトランザクションでラップ。
--
-- 参考実装: migrations/2026-05-05_creative_categories.sql （Stage A 形式）
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) roles : ロールマスタ
-- -----------------------------------------------------
-- ADR 003 のスキーマ案そのまま。
--   code: 英小文字スネークケース。'producer_director' のような合成値は持たない。
--   category: 'admin' | 'staff' | 'creator' で大分類
--   is_creator: line_costs に登場しうる「制作者」ロールか
--   is_internal: 社内ロールか（true）／外注（false）かの区別
--   archived_at: ロール廃止時に日付セット（NULL なら現役）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  category    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_creator  BOOLEAN NOT NULL DEFAULT FALSE,
  is_internal BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_roles_active_sort
  ON roles(archived_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_roles_category
  ON roles(category);
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 2) roles 初期データ（8 件）
-- -----------------------------------------------------
-- 旧 users.role の単純値（合成 producer_director を除く 6 種）に加え、
-- ADR 002 の line_costs.role に登場予定の sub_director / sub_producer を先行追加。
--
-- sort_order はメンバー一覧などでの並び順を意識した値。
--   admin → secretary → producer → director → sub_producer → sub_director → editor → designer
-- is_creator は「line_costs に支払い対象として登場しうるか」を判定基準にする。
-- -----------------------------------------------------
INSERT INTO roles (code, label, category, sort_order, is_creator, is_internal) VALUES
  ('admin',        '管理者',           'admin',   10,  FALSE, TRUE),
  ('secretary',    '秘書',             'staff',   20,  FALSE, TRUE),
  ('producer',     'プロデューサー',   'staff',   30,  TRUE,  TRUE),
  ('director',     'ディレクター',     'staff',   40,  TRUE,  TRUE),
  ('sub_producer', 'サブプロデューサー','staff',  50,  TRUE,  TRUE),
  ('sub_director', 'サブディレクター', 'staff',   60,  TRUE,  TRUE),
  ('editor',       '編集者',           'creator', 70,  TRUE,  TRUE),
  ('designer',     'デザイナー',       'creator', 80,  TRUE,  TRUE)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------
-- 3) user_roles : ユーザー × ロール（M:N、合成 enum 廃止のための器）
-- -----------------------------------------------------
-- scope_type / scope_id は ADR 003 で「将来 workspace / project スコープを
-- 持たせる余地」として定義。Step 1 では全行 scope_type='global', scope_id=NULL。
--
-- UNIQUE(user_id, role_id, scope_type, scope_id) でバックフィル時の重複を防ぐ。
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id),
  scope_type  TEXT,
  scope_id    UUID,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user
  ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role
  ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_scope
  ON user_roles(scope_type, scope_id);
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 4) user_roles バックフィル（既存 users.role からの移行）
-- -----------------------------------------------------
-- 単純値（admin / secretary / producer / director / editor / designer）は 1 行追加。
-- 合成値 'producer_director' は producer + director の 2 行を追加。
-- 未知値は無視（ON CONFLICT DO NOTHING で安全側に倒す）。
--
-- 全件 scope_type='global' / scope_id=NULL。
-- 重複（既に user_roles 行が存在する）場合は何もしない。
-- -----------------------------------------------------

-- 4-1) 単純値マッピング: users.role と roles.code が 1:1 で一致するケース
INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
SELECT u.id, r.id, 'global', NULL
FROM users u
JOIN roles r ON r.code = u.role
WHERE u.role IN ('admin','secretary','producer','director','editor','designer')
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;

-- 4-2) 合成値 'producer_director' → producer 行
INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
SELECT u.id, r.id, 'global', NULL
FROM users u
JOIN roles r ON r.code = 'producer'
WHERE u.role = 'producer_director'
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;

-- 4-3) 合成値 'producer_director' → director 行
INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
SELECT u.id, r.id, 'global', NULL
FROM users u
JOIN roles r ON r.code = 'director'
WHERE u.role = 'producer_director'
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING;

-- -----------------------------------------------------
-- 5) role_permissions に role_id 列を追加 + バックフィル
-- -----------------------------------------------------
-- 既存 role_permissions.role TEXT は Step 4 までは残す（dual-read 期間）。
-- role_id は新規参照側（Step 3 でコードを切り替える）。
--
-- 'producer_director' の権限行は、現状 producer_director ロールの権限として
-- 別 enum 値で持たれている（admin との等価ではない）。Step 1 では
-- role_id をバックフィルできない（roles マスタに producer_director が存在しないため）
-- ので、合成値の行は role_id NULL のまま残す。
-- Step 3 での参照切替時に「producer_director の permission は producer + director の
-- 和集合と解釈する」ようコード側で吸収する（ADR 003 の dual-read 期間運用）。
-- -----------------------------------------------------
ALTER TABLE role_permissions
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id
  ON role_permissions(role_id);

-- 5-1) 単純値の role_id バックフィル
UPDATE role_permissions rp
SET role_id = r.id
FROM roles r
WHERE rp.role_id IS NULL
  AND rp.role = r.code
  AND rp.role IN ('admin','secretary','producer','director','editor','designer');

-- 5-2) PostgREST にスキーマリロード通知
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =====================================================
-- 検証クエリ（適用後に手動で実行して整合性確認）
-- =====================================================
-- -- 8 ロール投入されたか
-- SELECT code, label, category, sort_order, is_creator FROM roles ORDER BY sort_order;
--
-- -- user_roles の件数（旧 users.role と整合するか）
-- --   producer_director ユーザーは 2 行になっているはず
-- SELECT u.email, u.role AS legacy_role,
--        array_agg(r.code ORDER BY r.sort_order) AS new_roles
-- FROM users u
-- LEFT JOIN user_roles ur ON ur.user_id = u.id
-- LEFT JOIN roles r       ON r.id = ur.role_id
-- GROUP BY u.email, u.role
-- ORDER BY u.role;
--
-- -- role_permissions.role_id バックフィル状況
-- --   合成値 'producer_director' の行は role_id NULL のまま残る（仕様）
-- SELECT role, COUNT(*) FILTER (WHERE role_id IS NULL) AS unmapped,
--               COUNT(*) FILTER (WHERE role_id IS NOT NULL) AS mapped
-- FROM role_permissions
-- GROUP BY role
-- ORDER BY role;

-- =====================================================
-- ロールバック手順（手動）
-- =====================================================
-- BEGIN;
--   ALTER TABLE role_permissions DROP COLUMN IF EXISTS role_id;
--   DROP TABLE IF EXISTS user_roles;
--   DROP TABLE IF EXISTS roles;
-- COMMIT;

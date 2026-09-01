-- 2026-09-01_portfolio_genre.sql
-- 作品ギャラリー（ポートフォリオ）の「系統」フィルタ
-- 設計: docs/design/decisions/035-portfolio-genre.md
--
-- 目的:
--   「ちょっとポートフォリオ見せてよ」と言われた場に、その場で
--   「◯◯系ならこれです」と出せるようにする。作品を業種軸で 1 タップ絞り込みたい。
--
-- 系統は 2 軸ある:
--   1) 業種軸（genre）… クライアントの業種。区分マスターで管理し、
--      clients.portfolio_genre_code が持ち主。作品側は例外時の上書きだけ持つ。
--   2) 表現軸（style）… 縦型ショート動画 / バナー等。creative_type と向きから
--      毎回導出するので DB には持たない（utils/portfolio-genre.js）。
--      creatives.portfolio_style_code は「自動判定できない作風（実写・インタビュー等）」を
--      人が付けたときだけ入る上書き列。
--
-- 冪等性: IF NOT EXISTS / ON CONFLICT DO NOTHING を徹底。二重実行しても壊れない。
-- 既存データへの影響: 追加列のみ（既定 NULL）。既存の作品表示は何も変わらない。

BEGIN;

-- -----------------------------------------------------
-- 1) 区分マスターに「系統（業種）」を追加
--    既存の 商材 / 媒体 / FMT / 訴求軸 / サイズ と同じ仕組みに乗せるので、
--    設定画面の「区分マスター」から後で名称追加・並べ替えができる。
-- -----------------------------------------------------
INSERT INTO master_categories (name, code, sort_order) VALUES
  ('系統（業種）', 'portfolio_genres', 6)
ON CONFLICT (code) DO NOTHING;

-- ワークスペース#1 に紐付ける（既存カテゴリと同じ扱い）
UPDATE master_categories
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_number = 1)
WHERE code = 'portfolio_genres' AND workspace_id IS NULL;

-- -----------------------------------------------------
-- 2) 業種の初期値
--    本番の既存クライアント 31 社を実際に見て決めた区分。
--    足りなければ設定画面から追加できる（コードは英小文字＋アンダースコア）。
-- -----------------------------------------------------
INSERT INTO master_items (category_id, code, name, sort_order)
SELECT c.id, v.code, v.name, v.sort_order
FROM master_categories c
CROSS JOIN (VALUES
  ('finance',      '金融・保険',            1),
  ('education',    '教育・スクール',        2),
  ('beauty_health','美容・健康',            3),
  ('medical_care', '医療・介護・福祉',      4),
  ('ec_d2c',       'EC・通販・D2C',         5),
  ('food',         '食品・飲食',            6),
  ('apparel',      'アパレル・ファッション', 7),
  ('travel',       '旅行・レジャー',        8),
  ('entertainment','エンタメ・メディア',    9),
  ('fortune',      '占い・スピリチュアル',  10),
  ('life_service', '生活サービス',          11),
  ('realestate',   '不動産・住宅',          12),
  ('it_saas',      'IT・SaaS',              13),
  ('btob',         'BtoB・コンサル',        14),
  ('recruit',      '採用・求人',            15),
  ('other',        'その他',                99)
) AS v(code, name, sort_order)
WHERE c.code = 'portfolio_genres'
ON CONFLICT (category_id, code) DO NOTHING;

-- -----------------------------------------------------
-- 3) 系統を持たせる列
--    clients … 業種の持ち主（この 1 列で作品 749 件ぶんが決まる）
--    creatives … 例外の上書き。NULL = クライアントを継承（＝ふつうは NULL のまま）
-- -----------------------------------------------------
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS portfolio_genre_code text;

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS portfolio_genre_code text,
  ADD COLUMN IF NOT EXISTS portfolio_style_code text;

COMMENT ON COLUMN clients.portfolio_genre_code   IS '作品集の業種系統。master_items(category=portfolio_genres).code';
COMMENT ON COLUMN creatives.portfolio_genre_code IS '作品集の業種系統の上書き。NULL=クライアントを継承';
COMMENT ON COLUMN creatives.portfolio_style_code IS '作品集の表現系統の上書き。NULL=creative_type と向きから自動導出';

-- 上書きは全体のごく一部なので部分インデックスで足りる
CREATE INDEX IF NOT EXISTS idx_creatives_portfolio_genre
  ON creatives (portfolio_genre_code)
  WHERE portfolio_genre_code IS NOT NULL;

-- -----------------------------------------------------
-- 4) 既存クライアントへの初期割り当て
--    案件名・商材・訴求軸・サイト URL を実際に読んで決めた。
--    判断がつかなかった 3 社（prima tokyo / ミラリタ / テスト用）は未設定のまま
--    残す（画面の「未設定」チップに集まるので、あとから選べば済む）。
--    name 一致で当てているので、同名の重複クライアント（サンスター・HerTech）も
--    まとめて同じ系統になる。既に手で設定済みなら上書きしない。
-- -----------------------------------------------------
UPDATE clients SET portfolio_genre_code = v.code
FROM (VALUES
  ('JTG証券',                      'finance'),
  ('キャピタル・グループ',          'finance'),
  ('ライフネット生命',              'finance'),
  ('DMM英会話',                    'education'),
  ('hertech',                      'education'),
  ('HerTech',                      'education'),
  ('東大松尾研究所',                'education'),
  ('ひげごろーさん',                'education'),
  ('ハビー',                       'education'),
  ('サンスター',                    'beauty_health'),
  ('プレスト・ケア株式会社',        'medical_care'),
  ('ウェルビー',                    'medical_care'),
  ('PC_next',                      'ec_d2c'),
  ('ポンデテック',                  'ec_d2c'),
  ('日清ダイレクトマーケティング',   'ec_d2c'),
  ('CW-X（ワコール）',              'apparel'),
  ('Airbnb',                       'travel'),
  ('JAL',                          'travel'),
  ('チムニータウン',                'entertainment'),
  ('クローズワーストアンリミテッド', 'entertainment'),
  ('よたさん',                      'entertainment'),
  ('アート占い師りヲぢ',            'fortune'),
  ('ストリート占い四柱推命はっすい', 'fortune'),
  ('あるる',                       'life_service'),
  ('シェイクアドバイザーズ',        'btob'),
  ('バルセロナ',                    'recruit')
) AS v(name, code)
WHERE clients.name = v.name
  AND clients.portfolio_genre_code IS NULL;

COMMIT;

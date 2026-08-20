-- 2026-08-20 オンボーディング管理（新メンバー受け入れチェックリスト）
--
-- 背景:
--   秘書チーム解体に伴い、Googleスプレッドシート「オンボーディング引き継ぎシート」で
--   秘書が回していた新メンバー受け入れ業務を HFS に取り込む。運用者は今後 admin（ひーくん）。
--   新メンバーごとにレコードを作り、職種別テンプレ（コード内定義: utils/onboarding.js）を
--   onboarding_tasks に展開してチェックリストで進捗管理する。
--
-- 本番Supabaseへの適用が必要。

-- オンボーディング対象者（新メンバー1人 = 1レコード）
CREATE TABLE IF NOT EXISTS onboarding_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_name TEXT NOT NULL,                    -- 表示名（システム未登録でも運用できるよう名前は必須）
  user_id     UUID REFERENCES users(id),        -- システム登録済みならリンク（任意）
  occupation  TEXT NOT NULL CHECK (occupation IN ('video_creator','designer')),
  status      TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  note        TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- チェックリスト明細（レコード作成時に職種別テンプレを展開）
CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id  UUID NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
  task_key   TEXT NOT NULL,                     -- テンプレ側の安定キー（例: 'chatwork_contact'）
  label      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('mt_before','mt','mt_after','final')),
  sort_order INT NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT false,
  done_at    TIMESTAMPTZ,
  done_by    UUID REFERENCES users(id),
  UNIQUE(record_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_record_id ON onboarding_tasks(record_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_records_status ON onboarding_records(status);

-- 権限キー 'onboarding.page'（オンボーディング管理ページの閲覧・操作）
--
-- 既定の許可ロール: admin / secretary
--   ・削除（DELETE /onboarding/:id）はコード側で admin のみに制限。
--   ・producer_director 行は意図的に seed しない（master.filename_templates と同じ理由。
--     #1052 以降、合成 TEXT 行は兼任者のみに適用されるが、dual-read 互換分岐の副作用を
--     避けるため、必要になれば producer / director 行の継承（権限管理画面から ON）でカバーする）。
--   ・個人単位の権限付与機構は存在しないため、判定はロール集合（roleCodesHavePermission）のみ。
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',     'onboarding.page', true),
  ('secretary', 'onboarding.page', true)
ON CONFLICT (role, permission_key) DO NOTHING;

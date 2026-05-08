-- ============================================================
-- Verup情報（システム改訂履歴）
-- ============================================================
-- 管理者が画面から追加・編集できるシステム改訂履歴。
-- 一般ユーザーは一覧閲覧 + 既読管理。is_hidden は admin のみが切替可。
-- ============================================================

create table if not exists version_logs (
  id uuid primary key default gen_random_uuid(),
  revision_no integer not null,
  version_label text,
  released_at timestamptz not null default now(),
  screen text not null,
  feature text not null,
  description text not null,        -- 修正内容の要約（必須）
  before_text text,                  -- 変更前の挙動・状態（任意）
  after_text text,                   -- 変更後の挙動・状態（任意）
  use_case text,
  category text not null default 'improvement', -- feature / improvement / bugfix / spec_change
  importance text not null default 'normal',    -- high / normal / low
  target_roles text[] not null default array['all']::text[],
  tags text[] not null default array[]::text[],
  related_url text,
  is_hidden boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists version_logs_revision_no_uniq on version_logs (revision_no);
create index if not exists version_logs_released_at_idx on version_logs (released_at desc);
create index if not exists version_logs_is_hidden_idx on version_logs (is_hidden);

-- 既読管理（per-user）
create table if not exists version_log_reads (
  user_id uuid not null references users(id) on delete cascade,
  version_log_id uuid not null references version_logs(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, version_log_id)
);

create index if not exists version_log_reads_user_idx on version_log_reads (user_id);
create index if not exists version_log_reads_log_idx on version_log_reads (version_log_id);

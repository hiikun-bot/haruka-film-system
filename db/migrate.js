// db/migrate.js — アプリ起動時に supabase_schema.sql を Postgres に直接実行する
//
// 役割:
//   - Railwayデプロイ時の手動コピペ作業を撤廃するための自動スキーマ同期モジュール
//   - 起動時に supabase_schema.sql を読み込み Postgres に対して実行する
//   - 既存のスキーマファイルは IF NOT EXISTS / ALTER ... IF NOT EXISTS で書かれているため
//     何度実行しても安全（idempotent）
//
// 必要な環境変数:
//   - DATABASE_URL (または SUPABASE_DB_URL): Supabase の Postgres 接続文字列
//     例: postgres://postgres:[PASSWORD]@db.xxxxx.supabase.co:5432/postgres
//     Supabase ダッシュボード → Project Settings → Database → Connection string
//
// 無効化:
//   - 環境変数 SCHEMA_AUTO_SYNC=false で自動同期をスキップ（呼び出し側で制御）
//
// 失敗時:
//   - 文単位で実行し、失敗した文だけログに残して残りの文を継続実行する
//   - 致命的エラーをログに記録し、{ ok: false, error } を返す
//   - 呼び出し側はアプリ起動を継続する（緊急時の障害耐性）
//
// 重要:
//   - pg の simple query protocol でファイル全体を一度に流すと、途中の文が失敗すると
//     残りが実行されない（または部分的にしか走らない）可能性があるため、文単位で実行する
//   - 最後に PostgREST のスキーマキャッシュを NOTIFY pgrst, 'reload schema' でリロードし、
//     DDL 変更（カラム追加など）を Supabase REST API に即時反映する

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// SQLを文単位で分割（コメント行 / 文字列内のセミコロン / DOブロックを考慮）
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollarQuote = false;
  let dollarTag = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行コメント
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    // ブロックコメント
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += next; i++; inBlockComment = false; }
      continue;
    }
    // ドル引用文字列（$$ ... $$ や $tag$ ... $tag$）
    if (inDollarQuote) {
      current += ch;
      if (ch === '$') {
        const closing = '$' + dollarTag + '$';
        if (sql.substr(i, closing.length) === closing) {
          current += sql.substr(i + 1, closing.length - 1);
          i += closing.length - 1;
          inDollarQuote = false;
          dollarTag = '';
        }
      }
      continue;
    }
    // シングルクォート
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next !== "'") inSingleQuote = false;
      else if (ch === "'" && next === "'") { current += next; i++; }
      continue;
    }
    // ダブルクォート
    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    // コメント開始
    if (ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; current += ch; continue; }
    // クォート開始
    if (ch === "'") { inSingleQuote = true; current += ch; continue; }
    if (ch === '"') { inDoubleQuote = true; current += ch; continue; }
    // ドル引用開始
    if (ch === '$') {
      const m = sql.substr(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (m) {
        inDollarQuote = true;
        dollarTag = m[1];
        current += m[0];
        i += m[0].length - 1;
        continue;
      }
    }

    // ステートメント区切り
    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      continue;
    }

    current += ch;
  }

  const last = current.trim();
  if (last) statements.push(last);
  return statements;
}

async function runSchemaSync() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    // 目立つように console.error で出す。Railway 等で本番DBに新カラム/FKが反映されない原因No.1。
    console.error('🚨 [schema-sync] DATABASE_URL/SUPABASE_DB_URL 未設定 — スキーマ同期をスキップします。Railway の環境変数を確認してください');
    console.error('🚨 [schema-sync] 設定方法: Supabase ダッシュボード → Project Settings → Database → Connection string (URI) を Railway の環境変数 DATABASE_URL にコピー');
    return { skipped: true };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });

  let okCount = 0;
  let errCount = 0;
  const errors = [];

  try {
    await client.connect();
    const schemaPath = path.join(__dirname, '..', 'supabase_schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const statements = splitSqlStatements(sql);

    const startTime = Date.now();
    console.log(`[schema-sync] ${statements.length} 文を順次適用します`);

    for (let idx = 0; idx < statements.length; idx++) {
      const stmt = statements[idx];
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
      try {
        await client.query(stmt);
        okCount++;
      } catch (err) {
        errCount++;
        errors.push({ idx, preview, error: err.message });
        console.warn(`[schema-sync] 文 #${idx + 1} 失敗: ${err.message}`);
        console.warn(`[schema-sync]   SQL: ${preview}${stmt.length > 80 ? '...' : ''}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[schema-sync] 完了 OK=${okCount} NG=${errCount} (${elapsed}ms)`);

    // 監査列が確実に存在することを保証（個別ファイル実行が落ちた場合の保険）
    const criticalAlters = [
      "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS original_unit_price INTEGER",
      "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS price_change_reason TEXT",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS team_id UUID",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS memo TEXT",
      "ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check",
      "ALTER TABLE clients ADD COLUMN IF NOT EXISTS persona TEXT",
      "ALTER TABLE clients ADD COLUMN IF NOT EXISTS slack_channel_url TEXT",
      "ALTER TABLE clients ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT",
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_channel_url TEXT",
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered BOOLEAN DEFAULT false",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_reason TEXT",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_at TIMESTAMPTZ",
      "ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_by UUID",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS mime_type TEXT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS file_size BIGINT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_drive_file_id TEXT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_drive_url TEXT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_file_size BIGINT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_status TEXT",
      "ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_processed_at TIMESTAMPTZ",
      // 管理者によるステータス強制変更の監査ログ
      `CREATE TABLE IF NOT EXISTS creative_status_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        creative_id UUID NOT NULL,
        from_status TEXT,
        to_status TEXT,
        reason TEXT NOT NULL,
        changed_by UUID,
        changed_at TIMESTAMPTZ DEFAULT now(),
        deleted_invoice_item_ids JSONB
      )`,
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_birth_year BOOLEAN DEFAULT false",
      // 全体連絡 (announcements) — ダッシュボードに表示される全社向け連絡 + 各メンバーの完了状況
      `CREATE TABLE IF NOT EXISTS announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        body TEXT,
        posted_by UUID,
        posted_at TIMESTAMPTZ DEFAULT now(),
        deadline_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT true,
        slack_pushed_at TIMESTAMPTZ,
        slack_push_result TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )`,
      "CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC)",
      `CREATE TABLE IF NOT EXISTS announcement_acks (
        announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        done_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (announcement_id, user_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_announcement_acks_user ON announcement_acks(user_id)",
      // つぶやき機能 (社内タイムライン)
      `CREATE TABLE IF NOT EXISTS tweets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL CHECK (char_length(body) <= 280),
        image_data TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
        is_pinned BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      )`,
      "CREATE INDEX IF NOT EXISTS idx_tweets_active ON tweets(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets(user_id)",
      `CREATE TABLE IF NOT EXISTS tweet_likes (
        tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (tweet_id, user_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_tweet_likes_user ON tweet_likes(user_id)",
      // 見積書フィールド (Phase A) — schema-sync 失敗時でも本番DBに必ず反映する保険
      "ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS issue_date DATE",
      "ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS valid_until DATE",
      "ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS recipient_name TEXT",
      "ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS honorific TEXT DEFAULT '御中'",
      "ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS estimate_number TEXT",
      `CREATE INDEX IF NOT EXISTS idx_project_estimates_estimate_number
         ON project_estimates(estimate_number)
         WHERE estimate_number IS NOT NULL`,
    ];
    for (const stmt of criticalAlters) {
      try { await client.query(stmt); console.log(`[schema-sync] 保険ALTER成功: ${stmt.slice(0,80)}`); }
      catch (err) { console.warn(`[schema-sync] 保険ALTER失敗: ${err.message}`); }
    }

    // 保険ALTERでカラムだけが FK 無しで追加された場合に備え、必須の FK 制約を後付けで保証する。
    // これが無いと PostgREST が creatives → teams の埋め込み select を解決できず、
    // /api/creatives が 500 を返してフロントが allCreatives.forEach is not a function で落ちる。
    const criticalConstraints = [
      {
        name: 'creatives_team_id_fkey',
        sql: `DO $$
BEGIN
  -- 既存の孤立 team_id を NULL 化（FK 追加時のバリデーション失敗を防ぐ）
  UPDATE public.creatives c
     SET team_id = NULL
   WHERE c.team_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = c.team_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creatives_team_id_fkey' AND conrelid = 'public.creatives'::regclass
  ) THEN
    ALTER TABLE public.creatives
      ADD CONSTRAINT creatives_team_id_fkey
      FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
  END IF;
END
$$`,
      },
    ];
    for (const c of criticalConstraints) {
      try { await client.query(c.sql); console.log(`[schema-sync] 保険FK確認成功: ${c.name}`); }
      catch (err) { console.warn(`[schema-sync] 保険FK確認失敗 (${c.name}): ${err.message}`); }
    }

    // 既定の権限付与（初期セットアップ用 / 既存値は ON CONFLICT で上書きしない）
    // project.delete / team.delete を秘書・プロデューサー・PD に許可。admin はコード側でバイパスされるため不要。
    try {
      await client.query(`
        INSERT INTO role_permissions (role, permission_key, allowed) VALUES
          ('secretary', 'project.delete', true),
          ('producer', 'project.delete', true),
          ('producer_director', 'project.delete', true),
          ('secretary', 'team.delete', true),
          ('producer', 'team.delete', true),
          ('producer_director', 'team.delete', true)
        ON CONFLICT (role, permission_key) DO NOTHING
      `);
      console.log('[schema-sync] project.delete / team.delete のデフォルト権限を付与');
    } catch (err) {
      console.warn(`[schema-sync] デフォルト権限付与失敗: ${err.message}`);
    }

    // 多重防御: public スキーマ全テーブルで RLS を強制有効化（service_role はバイパスするため安全）
    try {
      const rlsBlock = `DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$`;
      await client.query(rlsBlock);
      console.log('[schema-sync] public スキーマ全テーブルで RLS を有効化');
    } catch (err) {
      console.warn(`[schema-sync] RLS 一括有効化失敗: ${err.message}`);
    }

    // PostgRESTのスキーマキャッシュをリロード（DDL反映のため）
    try {
      await client.query("NOTIFY pgrst, 'reload schema'");
      console.log('[schema-sync] PostgRESTキャッシュをリロード通知');
    } catch (err) {
      console.warn('[schema-sync] PostgRESTリロード失敗（無視）:', err.message);
    }

    return { ok: errCount === 0, okCount, errCount, errors, elapsedMs: elapsed };
  } catch (err) {
    console.error('[schema-sync] 致命的エラー:', err.message);
    console.error('[schema-sync] アプリは起動を継続しますが、スキーマが古い可能性があります');
    return { ok: false, error: err.message };
  } finally {
    try { await client.end(); } catch {}
  }
}

module.exports = runSchemaSync;
module.exports.splitSqlStatements = splitSqlStatements;

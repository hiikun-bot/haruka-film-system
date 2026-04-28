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
//   - エラーをログに記録し、{ ok: false, error } を返す
//   - 呼び出し側はアプリ起動を継続する（緊急時の障害耐性）

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runSchemaSync() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.warn('[schema-sync] DATABASE_URL未設定。スキーマ同期をスキップします');
    return { skipped: true };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });

  try {
    await client.connect();
    const schemaPath = path.join(__dirname, '..', 'supabase_schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const startTime = Date.now();
    console.log('[schema-sync] supabase_schema.sql を適用中...');
    await client.query(sql);
    const elapsed = Date.now() - startTime;
    console.log(`[schema-sync] 完了 (${elapsed}ms)`);
    return { ok: true, elapsedMs: elapsed };
  } catch (err) {
    console.error('[schema-sync] 失敗:', err.message);
    console.error('[schema-sync] アプリは起動を継続しますが、スキーマが古い可能性があります');
    return { ok: false, error: err.message };
  } finally {
    try { await client.end(); } catch {}
  }
}

module.exports = runSchemaSync;

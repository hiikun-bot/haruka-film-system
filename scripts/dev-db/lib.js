// scripts/dev-db/lib.js — 開発用DBスクリプトの共通部品（docs/dev-db-setup.md）
// =============================================================
// - 接続先は DEV_DATABASE_URL（無ければ DATABASE_URL）。どちらも .env（git 管理外）から読む。
// - 本番かどうかは utils/prod-db-guard.js（PROD_SUPABASE_PROJECT_REF）で判定し、本番なら即中止。
// - SQL まわりの純関数（psql メタコマンド除去・データ文の検出・無害なエラー判定）はテストあり:
//   tests/dev-db-scripts.test.js
// =============================================================

const path = require('path');
const { splitSqlStatements } = require('../../db/migrate');
const { assertNotProdTarget, extractSupabaseProjectRef } = require('../../utils/prod-db-guard');

const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, '.out'); // git 管理外（.gitignore）

/** 先頭の行コメント・ブロックコメントを取り除いた文頭のキーワード（大文字） */
function leadingKeyword(stmt) {
  let s = String(stmt || '');
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) { const i = s.indexOf('\n'); s = i < 0 ? '' : s.slice(i + 1); continue; }
    if (s.startsWith('/*')) { const i = s.indexOf('*/'); s = i < 0 ? '' : s.slice(i + 2); continue; }
    break;
  }
  const m = s.match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * pg_dump の出力から psql のメタコマンド行（\restrict / \unrestrict / \connect など）を取り除く。
 * pg 経由で流すとき、これらは SQL ではないので構文エラーになる。
 */
function stripPsqlMetaCommands(sql) {
  return String(sql || '')
    .split('\n')
    .filter(line => !/^\\[a-zA-Z]/.test(line))
    .join('\n');
}

/**
 * データを持ち込む文（COPY ... FROM stdin / 文頭の INSERT）を探す。
 * スキーマのみのダンプには出てこないはずなので、1 件でもあれば「データ入りのダンプ」とみなして中止する。
 * 関数本体の中の INSERT（$$ ... $$）は文頭ではないので数えない。
 */
function findDataStatements(statements) {
  const hits = [];
  statements.forEach((stmt, idx) => {
    const kw = leadingKeyword(stmt);
    if (kw === 'COPY' && /\bFROM\s+stdin\b/i.test(stmt)) hits.push({ idx, kind: 'COPY' });
    else if (kw === 'INSERT') hits.push({ idx, kind: 'INSERT' });
  });
  return hits;
}

/** 開発DBへ流すときに「無視してよい」エラー（既に有る・空DBで対象が無い等） */
const BENIGN_ERROR_RE = /already exists|already a member of publication|multiple primary keys|does not exist, skipping/i;
function isBenignSqlError(message) {
  return BENIGN_ERROR_RE.test(String(message || ''));
}

/** コマンドライン引数（--key=value / --flag）を読む */
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

/** 接続先（開発DB）を決めて本番ガードを通す。本番なら throw */
function resolveDevDatabaseUrl(env = process.env) {
  const url = env.DEV_DATABASE_URL || env.DATABASE_URL || '';
  const label = env.DEV_DATABASE_URL ? 'DEV_DATABASE_URL' : 'DATABASE_URL';
  const { ref } = assertNotProdTarget(url, { label, env });
  // SUPABASE_URL も開発を向いていること（seed 後に画面で見るのは SUPABASE_URL 側）
  if (env.SUPABASE_URL) assertNotProdTarget(env.SUPABASE_URL, { label: 'SUPABASE_URL', env });
  return { url, label, ref };
}

/** 接続文字列のパスワードを伏せた表示用 */
function maskDbUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch (_) {
    return '(解析できない接続文字列)';
  }
}

async function connectPg(url) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
  });
  await client.connect();
  return client;
}

/** 文を 1 つずつ流す（失敗しても続ける）。無害なエラーは別に数える */
async function runStatements(client, statements, { phase = '', onError } = {}) {
  let ok = 0;
  let benign = 0;
  const errors = [];
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await client.query(stmt);
      ok++;
    } catch (err) {
      if (isBenignSqlError(err.message)) { benign++; continue; }
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 120);
      const e = { phase, idx: i, preview, error: err.message };
      errors.push(e);
      if (onError) onError(e);
    }
  }
  return { ok, benign, errors };
}

module.exports = {
  ROOT_DIR,
  OUT_DIR,
  splitSqlStatements,
  leadingKeyword,
  stripPsqlMetaCommands,
  findDataStatements,
  isBenignSqlError,
  parseArgs,
  resolveDevDatabaseUrl,
  maskDbUrl,
  connectPg,
  runStatements,
  extractSupabaseProjectRef,
};

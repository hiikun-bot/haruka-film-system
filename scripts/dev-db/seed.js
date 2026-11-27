#!/usr/bin/env node
// scripts/dev-db/seed.js — 開発用DBにダミーデータを入れる（docs/dev-db-setup.md 手順 5）
// =============================================================
// 中身は scripts/dev-db/seed-data.js（架空の名前・example.com・固定ID）。
// - 何度流しても増えない（INSERT ... ON CONFLICT DO NOTHING）
// - 開発DBの実際の列だけを入れる（本番スキーマとリポジトリの差で列が無ければその列は飛ばして警告）
// - 表そのものが無ければその表を飛ばして警告
// - 1 トランザクションで入れ、表ごとにセーブポイントを切る（入らない表があっても残りは入れて、最後に一覧で警告）
//
// 安全装置:
//   - 接続先と SUPABASE_URL が本番（PROD_SUPABASE_PROJECT_REF）なら即中止。ref 未設定でも中止
//   - example.com 以外のメールのユーザーが 5 人を超える DB は「実データ入り」とみなして中止（--allow-nonempty で解除）
//   - --yes が無ければ下見だけ
//
// ログイン: 各ダミーユーザーのパスワードは DEV_SEED_PASSWORD（未設定なら hfs-dev-pass）。
//   例: test-admin@example.com / test-editor@example.com でログインできる。
//
// 使い方:
//   node scripts/dev-db/seed.js          # 下見
//   node scripts/dev-db/seed.js --yes    # 投入
// =============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const bcrypt = require('bcryptjs');
const lib = require('./lib');
const { buildSeedPlan, SEED_EMAIL_DOMAIN } = require('./seed-data');

const REAL_USER_LIMIT = 5;

async function loadColumns(client, table) {
  const { rows } = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table]
  );
  return new Map(rows.map(r => [r.column_name, r.data_type]));
}

function toDbValue(value, dataType) {
  if (value == null) return null;
  if ((dataType === 'jsonb' || dataType === 'json') && typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** 1 段ぶん（INSERT か UPDATE）を流して、結果の 1 行要約を返す */
async function applyStep(client, step, cols) {
  if (step.updates) {
    let n = 0;
    for (const u of step.updates) {
      const keys = Object.keys(u.set).filter(k => cols.has(k));
      if (!keys.length) continue;
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
      const r = await client.query(`UPDATE "${step.table}" SET ${sets} WHERE id = $1`, [u.id, ...keys.map(k => toDbValue(u.set[k], cols.get(k)))]);
      n += r.rowCount;
    }
    return `${step.table}（更新）: ${n}`;
  }
  const dropped = new Set();
  let inserted = 0;
  for (const row of step.rows) {
    const keys = Object.keys(row).filter(k => { if (cols.has(k)) return true; dropped.add(k); return false; });
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO "${step.table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
    const r = await client.query(sql, keys.map(k => toDbValue(row[k], cols.get(k))));
    inserted += r.rowCount;
  }
  if (dropped.size) console.warn(`⚠️ ${step.table}: 開発DBに無い列を飛ばしました（${[...dropped].join(', ')}）`);
  return `${step.table}: ${inserted} / ${step.rows.length}`;
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const target = lib.resolveDevDatabaseUrl(process.env); // 本番なら throw
  console.log('=== 開発DBにダミーデータを入れます ===');
  console.log(`接続先 (${target.label}): ${lib.maskDbUrl(target.url)}  ref=${target.ref || '(Supabase 以外)'}`);

  const client = await lib.connectPg(target.url);
  try {
    // 実データ入りの DB でないか（本番ガードの二重化）
    const usersCols = await loadColumns(client, 'users');
    if (!usersCols.size) throw new Error('users テーブルがありません。先に node scripts/dev-db/apply-schema.js --yes を実行してください');
    const { rows: [{ n: realUsers }] } = await client.query(
      'SELECT count(*)::int AS n FROM users WHERE email NOT ILIKE $1',
      [`%@${SEED_EMAIL_DOMAIN}`]
    );
    if (realUsers > REAL_USER_LIMIT && !args['allow-nonempty']) {
      throw new Error(`example.com 以外のユーザーが ${realUsers} 人います。実データ入りの DB の可能性があるので中止します（開発DBと確かなら --allow-nonempty）`);
    }

    const { rows: roleRows } = await client.query('SELECT id, code FROM roles');
    const roleIds = Object.fromEntries(roleRows.map(r => [r.code, r.id]));
    const { rows: catRows } = await client.query("SELECT id, code FROM creative_categories WHERE code IN ('video','image')");
    const categoryIds = Object.fromEntries(catRows.map(r => [r.code, r.id]));
    const missingRoles = ['admin', 'secretary', 'producer', 'director', 'editor', 'designer', 'external_director'].filter(c => !roleIds[c]);
    if (missingRoles.length) console.warn(`⚠️ roles に無いロール: ${missingRoles.join(', ')}（該当の user_roles / 単価行は飛ばします）`);
    if (!categoryIds.video || !categoryIds.image) console.warn('⚠️ creative_categories に video / image がありません（カテゴリ無しで入れます）');

    const password = process.env.DEV_SEED_PASSWORD || 'hfs-dev-pass';
    const passwordHash = await bcrypt.hash(password, 10);
    const plan = buildSeedPlan({ passwordHash, roleIds, categoryIds });

    plan.forEach(s => console.log(`  - ${s.table}: ${s.rows ? s.rows.length + ' 行' : s.updates.length + ' 行を更新'}`));
    if (!args.yes) {
      console.log('\n下見のみ（何も入れていません）。入れるには --yes を付けてください。');
      return;
    }

    await client.query('BEGIN');
    const summary = [];
    const failed = [];
    for (const step of plan) {
      const cols = await loadColumns(client, step.table);
      if (!cols.size) { console.warn(`⚠️ ${step.table} が開発DBに無いので飛ばします`); continue; }
      // 表ごとにセーブポイント。1 つの表が入らなくても（本番にだけある必須列など）残りは続ける
      await client.query('SAVEPOINT seed_step');
      try {
        summary.push(await applyStep(client, step, cols));
        await client.query('RELEASE SAVEPOINT seed_step');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT seed_step');
        failed.push(`${step.table}: ${e.message}`);
        console.warn(`⚠️ ${step.table} を入れられませんでした: ${e.message}`);
      }
    }
    await client.query('COMMIT');
    if (failed.length) console.warn(`\n⚠️ 入らなかった表 ${failed.length} 件（後ろの表が外部キーで連鎖して失敗している場合あり）:\n  ${failed.join('\n  ')}`);
    console.log('\n✅ 投入完了（新しく入った行 / 用意した行。既にあれば 0）');
    summary.forEach(s => console.log(`  ${s}`));
    console.log(`\nログイン: test-admin@${SEED_EMAIL_DOMAIN} など / パスワード: ${process.env.DEV_SEED_PASSWORD ? '(DEV_SEED_PASSWORD の値)' : password}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

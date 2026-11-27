#!/usr/bin/env node
// scripts/dev-db/apply-schema.js — 開発用DBに本番と同じ「表の形」を作る（docs/dev-db-setup.md 手順 4）
// =============================================================
// 方式（--from-dump が既定・推奨）:
//   --from-dump[=<file>]  dump-prod-schema.sh が書き出した本番のスキーマ（既定 scripts/dev-db/.out/prod-schema.sql）を流す。
//                         本番で手作業で作られた表（例: team_members）や関数・トリガー・ポリシーまで本番どおりになる。
//                         続けて supabase_schema.sql も流す（サーバー起動時の schema-sync と同じ。roles などの初期マスタ行が入る）。
//   --from-repo           リポジトリだけで組み立てる（本番に一切触れない）。supabase_schema.sql → migrations/*.sql（日付順）
//                         → supabase_schema.sql の順に流す。リポジトリに定義が無い表は作られない（不完全になりうる）。
//
// 共通の後処理: public の全テーブルで RLS を有効化（ADR 048）→ PostgREST のスキーマキャッシュを再読込。
//
// 安全装置:
//   - 接続先（DEV_DATABASE_URL か DATABASE_URL）と SUPABASE_URL が本番（PROD_SUPABASE_PROJECT_REF）なら即中止
//   - PROD_SUPABASE_PROJECT_REF が未設定でも中止（判定できないため）
//   - --yes が無ければ「どこに何を流すか」を表示して終わる（下見）
//   - --reset（public を作り直す）は開発DB専用。--yes と併用したときだけ実行
//
// 使い方:
//   node scripts/dev-db/apply-schema.js                 # 下見（何もしない）
//   node scripts/dev-db/apply-schema.js --yes           # 本番スキーマのダンプを開発DBへ
//   node scripts/dev-db/apply-schema.js --from-repo --yes
//   node scripts/dev-db/apply-schema.js --reset --yes   # 開発DBの public を空にしてから作り直す
// =============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const RESET_SQL = [
  'DROP SCHEMA IF EXISTS public CASCADE',
  'CREATE SCHEMA public',
  'GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role',
  'GRANT ALL ON SCHEMA public TO postgres, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role',
];

const POST_SQL = [
  `DO $dev_rls$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$dev_rls$`,
  "NOTIFY pgrst, 'reload schema'",
];

function readSqlFile(file) {
  return lib.splitSqlStatements(lib.stripPsqlMetaCommands(fs.readFileSync(file, 'utf8')));
}

function buildPlan(args) {
  const schemaFile = path.join(lib.ROOT_DIR, 'supabase_schema.sql');
  if (args['from-repo']) {
    const migDir = path.join(lib.ROOT_DIR, 'migrations');
    const migrations = fs.readdirSync(migDir)
      .filter(f => f.endsWith('.sql') && !/_down\.sql$/.test(f))
      .sort()
      .map(f => path.join(migDir, f));
    return [
      { phase: 'supabase_schema.sql（1回目）', file: schemaFile },
      ...migrations.map(f => ({ phase: `migrations/${path.basename(f)}`, file: f })),
      { phase: 'supabase_schema.sql（2回目）', file: schemaFile },
    ];
  }
  const dumpFile = typeof args['from-dump'] === 'string'
    ? path.resolve(args['from-dump'])
    : path.join(lib.OUT_DIR, 'prod-schema.sql');
  if (!fs.existsSync(dumpFile)) {
    throw new Error(`本番スキーマのダンプが見つかりません: ${dumpFile}\n  先に bash scripts/dev-db/dump-prod-schema.sh を実行するか、--from-repo を使ってください`);
  }
  const plan = [{ phase: '本番スキーマ（pg_dump --schema-only）', file: dumpFile, mustBeSchemaOnly: true }];
  if (!args['skip-repo-schema']) plan.push({ phase: 'supabase_schema.sql（初期マスタ行・起動時 schema-sync と同じ）', file: schemaFile });
  return plan;
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const target = lib.resolveDevDatabaseUrl(process.env); // 本番なら throw
  const plan = buildPlan(args);

  // ダンプにデータが混ざっていないか（スキーマのみのはず）
  for (const step of plan) {
    if (!step.mustBeSchemaOnly) continue;
    const hits = lib.findDataStatements(readSqlFile(step.file));
    if (hits.length) throw new Error(`${step.file} にデータを含む文が ${hits.length} 件あります。スキーマのみのダンプを使ってください`);
  }

  console.log('=== 開発DBへスキーマを当てます ===');
  console.log(`接続先 (${target.label}): ${lib.maskDbUrl(target.url)}  ref=${target.ref || '(Supabase 以外)'}`);
  if (args.reset) console.log('⚠️  --reset: 開発DBの public スキーマを丸ごと作り直します（中のデータも消えます）');
  plan.forEach((s, i) => console.log(`  ${i + 1}. ${s.phase}`));
  if (!args.yes) {
    console.log('\n下見のみ（何も実行していません）。実行するには --yes を付けてください。');
    return;
  }

  const client = await lib.connectPg(target.url);
  const allErrors = [];
  try {
    if (args.reset) {
      const r = await lib.runStatements(client, RESET_SQL, { phase: 'reset' });
      if (r.errors.length) throw new Error(`public の作り直しに失敗: ${r.errors[0].error}`);
      console.log('✔ public を作り直しました');
    }
    for (const step of plan) {
      // pg_dump の出力は search_path を空にするので、各段の前に Supabase の既定へ戻す
      await client.query('SET search_path TO "$user", public, extensions');
      const stmts = readSqlFile(step.file);
      const r = await lib.runStatements(client, stmts, { phase: step.phase });
      allErrors.push(...r.errors);
      console.log(`✔ ${step.phase}: OK=${r.ok} 既存のためスキップ=${r.benign} 失敗=${r.errors.length}`);
    }
    await client.query('SET search_path TO "$user", public, extensions');
    const post = await lib.runStatements(client, POST_SQL, { phase: '後処理（RLS・スキーマ再読込）' });
    allErrors.push(...post.errors);

    const { rows: tables } = await client.query(
      "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1"
    );
    const noRls = tables.filter(t => !t.relrowsecurity).map(t => t.relname);
    console.log(`\n public のテーブル: ${tables.length} 個 / RLS 無効: ${noRls.length} 個${noRls.length ? '（' + noRls.join(', ') + '）' : ''}`);
  } finally {
    await client.end().catch(() => {});
  }

  if (allErrors.length) {
    fs.mkdirSync(lib.OUT_DIR, { recursive: true });
    const logFile = path.join(lib.OUT_DIR, 'apply-errors.json');
    fs.writeFileSync(logFile, JSON.stringify(allErrors, null, 2));
    console.log(` 失敗した文: ${allErrors.length} 件（詳細 ${logFile}）。先頭 5 件:`);
    allErrors.slice(0, 5).forEach(e => console.log(`  - [${e.phase}] ${e.error}\n      ${e.preview}`));
    console.log(' ※ --from-repo では、リポジトリに定義の無い表を前提にした文が失敗することがあります。');
  } else {
    console.log(' 失敗した文はありません');
  }
  console.log('\n次: node scripts/dev-db/seed.js --yes   （ダミーデータを入れる）');
}

main().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
// scripts/rename_invoice_member_folders.js
//
// 既存の請求書メンバーフォルダ名を新形式「氏名 YYYY年MM月」にリネームする一回限りスクリプト。
//
// 役割:
//   旧仕様では各メンバーの個人請求書フォルダ名が「氏名」だけだった。
//   Drive の「共有アイテム」「マイドライブ」から直接開いたときに何月分か分からない問題があり、
//   サーバ側ロジックを「氏名 YYYY年MM月」形式に統一した。
//   このスクリプトは旧形式で既に生成されている既存フォルダを一括でリネームする。
//
// 動作:
//   1. member_invoice_folders を全件取得
//   2. 各レコードの folder_id を Drive API で参照し、現在のフォルダ名を取得
//   3. users から full_name / nickname / email を引いて期待される新形式名を算出
//   4. 現在名 !== 期待名のときだけ rename
//   5. 冪等: 既に新形式なら skip ログのみ
//
// オプション:
//   --dry-run        実際の rename 実行せずログのみ
//   --limit=N        先頭 N レコードのみ処理（テスト用）
//   --help / -h      このヘルプを表示
//
// 環境変数依存:
//   - GOOGLE_SERVICE_ACCOUNT_KEY  サービスアカウント JSON（routes/haruka.js と同じ仕組み）
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// 実行方法:
//   cd HARUKA-FILM-SYSTEM/_main
//   node scripts/rename_invoice_member_folders.js --dry-run
//   node scripts/rename_invoice_member_folders.js
//
// 並列度:
//   Drive rename API はやや重いため CONCURRENCY=5 で mapLimit 風に処理。

require('dotenv').config();
const supabase = require('../supabase');
const {
  getDriveService,
  buildMemberFolderName,
  buildInvoiceMemberFolderName,
} = require('../routes/haruka');

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const HELP     = args.includes('--help') || args.includes('-h');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT     = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

const CONCURRENCY = 5;

function usage() {
  console.log(`
Usage: node scripts/rename_invoice_member_folders.js [options]

Options:
  --dry-run        実際の rename を実行せずログのみ
  --limit=N        先頭 N レコードのみ処理（テスト用）
  --help, -h       このヘルプを表示

Examples:
  node scripts/rename_invoice_member_folders.js --dry-run
  node scripts/rename_invoice_member_folders.js --limit=5
  node scripts/rename_invoice_member_folders.js
`);
}

if (HELP) { usage(); process.exit(0); }
if (LIMIT_ARG && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error('[rename-invoice-folders] --limit=N の N は正の整数を指定してください');
  process.exit(1);
}

// 簡易 mapLimit: 配列を limit 並列で逐次 worker に流す
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { __error: e };
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
  await Promise.all(runners);
  return results;
}

async function fetchMappings() {
  let q = supabase
    .from('member_invoice_folders')
    .select('id, user_id, year, month, folder_id')
    .order('year', { ascending: true })
    .order('month', { ascending: true });
  if (LIMIT) q = q.limit(LIMIT);
  const { data, error } = await q;
  if (error) throw new Error(`member_invoice_folders 取得失敗: ${error.message}`);
  return data || [];
}

async function fetchUsersByIds(ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active')
    .in('id', ids);
  if (error) throw new Error(`users 取得失敗: ${error.message}`);
  const map = new Map();
  for (const u of data || []) map.set(u.id, u);
  return map;
}

async function main() {
  console.log('[rename-invoice-folders] 開始');
  console.log(`[rename-invoice-folders] DRY_RUN=${DRY_RUN}  LIMIT=${LIMIT || '-'}  CONCURRENCY=${CONCURRENCY}`);

  const drive = await getDriveService();

  const rows = await fetchMappings();
  console.log(`[rename-invoice-folders] 対象レコード: ${rows.length} 件`);
  if (!rows.length) {
    console.log('[rename-invoice-folders] 対象なし。終了');
    return;
  }

  // user 情報を一括取得
  const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
  const userMap = await fetchUsersByIds(userIds);

  let renamed = 0;
  let skipped = 0;
  let failed  = 0;
  let missingUser = 0;

  await mapLimit(rows, CONCURRENCY, async (row) => {
    const tag = `user=${row.user_id} ${row.year}/${String(row.month).padStart(2,'0')} folder=${row.folder_id}`;
    const u = userMap.get(row.user_id);
    if (!u) {
      missingUser++;
      console.warn(`[skip-no-user] ${tag} : users に該当レコードなし`);
      return;
    }
    if (!row.folder_id) {
      skipped++;
      console.warn(`[skip-no-folder-id] ${tag}`);
      return;
    }
    const baseName = buildInvoiceMemberFolderName(u);
    const expectedName = buildMemberFolderName(baseName, row.year, row.month);

    // 現在の Drive 上の名前を取得
    let currentName;
    try {
      const meta = await drive.files.get({
        fileId: row.folder_id,
        fields: 'id,name',
        supportsAllDrives: true,
      });
      currentName = meta.data.name;
    } catch (e) {
      failed++;
      console.error(`[fail-get] ${tag} : ${e.message}`);
      return;
    }

    // 衝突回避 suffix を考慮: 既存名が「baseName (emailLocal)」形式の場合は
    // expected も同じ suffix 付きで判定する
    const emailLocal = (u.email || '').split('@')[0];
    const baseNameWithEmail = `${baseName} (${emailLocal})`;
    const expectedWithEmail = buildMemberFolderName(baseNameWithEmail, row.year, row.month);

    if (currentName === expectedName || currentName === expectedWithEmail) {
      skipped++;
      console.log(`[skip-already-renamed] ${tag} : "${currentName}"`);
      return;
    }

    // 旧形式: 「氏名」または「氏名 (emailLocal)」
    // 衝突 suffix が付いていた場合はその形式の new name に揃える
    let targetNewName = expectedName;
    if (currentName === baseNameWithEmail) {
      targetNewName = expectedWithEmail;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] rename ${tag} : "${currentName}" -> "${targetNewName}"`);
      renamed++;
      return;
    }

    try {
      await drive.files.update({
        fileId: row.folder_id,
        requestBody: { name: targetNewName },
        supportsAllDrives: true,
      });
      renamed++;
      console.log(`[renamed] ${tag} : "${currentName}" -> "${targetNewName}"`);
    } catch (e) {
      failed++;
      console.error(`[fail-update] ${tag} : ${e.message}`);
    }
  });

  console.log('');
  console.log('[rename-invoice-folders] 集計');
  console.log(`  renamed       : ${renamed}`);
  console.log(`  skipped       : ${skipped}`);
  console.log(`  failed        : ${failed}`);
  console.log(`  missing-user  : ${missingUser}`);
  console.log('[rename-invoice-folders] 完了');
}

main().catch(e => {
  console.error('[rename-invoice-folders] 予期せぬエラー:', e.stack || e.message);
  process.exit(1);
});

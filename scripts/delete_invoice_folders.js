#!/usr/bin/env node
// scripts/delete_invoice_folders.js
//
// 役割: 特定ロール × 特定年月の請求書フォルダを Drive から完全削除 +
//       member_invoice_folders レコード削除する運用スクリプト。
//
// 使用例:
//   # 秘書の 2026年4月 を全削除（dry-run）
//   node scripts/delete_invoice_folders.js --role=secretary --year=2026 --month=4 --dry-run
//
//   # 本番実行
//   node scripts/delete_invoice_folders.js --role=secretary --year=2026 --month=4
//
//   # 単一ユーザー指定
//   node scripts/delete_invoice_folders.js --user-email=foo@bar.com --year=2026 --month=4
//
//   # 月を範囲で
//   node scripts/delete_invoice_folders.js --role=secretary --year=2026 --months=4,5,6
//
//   # 20件超のときは --force が必要（安全装置）
//   node scripts/delete_invoice_folders.js --role=editor --year=2026 --month=4 --force
//
// 動作:
//   1. 対象レコードを member_invoice_folders から SELECT
//   2. 各 folder_id を drive.files.delete で完全削除（ゴミ箱もスキップ）
//   3. member_invoice_folders から該当行を DELETE
//   4. invoice_folder_audit_log に記録
//   5. 集計: 削除件数 / 既に消えていた件数 / 失敗件数を表示
//
// 環境変数:
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// 注意: drive.files.delete は permanently delete（ゴミ箱スキップ、restore 不可）。
//       本番実行前に必ず --dry-run で対象を確認すること。

require('dotenv').config();
const readline = require('readline');
const supabase = require('../supabase');
const { getDriveService } = require('../routes/haruka');

// -------- CLI 引数パース --------

const args = process.argv.slice(2);

function getArgValue(name) {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : null;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const ROLE = getArgValue('role');
const USER_EMAIL = (getArgValue('user-email') || '').trim().toLowerCase() || null;
const YEAR_STR = getArgValue('year');
const MONTH_STR = getArgValue('month');
const MONTHS_STR = getArgValue('months');
const LIMIT_STR = getArgValue('limit');
const DRY_RUN = hasFlag('dry-run');
const FORCE = hasFlag('force');
const INCLUDE_ADMIN = hasFlag('include-admin');

function log(...a) { console.log('[delete-invoice-folders]', ...a); }
function warn(...a) { console.warn('[delete-invoice-folders]', ...a); }
function die(msg) {
  console.error(`[delete-invoice-folders] ERROR: ${msg}`);
  process.exit(1);
}

if (!ROLE && !USER_EMAIL) {
  die('--role か --user-email のどちらかは必須です');
}
if (!YEAR_STR) die('--year は必須です');
const YEAR = parseInt(YEAR_STR, 10);
if (!Number.isInteger(YEAR) || YEAR < 2000 || YEAR > 2100) {
  die(`--year=${YEAR_STR} が不正です (2000-2100)`);
}

let MONTHS = [];
if (MONTH_STR && MONTHS_STR) die('--month と --months は同時指定できません');
if (MONTH_STR) {
  const m = parseInt(MONTH_STR, 10);
  if (!Number.isInteger(m) || m < 1 || m > 12) die(`--month=${MONTH_STR} が不正です`);
  MONTHS = [m];
} else if (MONTHS_STR) {
  MONTHS = MONTHS_STR.split(',').map(s => parseInt(s.trim(), 10));
  for (const m of MONTHS) {
    if (!Number.isInteger(m) || m < 1 || m > 12) die(`--months に不正な値が含まれます: ${MONTHS_STR}`);
  }
  MONTHS = Array.from(new Set(MONTHS)).sort((a, b) => a - b);
} else {
  die('--month か --months のどちらかは必須です');
}

const LIMIT = LIMIT_STR ? parseInt(LIMIT_STR, 10) : null;
if (LIMIT_STR && (!Number.isInteger(LIMIT) || LIMIT <= 0)) {
  die(`--limit=${LIMIT_STR} が不正です`);
}

// -------- ロール解決 (dual-read: user_roles + legacy users.role) --------

async function fetchUserIdsByRole(roleCode, { includeAdmin = false } = {}) {
  const userIdSet = new Set();
  // 1. user_roles 経由（roles マスタ）
  const codesToMatch = [roleCode];
  if (includeAdmin && roleCode !== 'admin') codesToMatch.push('admin');

  const { data: rolesRows, error: rolesErr } = await supabase
    .from('roles').select('id, code').in('code', codesToMatch);
  if (rolesErr) throw new Error(`roles select 失敗: ${rolesErr.message}`);
  const roleIds = (rolesRows || []).map(r => r.id);
  if (roleIds.length > 0) {
    const { data: urRows, error: urErr } = await supabase
      .from('user_roles').select('user_id').in('role_id', roleIds);
    if (urErr) throw new Error(`user_roles select 失敗: ${urErr.message}`);
    (urRows || []).forEach(r => userIdSet.add(r.user_id));
  }
  // 2. legacy users.role
  // producer_director は producer / director どちらの請求にも該当しうるが、
  // 本スクリプトでは「指定 role を持つ user」を素直に絞り込む。
  const legacyMatch = [...codesToMatch];
  if (codesToMatch.includes('producer') || codesToMatch.includes('director')) {
    legacyMatch.push('producer_director');
  }
  const { data: legacy, error: legacyErr } = await supabase
    .from('users').select('id').in('role', legacyMatch);
  if (legacyErr) throw new Error(`users select 失敗: ${legacyErr.message}`);
  (legacy || []).forEach(u => userIdSet.add(u.id));

  return Array.from(userIdSet);
}

async function fetchUserIdByEmail(email) {
  const { data, error } = await supabase
    .from('users').select('id, email').ilike('email', email).maybeSingle();
  if (error) throw new Error(`users select 失敗: ${error.message}`);
  return data ? data.id : null;
}

// -------- Drive 操作 --------

async function getFolderName(drive, folderId) {
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'name, trashed',
      supportsAllDrives: true,
    });
    return { name: res.data.name, trashed: !!res.data.trashed, missing: false };
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 404 || (e.message && /not found|File not found/i.test(e.message))) {
      return { name: null, trashed: false, missing: true };
    }
    throw e;
  }
}

async function deleteFolder(drive, folderId) {
  try {
    await drive.files.delete({
      fileId: folderId,
      supportsAllDrives: true,
    });
    return 'deleted';
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 404 || (e.message && /not found|File not found/i.test(e.message))) {
      return 'already_gone';
    }
    throw e;
  }
}

// -------- 確認プロンプト --------

function confirmPrompt(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} [y/N]: `, ans => {
      rl.close();
      resolve(/^y(es)?$/i.test((ans || '').trim()));
    });
  });
}

// -------- メイン --------

async function main() {
  const startTime = Date.now();
  log(
    `開始 role=${ROLE || '-'} user_email=${USER_EMAIL || '-'} ` +
    `year=${YEAR} months=[${MONTHS.join(',')}] ` +
    `DRY_RUN=${DRY_RUN} FORCE=${FORCE} INCLUDE_ADMIN=${INCLUDE_ADMIN}` +
    `${LIMIT ? ` LIMIT=${LIMIT}` : ''}`
  );

  // 1. 対象ユーザー ID 集合を構築
  let targetUserIds = null; // null = 制限なし
  if (ROLE) {
    targetUserIds = await fetchUserIdsByRole(ROLE, { includeAdmin: INCLUDE_ADMIN });
    log(`role=${ROLE} ${INCLUDE_ADMIN ? '(+admin)' : ''} に該当するユーザー: ${targetUserIds.length} 名`);
    if (targetUserIds.length === 0) {
      log('対象ユーザー 0 名のため終了');
      return;
    }
  }
  if (USER_EMAIL) {
    const uid = await fetchUserIdByEmail(USER_EMAIL);
    if (!uid) die(`user-email=${USER_EMAIL} に該当するユーザーが見つかりません`);
    if (targetUserIds === null) {
      targetUserIds = [uid];
    } else {
      // AND 条件
      targetUserIds = targetUserIds.includes(uid) ? [uid] : [];
      if (targetUserIds.length === 0) {
        die(`user-email=${USER_EMAIL} は role=${ROLE} に該当しません (AND 条件)`);
      }
    }
  }

  // 2. member_invoice_folders から対象行を SELECT
  let q = supabase
    .from('member_invoice_folders')
    .select('id, user_id, year, month, folder_id, folder_url')
    .eq('year', YEAR)
    .in('month', MONTHS)
    .not('folder_id', 'is', null)
    .order('user_id, month');
  if (targetUserIds && targetUserIds.length > 0) {
    q = q.in('user_id', targetUserIds);
  }
  if (LIMIT) q = q.limit(LIMIT);
  const { data: folders, error: fErr } = await q;
  if (fErr) die(`member_invoice_folders 取得失敗: ${fErr.message}`);

  log(`対象フォルダ: ${folders.length} 件`);
  if (folders.length === 0) {
    log('対象 0 件のため終了');
    return;
  }

  // user 情報を一括取得して名前表示用
  const userIds = Array.from(new Set(folders.map(f => f.user_id)));
  const { data: users } = await supabase
    .from('users').select('id, email, nickname, full_name').in('id', userIds);
  const userById = new Map((users || []).map(u => [u.id, u]));

  // 3. Drive
  const drive = await getDriveService();

  // 4. 事前確認: 各フォルダの実名を取って一覧表示
  log('---------- 削除対象 ----------');
  const previews = [];
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i];
    const u = userById.get(f.user_id);
    const userLabel = u ? `${u.email}${u.nickname ? ` (${u.nickname})` : ''}` : f.user_id;
    let info;
    try {
      info = await getFolderName(drive, f.folder_id);
    } catch (e) {
      info = { name: `<取得失敗: ${e.message}>`, trashed: false, missing: false };
    }
    const state = info.missing ? 'MISSING' : (info.trashed ? 'TRASHED' : 'EXISTS');
    previews.push({ folder: f, user: u, info, state });
    log(
      `  [${i + 1}/${folders.length}] ${userLabel} ${f.year}/${f.month} ` +
      `file=${f.folder_id} state=${state} name=${info.name || '-'}`
    );
  }
  log('-----------------------------');

  // 5. 安全装置
  if (folders.length > 20 && !FORCE && !DRY_RUN) {
    die(
      `対象が ${folders.length} 件 > 20 件です。安全装置によりブロックされました。\n` +
      `       本当に削除する場合は --force を付けて再実行してください。\n` +
      `       （または先に --dry-run で内容を確認してください）`
    );
  }

  if (!DRY_RUN && !FORCE && folders.length > 0) {
    const ok = await confirmPrompt(
      `上記 ${folders.length} 件を Drive から完全削除 + DB 行 DELETE します。実行しますか？`
    );
    if (!ok) {
      log('キャンセルされました');
      return;
    }
  }

  // 6. 並列度 5 で削除実行
  let deletedCount = 0;
  let alreadyGoneCount = 0;
  let failedCount = 0;
  let dbDeletedCount = 0;
  const failures = [];

  const concurrency = 5;
  let i = 0;
  async function worker() {
    while (i < previews.length) {
      const idx = i++;
      const { folder, user, info, state } = previews[idx];
      const userLabel = user ? user.email : folder.user_id;
      const tag = `[${idx + 1}/${previews.length}] ${userLabel} ${folder.year}/${folder.month}`;

      try {
        if (DRY_RUN) {
          log(`${tag} [dry-run] would delete file=${folder.folder_id} (${state}) name=${info.name || '-'}`);
          log(`${tag} [dry-run] would DELETE member_invoice_folders id=${folder.id}`);
          // dry-run でも統計用に分類
          if (state === 'MISSING') alreadyGoneCount++;
          else deletedCount++;
          continue;
        }

        // 実削除
        const result = await deleteFolder(drive, folder.folder_id);
        if (result === 'already_gone') {
          alreadyGoneCount++;
          log(`${tag} drive: already_gone file=${folder.folder_id}`);
        } else {
          deletedCount++;
          log(`${tag} drive: deleted file=${folder.folder_id}`);
        }

        // DB 行削除
        const { error: delErr } = await supabase
          .from('member_invoice_folders').delete().eq('id', folder.id);
        if (delErr) {
          failedCount++;
          failures.push({ id: folder.id, err: `DB delete: ${delErr.message}` });
          warn(`${tag} DB DELETE 失敗: ${delErr.message}`);
        } else {
          dbDeletedCount++;
          log(`${tag} db: DELETE id=${folder.id}`);
        }
      } catch (e) {
        failedCount++;
        failures.push({ id: folder.id, err: e.message });
        warn(`${tag} 失敗: ${e.message}`);
      }
    }
  }
  await Promise.all(Array(concurrency).fill(0).map(() => worker()));

  const duration_ms = Date.now() - startTime;

  // 7. audit_log
  if (!DRY_RUN) {
    const status = failedCount > 0 ? 'partial' : 'success';
    const { error: auditErr } = await supabase.from('invoice_folder_audit_log').insert({
      approved_by_user_id: null,
      command_args: {
        script: 'delete_invoice_folders',
        role: ROLE,
        user_email: USER_EMAIL,
        year: YEAR,
        months: MONTHS,
        include_admin: INCLUDE_ADMIN,
        limit: LIMIT,
        force: FORCE,
        dry_run: false,
      },
      folders_created_count: 0,
      folders_skipped_count: alreadyGoneCount,
      permissions_granted_count: 0,
      permissions_revoked_count: deletedCount,
      duration_ms,
      status,
      error_message: failedCount > 0 ? `${failedCount} folders failed` : null,
    });
    if (auditErr) warn(`audit_log insert 失敗: ${auditErr.message}`);
  }

  // 8. 集計
  log('========== サマリ ==========');
  log(`DRY_RUN:            ${DRY_RUN}`);
  log(`target folders:     ${previews.length}`);
  log(`  - drive deleted:  ${deletedCount}`);
  log(`  - already gone:   ${alreadyGoneCount}`);
  log(`  - db rows DELETE: ${dbDeletedCount}`);
  log(`  - failures:       ${failedCount}`);
  log(`duration:           ${duration_ms}ms`);
  if (failures.length > 0) {
    log('---------- failures ----------');
    failures.forEach(f => log(`  id=${f.id}: ${f.err}`));
  }
  log('完了');
}

main().catch(e => {
  console.error('[delete-invoice-folders] 致命的エラー:', e.stack || e.message);
  process.exit(1);
});

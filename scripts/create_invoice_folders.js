#!/usr/bin/env node
// scripts/create_invoice_folders.js
//
// 役割:
//   Google Workspace の HARUKAFILM フォルダ配下に
//     HARUKAFILM/請求書/{年}/{月}/{メンバー氏名}/
//   の階層を一括生成する。
//   管理者・秘書は「請求書」ルートフォルダから permission を継承して全閲覧可。
//   各メンバーは自分のフォルダのみ writer 権限を持つ（他メンバーの請求書は見えない）。
//
// 実行方法:
//   cd HARUKA-FILM-SYSTEM/_main
//   node scripts/create_invoice_folders.js --year=2026
//
// CLI オプション:
//   --year=YYYY     指定年の 1〜12 月＋メンバー個人フォルダを全部作成する（必須）
//   --sync-roles    「請求書」ルートフォルダの管理者・秘書 writer 権限を
//                   DB状態と同期（追加・剥奪両方）。--year と排他
//   --dry-run       実際の Drive API write は行わず、生成予定ログのみ出力
//   --help          このヘルプを表示
//
// 環境変数依存:
//   - GOOGLE_SERVICE_ACCOUNT_KEY  サービスアカウント JSON（routes/haruka.js と同じ仕組み）
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   - DRIVE_ROOT_FOLDER_ID（任意。system_settings.drive_root_folder_id が無い場合のフォールバック）
//
// 冪等性:
//   既存フォルダは getOrCreateFolder で再利用、既存 permission は ensureUserPermission で skip。
//   何度叩いても安全。
//
// 秘書増減時の運用フロー:
//   1. 秘書ユーザーに roles=secretary を user_roles で付与（または剥奪）
//   2. `node scripts/create_invoice_folders.js --sync-roles` を実行
//      → 「請求書」ルートフォルダの writer 権限が DB と一致する状態へ寄せられる
//      → 子フォルダは継承で自動的に反映される

require('dotenv').config();
const supabase = require('../supabase');
const { getDriveService, getOrCreateFolder, getDriveRootFolderId } = require('../routes/haruka');

const args = process.argv.slice(2);
const YEAR_ARG    = args.find(a => a.startsWith('--year='));
const YEAR        = YEAR_ARG ? parseInt(YEAR_ARG.split('=')[1], 10) : null;
const SYNC_ROLES  = args.includes('--sync-roles');
const DRY_RUN     = args.includes('--dry-run');
const HELP        = args.includes('--help') || args.includes('-h');

function usage() {
  console.log(`
Usage: node scripts/create_invoice_folders.js [options]

Options:
  --year=YYYY     指定年の 1〜12月＋メンバー個人フォルダを全部作成（必須・--sync-roles と排他）
  --sync-roles    「請求書」ルートフォルダの管理者・秘書 writer 権限をDB状態と同期
  --dry-run       実際の Drive API write は行わず、生成予定ログのみ出力
  --help, -h      このヘルプを表示

Examples:
  node scripts/create_invoice_folders.js --year=2026 --dry-run
  node scripts/create_invoice_folders.js --year=2026
  node scripts/create_invoice_folders.js --sync-roles
`);
}

if (HELP) { usage(); process.exit(1); }
if (!YEAR && !SYNC_ROLES) {
  console.error('[invoice-folders] --year=YYYY または --sync-roles を指定してください');
  usage();
  process.exit(1);
}
if (YEAR && SYNC_ROLES) {
  console.error('[invoice-folders] --year と --sync-roles は同時に指定できません');
  process.exit(1);
}
if (YEAR && (YEAR < 2000 || YEAR > 2100)) {
  console.error('[invoice-folders] --year は 2000〜2100 の範囲で指定してください');
  process.exit(1);
}

// ---------- ヘルパー ----------

// 管理者・秘書のメール一覧を取得（user_roles + users）
async function fetchStaffMembers() {
  // 1. roles マスタから admin / secretary の id を取得
  const { data: rolesRows, error: rolesErr } = await supabase
    .from('roles').select('id, code').in('code', ['admin', 'secretary']);
  if (rolesErr) throw new Error(`roles 取得失敗: ${rolesErr.message}`);
  const staffRoleIds = (rolesRows || []).map(r => r.id);
  if (staffRoleIds.length === 0) {
    console.warn('[invoice-folders] roles に admin/secretary が見つかりません');
    return [];
  }

  // 2. user_roles から user_id を引く
  const { data: urRows, error: urErr } = await supabase
    .from('user_roles').select('user_id').in('role_id', staffRoleIds);
  if (urErr) throw new Error(`user_roles 取得失敗: ${urErr.message}`);
  const userIdsFromUserRoles = new Set((urRows || []).map(r => r.user_id));

  // 3. dual-read fallback: users.role が admin/secretary の users も拾う
  const { data: legacyUsers, error: legacyErr } = await supabase
    .from('users').select('id').in('role', ['admin', 'secretary']);
  if (legacyErr) throw new Error(`users(legacy role) 取得失敗: ${legacyErr.message}`);
  (legacyUsers || []).forEach(u => userIdsFromUserRoles.add(u.id));

  if (userIdsFromUserRoles.size === 0) return [];

  // 4. users 本体から email/full_name/is_active を引く
  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active')
    .in('id', Array.from(userIdsFromUserRoles));
  if (usersErr) throw new Error(`users 取得失敗: ${usersErr.message}`);

  // active & email 有りのみ
  return (users || [])
    .filter(u => u.is_active !== false && u.email)
    .map(u => ({ id: u.id, email: u.email.trim().toLowerCase(), full_name: u.full_name, nickname: u.nickname }));
}

// アクティブな全メンバーを取得（個人フォルダ生成対象）
async function fetchAllActiveMembers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active')
    .eq('is_active', true);
  if (error) throw new Error(`users 取得失敗: ${error.message}`);
  return (data || [])
    .filter(u => u.email)
    .map(u => ({ id: u.id, email: u.email.trim().toLowerCase(), full_name: u.full_name, nickname: u.nickname }));
}

// 同名衝突を回避したフォルダ名にする
function buildMemberFolderName(u, nameCount) {
  const base = (u.full_name && u.full_name.trim())
    || (u.nickname && u.nickname.trim())
    || u.email.split('@')[0];
  if ((nameCount.get(base) || 0) > 1) {
    return `${base} (${u.email.split('@')[0]})`;
  }
  return base;
}

// permissions を idempotent に付与
async function ensureUserPermission(drive, fileId, email, role = 'writer') {
  if (DRY_RUN) {
    console.log(`[dry-run] permission grant: ${email} as ${role} on ${fileId}`);
    return;
  }
  try {
    // 1. 既存 permissions を list
    const list = await drive.permissions.list({
      fileId,
      fields: 'permissions(id,emailAddress,role,type)',
      supportsAllDrives: true,
    });
    const perms = list.data.permissions || [];
    const target = email.toLowerCase();
    const existing = perms.find(p => (p.emailAddress || '').toLowerCase() === target && p.type === 'user');
    if (existing) {
      // owner はそのまま、writer 以上なら何もしない
      if (existing.role === 'owner' || existing.role === role || existing.role === 'writer') return;
      // 権限が弱い場合は update
      await drive.permissions.update({
        fileId,
        permissionId: existing.id,
        requestBody: { role },
        supportsAllDrives: true,
      });
      return;
    }
    // 2. 新規付与
    await drive.permissions.create({
      fileId,
      requestBody: { role, type: 'user', emailAddress: email },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 400 || status === 403 || status === 409) {
      console.warn(`[invoice-folders] permission grant warn (${status}) ${email} on ${fileId}: ${e.message}`);
      return;
    }
    throw e;
  }
}

// 「請求書」ルートフォルダを取得 or 作成
async function ensureInvoiceRootFolder(drive, harukafilmId) {
  if (DRY_RUN) {
    console.log(`[dry-run] ensure 請求書 root under HARUKAFILM (${harukafilmId})`);
    return 'DRY_RUN_INVOICE_ROOT_ID';
  }
  const folderId = await getOrCreateFolder(drive, harukafilmId, '請求書');
  // system_settings に保存
  const { error } = await supabase
    .from('system_settings')
    .upsert({ key: 'invoice_root_folder_id', value: folderId, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.warn('[invoice-folders] system_settings upsert 失敗:', error.message);
  return folderId;
}

// --sync-roles: ルートフォルダの管理者・秘書 writer 権限を DB と同期
async function syncRolesOnRoot(drive, invoiceRootId, staffEmails) {
  console.log(`[invoice-folders] --sync-roles 開始 root=${invoiceRootId}`);
  if (DRY_RUN) {
    console.log(`[dry-run] sync staff writers: [${[...staffEmails].join(', ')}]`);
    return;
  }
  // 既存 permissions を list
  const list = await drive.permissions.list({
    fileId: invoiceRootId,
    fields: 'permissions(id,emailAddress,role,type)',
    supportsAllDrives: true,
  });
  const perms = list.data.permissions || [];

  const wanted = new Set([...staffEmails].map(e => e.toLowerCase()));
  const found  = new Set();
  // 剥奪: type=user & role=writer なのに staff にいない → 削除
  for (const p of perms) {
    if (p.role === 'owner') continue;
    if (p.type !== 'user') continue;
    const em = (p.emailAddress || '').toLowerCase();
    if (!em) continue;
    if (wanted.has(em)) { found.add(em); continue; }
    // staff 一覧に無い writer/reader は削除
    try {
      await drive.permissions.delete({
        fileId: invoiceRootId,
        permissionId: p.id,
        supportsAllDrives: true,
      });
      console.log(`[invoice-folders] revoke ${em} (${p.role}) ✓`);
    } catch (e) {
      console.warn(`[invoice-folders] revoke 失敗 ${em}: ${e.message}`);
    }
  }
  // 追加: staff にいて未付与 → 付与
  for (const em of wanted) {
    if (found.has(em)) continue;
    await ensureUserPermission(drive, invoiceRootId, em, 'writer');
    console.log(`[invoice-folders] grant ${em} (writer) ✓`);
  }
  console.log('[invoice-folders] --sync-roles 完了');
}

// --year: 年・月・メンバー個人フォルダを生成
async function generateYearFolders(drive, invoiceRootId, year, staffEmails) {
  // 全メンバー
  const members = await fetchAllActiveMembers();
  console.log(`[invoice-folders] アクティブメンバー: ${members.length} 名`);

  // 同名カウント（衝突回避用）
  const nameCount = new Map();
  for (const u of members) {
    const base = (u.full_name && u.full_name.trim())
      || (u.nickname && u.nickname.trim())
      || u.email.split('@')[0];
    nameCount.set(base, (nameCount.get(base) || 0) + 1);
  }

  // 年フォルダ
  const yearLabel = `${year}年`;
  let yearFolderId;
  if (DRY_RUN) {
    console.log(`[dry-run] ensure folder: 請求書/${yearLabel}`);
    yearFolderId = `DRY_RUN_${yearLabel}`;
  } else {
    yearFolderId = await getOrCreateFolder(drive, invoiceRootId, yearLabel);
  }
  console.log(`[invoice-folders] ${yearLabel} ✓ (${yearFolderId})`);

  for (let m = 1; m <= 12; m++) {
    const monthLabel = `${String(m).padStart(2, '0')}月`;
    let monthFolderId;
    if (DRY_RUN) {
      console.log(`[dry-run] ensure folder: 請求書/${yearLabel}/${monthLabel}`);
      monthFolderId = `DRY_RUN_${yearLabel}_${monthLabel}`;
    } else {
      monthFolderId = await getOrCreateFolder(drive, yearFolderId, monthLabel);
    }
    console.log(`[invoice-folders] ${yearLabel}/${monthLabel} ✓`);

    // 月フォルダには個別 permission 付与はしない（親「請求書」から継承）
    for (const u of members) {
      const folderName = buildMemberFolderName(u, nameCount);
      let memberFolderId;
      if (DRY_RUN) {
        console.log(`[dry-run] ensure folder: 請求書/${yearLabel}/${monthLabel}/${folderName}`);
        console.log(`[dry-run] grant ${u.email} (writer) on member folder`);
        continue;
      }
      memberFolderId = await getOrCreateFolder(drive, monthFolderId, folderName);
      await ensureUserPermission(drive, memberFolderId, u.email, 'writer');
      console.log(`[invoice-folders] ${yearLabel}/${monthLabel}/${folderName} ✓`);
    }
  }
}

// ---------- メイン ----------

async function main() {
  console.log('[invoice-folders] 開始');
  console.log(`[invoice-folders] DRY_RUN=${DRY_RUN}  YEAR=${YEAR || '-'}  SYNC_ROLES=${SYNC_ROLES}`);

  // STEP 1: HARUKAFILM ルートID取得
  const harukafilmId = await getDriveRootFolderId();
  if (!harukafilmId) {
    console.error('[invoice-folders] DRIVE root folder ID が未設定です（system_settings.drive_root_folder_id か DRIVE_ROOT_FOLDER_ID env を設定してください）');
    process.exit(1);
  }
  console.log(`[invoice-folders] HARUKAFILM root: ${harukafilmId}`);

  // STEP 2: Drive クライアント
  let drive;
  if (DRY_RUN) {
    // dry-run でも drive クライアントの呼び出しは行わないが、object として残す
    drive = null;
    console.log('[dry-run] Drive クライアントは初期化しません');
  } else {
    drive = await getDriveService();
  }

  // STEP 3: 管理者・秘書一覧
  const staff = await fetchStaffMembers();
  const staffEmails = new Set(staff.map(s => s.email));
  console.log(`[invoice-folders] 管理者・秘書: ${staff.length} 名`);

  // STEP 4: 「請求書」ルートフォルダ
  const invoiceRootId = await ensureInvoiceRootFolder(drive, harukafilmId);
  console.log(`[invoice-folders] 請求書 root: ${invoiceRootId}`);

  // ルートに staff の writer 権限を idempotent に付与（初回および新規 staff 取り込み）
  for (const em of staffEmails) {
    await ensureUserPermission(drive, invoiceRootId, em, 'writer');
  }

  // STEP 5/6
  if (SYNC_ROLES) {
    await syncRolesOnRoot(drive, invoiceRootId, staffEmails);
  } else if (YEAR) {
    await generateYearFolders(drive, invoiceRootId, YEAR, staffEmails);
  }

  console.log('[invoice-folders] 完了');
}

main().catch(e => {
  console.error('[invoice-folders] 予期せぬエラー:', e.stack || e.message);
  process.exit(1);
});

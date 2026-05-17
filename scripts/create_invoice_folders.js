#!/usr/bin/env node
// scripts/create_invoice_folders.js
//
// 役割:
//   Google Workspace の HARUKAFILM フォルダ配下に
//     HARUKAFILM/請求書/{年}/{月}/{メンバー氏名}/
//   の階層を一括生成する。
//
//   権限ポリシー（PR #XXX 以降。秘書同士の相互閲覧を不可にした版）:
//     - 「請求書」ルート: **admin のみ** writer（秘書は剥奪）
//     - 各メンバー個人フォルダ:
//         target が secretary       → admin + 本人のみ writer
//         target が secretary 以外  → admin + secretary 全員 + 本人 writer
//   こうすることで「秘書の請求書は他の秘書から見えない」「一般メンバーの請求書は
//   秘書全員が代理対応できる」状態を実現する。
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
const { getDriveService, getOrCreateFolder, getDriveRootFolderId, buildMemberFolderName } = require('../routes/haruka');

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

// 指定した legacy role コード（'admin' 等）に属するユーザーを user_roles + users.role dual-read で取得
async function fetchUsersByRoles(roleCodes) {
  if (!Array.isArray(roleCodes) || roleCodes.length === 0) return [];
  // 1. roles マスタから対象 role の id を引く
  const { data: rolesRows, error: rolesErr } = await supabase
    .from('roles').select('id, code').in('code', roleCodes);
  if (rolesErr) throw new Error(`roles 取得失敗: ${rolesErr.message}`);
  const ids = (rolesRows || []).map(r => r.id);

  const userIdSet = new Set();
  // 2. user_roles
  if (ids.length > 0) {
    const { data: urRows, error: urErr } = await supabase
      .from('user_roles').select('user_id').in('role_id', ids);
    if (urErr) throw new Error(`user_roles 取得失敗: ${urErr.message}`);
    (urRows || []).forEach(r => userIdSet.add(r.user_id));
  }
  // 3. legacy users.role fallback
  const { data: legacy, error: legacyErr } = await supabase
    .from('users').select('id').in('role', roleCodes);
  if (legacyErr) throw new Error(`users(legacy role) 取得失敗: ${legacyErr.message}`);
  (legacy || []).forEach(u => userIdSet.add(u.id));

  if (userIdSet.size === 0) return [];

  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active')
    .in('id', Array.from(userIdSet));
  if (usersErr) throw new Error(`users 取得失敗: ${usersErr.message}`);
  return (users || [])
    .filter(u => u.is_active !== false && u.email)
    .map(u => ({ id: u.id, email: u.email.trim().toLowerCase(), full_name: u.full_name, nickname: u.nickname }));
}

// 管理者のメール一覧（ルートフォルダ writer 用）
async function fetchAdminMembers() {
  return fetchUsersByRoles(['admin']);
}
// 秘書のメール一覧（一般メンバーのフォルダ writer 用）
async function fetchSecretaryMembers() {
  return fetchUsersByRoles(['secretary']);
}
// 互換: 既存呼び出し箇所向け（admin のみ返すように変更）
async function fetchStaffMembers() {
  return fetchAdminMembers();
}

// アクティブな全メンバーを取得（個人フォルダ生成対象）
// role_codes も dual-read で付与する（target が secretary か判定するため）。
async function fetchAllActiveMembers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active, role')
    .eq('is_active', true);
  if (error) throw new Error(`users 取得失敗: ${error.message}`);
  const members = (data || [])
    .filter(u => u.email)
    .map(u => ({
      id: u.id,
      email: u.email.trim().toLowerCase(),
      full_name: u.full_name,
      nickname: u.nickname,
      legacy_role: u.role || null,
      role_codes: [],
    }));
  // user_roles 経由で role_codes を埋める
  if (members.length > 0) {
    const { data: urRows, error: urErr } = await supabase
      .from('user_roles').select('user_id, roles(code)').in('user_id', members.map(m => m.id));
    if (!urErr) {
      const byUser = new Map();
      (urRows || []).forEach(r => {
        const code = r.roles && r.roles.code;
        if (!code) return;
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set());
        byUser.get(r.user_id).add(code);
      });
      members.forEach(m => {
        const set = byUser.get(m.id);
        if (set && set.size > 0) {
          m.role_codes = Array.from(set);
        } else if (m.legacy_role) {
          // dual-read fallback
          if (m.legacy_role === 'producer_director') m.role_codes = ['producer', 'director'];
          else m.role_codes = [m.legacy_role];
        }
      });
    }
  }
  return members;
}

// 同名衝突を回避したベースのメンバー名を返す（年月は付かない）
function buildBaseMemberName(u, nameCount) {
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

// --sync-roles: ルートフォルダの **admin のみ** writer 権限を DB と同期
// PR #XXX 以降は secretary は root 権限を持たない（個人フォルダ単位で付与する）。
async function syncRolesOnRoot(drive, invoiceRootId, adminEmails) {
  console.log(`[invoice-folders] --sync-roles 開始 root=${invoiceRootId} (admin のみ writer)`);
  if (DRY_RUN) {
    console.log(`[dry-run] sync admin writers: [${[...adminEmails].join(', ')}]`);
    return;
  }
  // 既存 permissions を list
  const list = await drive.permissions.list({
    fileId: invoiceRootId,
    fields: 'permissions(id,emailAddress,role,type)',
    supportsAllDrives: true,
  });
  const perms = list.data.permissions || [];

  const wanted = new Set([...adminEmails].map(e => e.toLowerCase()));
  const found  = new Set();
  // 剥奪: type=user & role=writer/reader なのに admin にいない → 削除（owner は触らない）
  for (const p of perms) {
    if (p.role === 'owner') continue;
    if (p.type !== 'user') continue;
    const em = (p.emailAddress || '').toLowerCase();
    if (!em) continue;
    if (wanted.has(em)) { found.add(em); continue; }
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
  // 追加: admin にいて未付与 → 付与
  for (const em of wanted) {
    if (found.has(em)) continue;
    await ensureUserPermission(drive, invoiceRootId, em, 'writer');
    console.log(`[invoice-folders] grant ${em} (writer) ✓`);
  }
  console.log('[invoice-folders] --sync-roles 完了');
}

// --year: 年・月・メンバー個人フォルダを生成
//   各個人フォルダには admin 全員 + 本人 を必ず付与する。
//   target が secretary でなければ secretary 全員も付与（秘書代理対応のため）。
async function generateYearFolders(drive, invoiceRootId, year, adminEmails) {
  // 全メンバー（role_codes 付き）
  const members = await fetchAllActiveMembers();
  console.log(`[invoice-folders] アクティブメンバー: ${members.length} 名`);

  // 秘書一覧（一般メンバーのフォルダに付与する writer 群）
  const secretaries = await fetchSecretaryMembers();
  const secretaryEmails = new Set(secretaries.map(s => s.email));
  console.log(`[invoice-folders] 秘書: ${secretaries.length} 名`);

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
      const baseName = buildBaseMemberName(u, nameCount);
      const folderName = buildMemberFolderName(baseName, year, m);
      let memberFolderId;
      const targetIsSecretaryDry = (u.role_codes || []).includes('secretary');
      if (DRY_RUN) {
        console.log(`[dry-run] ensure folder: 請求書/${yearLabel}/${monthLabel}/${folderName}`);
        console.log(`[dry-run] grant ${u.email} (writer) on member folder`);
        for (const em of adminEmails) console.log(`[dry-run] grant ${em} (admin, writer)`);
        if (!targetIsSecretaryDry) {
          for (const em of secretaryEmails) console.log(`[dry-run] grant ${em} (secretary, writer)`);
        } else {
          console.log(`[dry-run] target=${u.email} は secretary のため secretary 群は付与しない`);
        }
        continue;
      }
      memberFolderId = await getOrCreateFolder(drive, monthFolderId, folderName);
      // 1) 本人
      await ensureUserPermission(drive, memberFolderId, u.email, 'writer');
      // 2) 管理者全員（ルート権限を秘書から剥奪したため、admin も明示付与）
      for (const em of adminEmails) {
        if (em === u.email) continue;
        await ensureUserPermission(drive, memberFolderId, em, 'writer');
      }
      // 3) target が secretary でなければ secretary 全員にも付与
      const targetIsSecretary = (u.role_codes || []).includes('secretary');
      if (!targetIsSecretary) {
        for (const em of secretaryEmails) {
          if (em === u.email) continue;
          await ensureUserPermission(drive, memberFolderId, em, 'writer');
        }
      }
      console.log(`[invoice-folders] ${yearLabel}/${monthLabel}/${folderName} ✓ (target_secretary=${targetIsSecretary})`);
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

  // STEP 3: 管理者一覧（ルート writer 用）
  const admins = await fetchAdminMembers();
  const adminEmails = new Set(admins.map(s => s.email));
  console.log(`[invoice-folders] 管理者: ${admins.length} 名`);

  // STEP 4: 「請求書」ルートフォルダ
  const invoiceRootId = await ensureInvoiceRootFolder(drive, harukafilmId);
  console.log(`[invoice-folders] 請求書 root: ${invoiceRootId}`);

  // ルートに admin の writer 権限を idempotent に付与（secretary はルートに権限を持たない）
  for (const em of adminEmails) {
    await ensureUserPermission(drive, invoiceRootId, em, 'writer');
  }

  // STEP 5/6
  if (SYNC_ROLES) {
    await syncRolesOnRoot(drive, invoiceRootId, adminEmails);
  } else if (YEAR) {
    await generateYearFolders(drive, invoiceRootId, YEAR, adminEmails);
  }

  console.log('[invoice-folders] 完了');
}

main().catch(e => {
  console.error('[invoice-folders] 予期せぬエラー:', e.stack || e.message);
  process.exit(1);
});

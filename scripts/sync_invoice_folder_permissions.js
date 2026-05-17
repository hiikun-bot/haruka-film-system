#!/usr/bin/env node
// scripts/sync_invoice_folder_permissions.js
//
// 一回限りの再同期スクリプト。
// PR #XXX で「秘書同士の請求書フォルダ相互閲覧を不可」にした。
// 既存フォルダの Drive 権限は旧ルール（admin + secretary 全員が root から継承）の
// ままなので、本スクリプトで以下を実行する:
//
//   1. 「請求書」ルートから **secretary を全員剥奪**（admin は維持）
//   2. 各 member_invoice_folders レコードの Drive 権限を再構築:
//        - target が secretary       → admin + 本人のみ、他 secretary を剥奪
//        - target が secretary 以外  → admin + secretary 全員 + 本人、不足を追加
//      owner は絶対に剥奪しない。
//
// オプション:
//   --dry-run        実際の rename/permission 変更を行わずログのみ
//   --limit=N        先頭 N レコードのみ処理
//
// 環境変数:
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// 冪等性: 何度叩いても安全（既に正しい状態ならログのみ）。

require('dotenv').config();
const supabase = require('../supabase');
const { getDriveService, getInvoiceFolderExtraAdminEmails } = require('../routes/haruka');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

function log(...a) { console.log('[sync-invoice-perms]', ...a); }
function warn(...a) { console.warn('[sync-invoice-perms]', ...a); }

// -------- ロール解決 --------

// dual-read: user_roles 優先、空なら users.role を 1 要素として扱う
async function getRoleCodesByUserIds(userIds) {
  const out = new Map(); // user_id -> Set<code>
  if (!userIds || userIds.length === 0) return out;
  const ids = Array.from(new Set(userIds));
  // 1. user_roles
  const { data: urRows } = await supabase
    .from('user_roles').select('user_id, roles(code)').in('user_id', ids);
  (urRows || []).forEach(r => {
    const code = r.roles && r.roles.code;
    if (!code) return;
    if (!out.has(r.user_id)) out.set(r.user_id, new Set());
    out.get(r.user_id).add(code);
  });
  // 2. dual-read fallback for users without any user_roles row
  const { data: usersRows } = await supabase
    .from('users').select('id, role').in('id', ids);
  (usersRows || []).forEach(u => {
    if (!out.has(u.id) || out.get(u.id).size === 0) {
      const set = new Set();
      if (u.role === 'producer_director') { set.add('producer'); set.add('director'); }
      else if (u.role) set.add(u.role);
      if (set.size > 0) out.set(u.id, set);
    }
  });
  return out;
}

async function fetchUsersByRoles(roleCodes) {
  // 1. roles マスタ
  const { data: rolesRows } = await supabase
    .from('roles').select('id, code').in('code', roleCodes);
  const ids = (rolesRows || []).map(r => r.id);
  const userIdSet = new Set();
  if (ids.length > 0) {
    const { data: urRows } = await supabase
      .from('user_roles').select('user_id').in('role_id', ids);
    (urRows || []).forEach(r => userIdSet.add(r.user_id));
  }
  // legacy dual-read
  const { data: legacy } = await supabase
    .from('users').select('id').in('role', roleCodes);
  (legacy || []).forEach(u => userIdSet.add(u.id));
  if (userIdSet.size === 0) return [];
  const { data: users } = await supabase
    .from('users').select('id, email, is_active').in('id', Array.from(userIdSet));
  return (users || [])
    .filter(u => u.is_active !== false && u.email)
    .map(u => ({ id: u.id, email: u.email.trim().toLowerCase() }));
}

// -------- Drive 権限ヘルパー --------

async function listPermissions(drive, fileId) {
  const res = await drive.permissions.list({
    fileId,
    fields: 'permissions(id,emailAddress,role,type)',
    supportsAllDrives: true,
  });
  return res.data.permissions || [];
}

// Drive permission role 序数
function rolePriority(role) {
  switch (role) {
    case 'owner':         return 100;
    case 'organizer':     return 50;
    case 'fileOrganizer': return 40;
    case 'writer':        return 30;
    case 'commenter':     return 20;
    case 'reader':        return 10;
    default:              return 0;
  }
}

async function grantWriter(drive, fileId, email) {
  if (DRY_RUN) { log(`  [dry-run] + grant ${email} (writer) on ${fileId}`); return true; }
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'writer', type: 'user', emailAddress: email },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
    log(`  + grant ${email} (writer) on ${fileId}`);
    return true;
  } catch (e) {
    const status = e?.code || e?.response?.status;
    if (status === 400 || status === 403 || status === 409) {
      warn(`  grant warn (${status}) ${email} on ${fileId}: ${e.message}`);
      return false;
    }
    throw e;
  }
}

// 既存 permission の role を考慮して fileOrganizer（フォールバック writer）を idempotent に付与。
// すでに同等以上の role があれば skip。
async function grantFileOrganizerWithFallback(drive, fileId, email, existingPerms) {
  const target = email.toLowerCase();
  const existing = (existingPerms || []).find(p => (p.emailAddress || '').toLowerCase() === target && p.type === 'user');
  const wantedRank = rolePriority('fileOrganizer');
  if (existing) {
    const existingRank = rolePriority(existing.role);
    if (existing.role === 'owner' || existingRank >= wantedRank) {
      // 既に同等以上なので skip
      return { changed: false };
    }
    // 昇格 update（fileOrganizer 失敗時は writer フォールバック）
    if (DRY_RUN) { log(`  [dry-run] ~ upgrade ${email} ${existing.role} → fileOrganizer on ${fileId}`); return { changed: true }; }
    try {
      await drive.permissions.update({
        fileId, permissionId: existing.id,
        requestBody: { role: 'fileOrganizer' },
        supportsAllDrives: true,
      });
      log(`  ~ upgrade ${email} ${existing.role} → fileOrganizer on ${fileId}`);
      return { changed: true };
    } catch (e) {
      const msg = e?.message || '';
      if (msg.includes('shared drive') || msg.includes('not supported') || msg.includes('teamDriveFileOnly')) {
        if (rolePriority(existing.role) >= rolePriority('writer')) return { changed: false };
        try {
          await drive.permissions.update({
            fileId, permissionId: existing.id,
            requestBody: { role: 'writer' },
            supportsAllDrives: true,
          });
          log(`  ~ upgrade ${email} ${existing.role} → writer (fallback) on ${fileId}`);
          return { changed: true };
        } catch (e2) {
          warn(`  fallback writer upgrade 失敗 ${email}: ${e2.message}`);
          return { changed: false };
        }
      }
      warn(`  fileOrganizer upgrade 失敗 ${email}: ${e.message}`);
      return { changed: false };
    }
  }
  // 新規付与
  if (DRY_RUN) { log(`  [dry-run] + grant ${email} (fileOrganizer/writer fallback) on ${fileId}`); return { changed: true }; }
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'fileOrganizer', type: 'user', emailAddress: email },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
    log(`  + grant ${email} (fileOrganizer) on ${fileId}`);
    return { changed: true };
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('shared drive') || msg.includes('not supported') || msg.includes('teamDriveFileOnly')) {
      try {
        await drive.permissions.create({
          fileId,
          requestBody: { role: 'writer', type: 'user', emailAddress: email },
          sendNotificationEmail: false,
          supportsAllDrives: true,
        });
        log(`  + grant ${email} (writer, fileOrganizer fallback) on ${fileId}`);
        return { changed: true };
      } catch (e2) {
        warn(`  writer fallback 失敗 ${email}: ${e2.message}`);
        return { changed: false };
      }
    }
    const status = e?.code || e?.response?.status;
    if (status === 400 || status === 403 || status === 409) {
      warn(`  fileOrganizer grant warn (${status}) ${email} on ${fileId}: ${e.message}`);
      return { changed: false };
    }
    throw e;
  }
}

async function revokePermission(drive, fileId, permissionId, email, role) {
  if (DRY_RUN) { log(`  [dry-run] - revoke ${email} (${role}) on ${fileId}`); return true; }
  try {
    await drive.permissions.delete({
      fileId,
      permissionId,
      supportsAllDrives: true,
    });
    log(`  - revoke ${email} (${role}) on ${fileId}`);
    return true;
  } catch (e) {
    warn(`  revoke 失敗 ${email}: ${e.message}`);
    return false;
  }
}

// -------- メイン --------

async function syncRoot(drive, adminEmails, extraAdminEmails) {
  // 「請求書」ルートフォルダ ID を system_settings から取得
  const { data: setting } = await supabase
    .from('system_settings').select('value').eq('key', 'invoice_root_folder_id').maybeSingle();
  if (!setting || !setting.value) {
    warn('system_settings に invoice_root_folder_id が見つかりません。root の同期はスキップ。');
    return { revoked: 0, granted: 0, extraGranted: 0 };
  }
  const rootId = setting.value;
  log(`root sync: invoice_root_folder_id=${rootId}`);

  const perms = await listPermissions(drive, rootId);
  let revoked = 0, granted = 0, extraGranted = 0;
  const wantedAdmins = new Set([...adminEmails].map(e => e.toLowerCase()));
  const wantedExtras = new Set([...(extraAdminEmails || [])].map(e => e.toLowerCase()));
  const wantedAll = new Set([...wantedAdmins, ...wantedExtras]);
  const foundAdmin = new Set();

  for (const p of perms) {
    if (p.role === 'owner') continue;
    if (p.type !== 'user') continue;
    const em = (p.emailAddress || '').toLowerCase();
    if (!em) continue;
    if (wantedAll.has(em)) {
      if (wantedAdmins.has(em)) foundAdmin.add(em);
      continue;
    }
    // wanted（admin + extra admin）に無い user 権限は剥奪（=secretary だった人や離脱者）
    const ok = await revokePermission(drive, rootId, p.id, em, p.role);
    if (ok) revoked++;
  }
  for (const em of wantedAdmins) {
    if (foundAdmin.has(em)) continue;
    const ok = await grantWriter(drive, rootId, em);
    if (ok) granted++;
  }
  // extra admins は fileOrganizer（拒否時 writer）を idempotent に付与
  for (const em of wantedExtras) {
    const r = await grantFileOrganizerWithFallback(drive, rootId, em, perms);
    if (r.changed) extraGranted++;
  }
  return { revoked, granted, extraGranted };
}

async function syncMemberFolder(drive, folder, target, adminEmails, secretaryEmails, extraAdminEmails) {
  const fileId = folder.folder_id;
  if (!fileId) return { added: 0, removed: 0 };
  const targetEmail = (target?.email || '').toLowerCase();
  const targetIsSecretary = (target?.role_codes || new Set()).has('secretary');

  // 期待される writer メール集合
  const wanted = new Set();
  if (targetEmail) wanted.add(targetEmail);
  for (const em of adminEmails) wanted.add(em);
  if (!targetIsSecretary) {
    for (const em of secretaryEmails) wanted.add(em);
  }
  // 個人フォルダには extra admin を**重複付与しない**（ルートから階層継承）。
  // ただし既に extra admin に明示権限がある場合は剥奪しない（ルート権限が消えても見える状態を維持）。
  const protectedExtras = new Set([...(extraAdminEmails || [])].map(e => e.toLowerCase()));

  let perms;
  try {
    perms = await listPermissions(drive, fileId);
  } catch (e) {
    warn(`  permissions.list 失敗 file=${fileId}: ${e.message}`);
    return { added: 0, removed: 0, error: true };
  }
  const found = new Set();
  let removed = 0, added = 0;

  for (const p of perms) {
    if (p.role === 'owner') continue;
    if (p.type !== 'user') continue;
    const em = (p.emailAddress || '').toLowerCase();
    if (!em) continue;
    if (wanted.has(em)) { found.add(em); continue; }
    // 追加管理者は剥奪しない（ルート権限の継承を担保するため、既存があるなら維持）
    if (protectedExtras.has(em)) continue;
    const ok = await revokePermission(drive, fileId, p.id, em, p.role);
    if (ok) removed++;
  }
  for (const em of wanted) {
    if (found.has(em)) continue;
    const ok = await grantWriter(drive, fileId, em);
    if (ok) added++;
  }
  return { added, removed };
}

async function main() {
  log(`開始 DRY_RUN=${DRY_RUN}${LIMIT ? ` LIMIT=${LIMIT}` : ''}`);

  // 1. 管理者・秘書・追加管理者一覧
  const admins = await fetchUsersByRoles(['admin']);
  const secretaries = await fetchUsersByRoles(['secretary']);
  const adminEmails = new Set(admins.map(a => a.email));
  const secretaryEmails = new Set(secretaries.map(s => s.email));
  let extraAdminEmails = [];
  try {
    extraAdminEmails = await getInvoiceFolderExtraAdminEmails();
  } catch (e) {
    warn(`extra admin 取得失敗: ${e.message}`);
  }
  log(`管理者: ${admins.length} 名 / 秘書: ${secretaries.length} 名 / 追加管理者: ${extraAdminEmails.length} 名${extraAdminEmails.length ? ` (${extraAdminEmails.join(', ')})` : ''}`);

  // 2. Drive
  const drive = await getDriveService();

  // 3. ルートを admin + extra admin に同期（extra admin は fileOrganizer/writer）
  const rootRes = await syncRoot(drive, adminEmails, extraAdminEmails);
  log(`root: revoke=${rootRes.revoked}, grant=${rootRes.granted}, extraGrant=${rootRes.extraGranted}`);

  // 4. member_invoice_folders を全件取得（folder_id がある行のみ）
  let q = supabase
    .from('member_invoice_folders')
    .select('id, user_id, year, month, folder_id')
    .not('folder_id', 'is', null)
    .order('user_id, year, month');
  if (LIMIT) q = q.limit(LIMIT);
  const { data: folders, error: fErr } = await q;
  if (fErr) {
    console.error('member_invoice_folders 取得失敗:', fErr.message);
    process.exit(1);
  }
  log(`対象フォルダ: ${folders.length} 件`);

  // user 情報 / role_codes を一括取得
  const userIds = Array.from(new Set(folders.map(f => f.user_id)));
  const { data: users } = await supabase
    .from('users').select('id, email').in('id', userIds);
  const userById = new Map((users || []).map(u => [u.id, u]));
  const codesByUser = await getRoleCodesByUserIds(userIds);

  // 並列度 5 で処理
  let processed = 0, added = 0, removed = 0, targetSecretaryCount = 0, errors = 0;
  const concurrency = 5;
  let i = 0;
  async function worker() {
    while (i < folders.length) {
      const idx = i++;
      const folder = folders[idx];
      const u = userById.get(folder.user_id) || null;
      const codes = codesByUser.get(folder.user_id) || new Set();
      const target = u ? { id: u.id, email: u.email, role_codes: codes } : null;
      if (codes.has('secretary')) targetSecretaryCount++;
      log(`[${idx + 1}/${folders.length}] user=${u?.email || folder.user_id} ${folder.year}/${folder.month} file=${folder.folder_id} target_secretary=${codes.has('secretary')}`);
      try {
        const r = await syncMemberFolder(drive, folder, target, adminEmails, secretaryEmails, extraAdminEmails);
        added += r.added; removed += r.removed;
        if (r.error) errors++;
      } catch (e) {
        warn(`  予期せぬエラー: ${e.message}`);
        errors++;
      }
      processed++;
    }
  }
  await Promise.all(Array(concurrency).fill(0).map(() => worker()));

  log('========== サマリ ==========');
  log(`root: revoked=${rootRes.revoked} / granted=${rootRes.granted} / extraGranted=${rootRes.extraGranted}`);
  log(`folders processed: ${processed}`);
  log(`  - target secretary folders: ${targetSecretaryCount}`);
  log(`  - grants added:   ${added}`);
  log(`  - perms removed:  ${removed}`);
  log(`  - errors:         ${errors}`);
  log('完了');
}

main().catch(e => {
  console.error('[sync-invoice-perms] 致命的エラー:', e.stack || e.message);
  process.exit(1);
});

#!/usr/bin/env node
// scripts/migrate_invoice_folders_to_new_drive.js
//
// 役割:
//   現在の「請求書」ルート配下の  {年}/{月}/{個人} フォルダ階層と既存ファイルを、
//   新しい共有ドライブ内の新しい「請求書」フォルダ配下にコピーで再構築する。
//   member_invoice_folders.folder_id / folder_url を新IDで UPDATE し、
//   完了後に system_settings.invoice_root_folder_id を新IDに切り替える。
//
// 動機:
//   Google 共有ドライブのメンバー権限はサブフォルダ単位で剥奪不可。
//   秘書を現「ハルカフィルム」共有ドライブから外したくないので、
//   請求書だけ「ハルカフィルム-請求書」共有ドライブに分離する。
//   分離後、秘書本人のフォルダは admin + 本人 だけが見える状態になる。
//
// 前提（ユーザー手動作業）:
//   1. 新共有ドライブ「ハルカフィルム-請求書」を作成。
//      メンバー:
//        - admin の Google アカウント            → 管理者
//        - サービスアカウント
//          (haruka-film-drive@haruka-film-system.iam.gserviceaccount.com)
//                                                  → コンテンツ管理者
//      ⚠️ 秘書ロールのアカウントは追加しない（権限分離の主目的）
//   2. 新共有ドライブ直下に「請求書」フォルダを 1 個作成し、
//      URL ( https://drive.google.com/drive/folders/XXX ) の XXX を控える。
//
// 使い方:
//   # 1) dry-run（コピー予定の一覧 + 件数表示のみ。Drive/DB 変更なし）
//   node scripts/migrate_invoice_folders_to_new_drive.js \
//     --new-root=<新請求書フォルダID> --dry-run
//
//   # 2) 構造だけ（フォルダ階層と権限のみ。ファイルコピーは飛ばす）
//   node scripts/migrate_invoice_folders_to_new_drive.js \
//     --new-root=<新請求書フォルダID> --skip-files --force
//
//   # 3) 本実行（ファイルもコピー）
//   node scripts/migrate_invoice_folders_to_new_drive.js \
//     --new-root=<新請求書フォルダID> --force
//
//   # 4) 件数を絞ってテスト
//   node scripts/migrate_invoice_folders_to_new_drive.js \
//     --new-root=<新請求書フォルダID> --limit=3 --force
//
// オプション:
//   --new-root=<id>   新「請求書」フォルダ ID (必須)
//   --dry-run         Drive/DB 変更を一切行わずログのみ
//   --force           本実行時の安全装置解除（--dry-run なしで実行する場合に必要）
//   --skip-files      個人フォルダ配下のファイルコピーをスキップ
//                     （構造と権限のみ。後でファイルを別途移行したいケース用）
//   --limit=N         先頭 N 件のみ処理
//
// 環境変数:
//   GOOGLE_SERVICE_ACCOUNT_KEY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// 安全装置 / 冪等性:
//   - 旧フォルダ階層は一切触らない（削除は別途 scripts/delete_invoice_folders.js）
//   - 同名フォルダが新ルートに既にあれば再利用（複数回叩いても重複作成しない）
//   - member_invoice_folders は folder_id を新IDで UPDATE するため、
//     2 回目以降の実行は「reused: 既存と同IDで上書き」になる
//   - DB 更新は全ファイル処理が成功した個人フォルダ単位で行う
//
// 監査ログ:
//   完了時に invoice_folder_audit_log に 1 行 INSERT
//   command_args に move 元/先 root と件数を記録

require('dotenv').config();
const supabase = require('../supabase');
const {
  getDriveService,
  buildMemberFolderName,
  buildInvoiceMemberFolderName,
  ensureUserDrivePermission,
  ensureUserDrivePermissionWithRoleFallback,
  getInvoiceFolderExtraAdminEmails,
} = require('../routes/haruka');

const args = process.argv.slice(2);
const NEW_ROOT = (args.find(a => a.startsWith('--new-root=')) || '').split('=').slice(1).join('=');
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const SKIP_FILES = args.includes('--skip-files');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

function log(...a) { console.log('[migrate-invoice]', ...a); }
function warn(...a) { console.warn('[migrate-invoice]', ...a); }

if (!NEW_ROOT) {
  console.error('[migrate-invoice] --new-root=<新「請求書」folder ID> は必須です');
  process.exit(1);
}
if (LIMIT_ARG && (!Number.isInteger(LIMIT) || LIMIT <= 0)) {
  console.error(`[migrate-invoice] --limit=${LIMIT_ARG} が不正です`);
  process.exit(1);
}

// ---------- ロール解決（dual-read） ----------

async function fetchUsersByRoleCode(roleCode) {
  const userIds = new Set();
  const { data: rolesRows } = await supabase
    .from('roles').select('id').eq('code', roleCode);
  const roleIds = (rolesRows || []).map(r => r.id);
  if (roleIds.length > 0) {
    const { data: urRows } = await supabase
      .from('user_roles').select('user_id').in('role_id', roleIds);
    (urRows || []).forEach(r => userIds.add(r.user_id));
  }
  const { data: legacy } = await supabase
    .from('users').select('id').eq('role', roleCode);
  (legacy || []).forEach(u => userIds.add(u.id));
  if (userIds.size === 0) return [];
  const { data: users } = await supabase
    .from('users').select('id, email, is_active').in('id', Array.from(userIds));
  return (users || [])
    .filter(u => u.is_active !== false && u.email)
    .map(u => ({ id: u.id, email: u.email.trim().toLowerCase() }));
}

async function getRoleCodesOf(userId) {
  const set = new Set();
  if (!userId) return set;
  const { data: urRows } = await supabase
    .from('user_roles').select('roles(code)').eq('user_id', userId);
  (urRows || []).forEach(r => { if (r.roles && r.roles.code) set.add(r.roles.code); });
  if (set.size === 0) {
    const { data } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
    const role = data && data.role;
    if (role === 'producer_director') { set.add('producer'); set.add('director'); }
    else if (role) set.add(role);
  }
  return set;
}

// ---------- Drive ヘルパー ----------

async function getOrCreateChildFolder(drive, parentId, name) {
  // dry-run で親が仮IDの場合は API を叩かず仮IDを返す（祖先が新規作成予定なら子も必ず新規）
  if (typeof parentId === 'string' && parentId.startsWith('[dry:')) {
    return { id: `[dry:${name}]`, created: true };
  }
  const safe = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return { id: res.data.files[0].id, created: false };
  if (DRY_RUN) return { id: `[dry:${name}]`, created: true };
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return { id: f.data.id, created: true };
}

async function listChildren(drive, folderId) {
  if (!folderId || folderId.startsWith('[dry:')) return [];
  const out = [];
  let pageToken = null;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken: pageToken || undefined,
      pageSize: 1000,
    });
    (r.data.files || []).forEach(f => out.push(f));
    pageToken = r.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function copyFileTo(drive, srcFileId, destParentId, name) {
  if (DRY_RUN) return { id: `[dry-copy:${name}]` };
  const r = await drive.files.copy({
    fileId: srcFileId,
    requestBody: { name, parents: [destParentId] },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return r.data;
}

// 個人フォルダ配下を再帰的にコピー
async function copyFolderRecursive(drive, srcFolderId, destFolderId, depth = 0) {
  let copied = 0, errors = 0, skipped = 0;
  const items = await listChildren(drive, srcFolderId);
  // dry-run で destFolderId が仮IDなら、件数だけカウントして即終了（API は叩かない）
  const destIsDry = typeof destFolderId === 'string' && destFolderId.startsWith('[dry:');
  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      const sub = await getOrCreateChildFolder(drive, destFolderId, item.name);
      const r = await copyFolderRecursive(drive, item.id, sub.id, depth + 1);
      copied += r.copied; errors += r.errors; skipped += r.skipped;
    } else {
      if (destIsDry) { copied++; continue; }
      try {
        // 既に同名ファイルが新フォルダに居れば skip（冪等性）
        const existing = await drive.files.list({
          q: `name='${item.name.replace(/'/g, "\\'")}' and '${destFolderId}' in parents and trashed=false`,
          fields: 'files(id)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        if ((existing.data.files || []).length > 0) {
          skipped++;
          continue;
        }
        await copyFileTo(drive, item.id, destFolderId, item.name);
        copied++;
      } catch (e) {
        errors++;
        warn(`  copy 失敗 "${item.name}": ${e.message}`);
      }
    }
  }
  return { copied, errors, skipped };
}

// ---------- メイン ----------

async function main() {
  const startedAt = Date.now();
  log(
    `開始 NEW_ROOT=${NEW_ROOT} DRY_RUN=${DRY_RUN} FORCE=${FORCE} ` +
    `SKIP_FILES=${SKIP_FILES}${LIMIT ? ` LIMIT=${LIMIT}` : ''}`
  );

  // 1. 旧「請求書」ルート ID
  const { data: setting } = await supabase
    .from('system_settings').select('value').eq('key', 'invoice_root_folder_id').maybeSingle();
  const oldRoot = setting && setting.value;
  if (!oldRoot) {
    console.error('[migrate-invoice] system_settings.invoice_root_folder_id が未設定');
    process.exit(1);
  }
  if (oldRoot === NEW_ROOT) {
    console.error('[migrate-invoice] --new-root が現状の invoice_root_folder_id と同じです');
    process.exit(1);
  }
  log(`旧ルート: ${oldRoot}`);
  log(`新ルート: ${NEW_ROOT}`);

  // 2. drive 接続 + 新ルート確認
  const drive = await getDriveService();
  let newRootMeta;
  try {
    const meta = await drive.files.get({
      fileId: NEW_ROOT,
      fields: 'id,name,driveId,mimeType,parents',
      supportsAllDrives: true,
    });
    newRootMeta = meta.data;
    log(
      `新ルート確認 OK: name="${meta.data.name}" ` +
      `driveId=${meta.data.driveId || '(My Drive)'} mimeType=${meta.data.mimeType}`
    );
    if (meta.data.mimeType !== 'application/vnd.google-apps.folder') {
      console.error('[migrate-invoice] --new-root はフォルダではありません');
      process.exit(1);
    }
    if (!meta.data.driveId) {
      warn('⚠️  --new-root が共有ドライブ配下ではありません。本対策の目的を満たさない可能性があります');
    }
  } catch (e) {
    console.error(`[migrate-invoice] --new-root が取得できません: ${e.message}`);
    console.error('       サービスアカウント (haruka-film-drive@...) を新共有ドライブのメンバーに追加してください');
    process.exit(1);
  }

  // 3. 対象 member_invoice_folders 取得
  let q = supabase
    .from('member_invoice_folders')
    .select('id, user_id, year, month, folder_id, folder_url')
    .not('folder_id', 'is', null)
    .order('year', { ascending: true })
    .order('month', { ascending: true });
  if (LIMIT) q = q.limit(LIMIT);
  const { data: rows, error: rErr } = await q;
  if (rErr) { console.error(`[migrate-invoice] DB 取得失敗: ${rErr.message}`); process.exit(1); }
  log(`移行対象 member_invoice_folders: ${rows.length} 件`);
  if (rows.length === 0) {
    log('対象 0 件のため終了');
    return;
  }

  // 4. 安全装置
  if (!DRY_RUN && !FORCE) {
    console.error(
      '[migrate-invoice] 安全装置: 本実行には --force を付けてください。\n' +
      '       まず --dry-run で内容を確認してください。'
    );
    process.exit(1);
  }

  // 5. ユーザー情報
  const userIds = Array.from(new Set(rows.map(r => r.user_id)));
  const { data: users } = await supabase
    .from('users').select('id, email, full_name, nickname, is_active').in('id', userIds);
  const userById = new Map((users || []).map(u => [u.id, u]));

  // 6. admin/secretary 群 + 追加管理者
  const admins = await fetchUsersByRoleCode('admin');
  const secretaries = await fetchUsersByRoleCode('secretary');
  const adminEmails = admins.map(a => a.email);
  const secretaryEmails = secretaries.map(s => s.email);
  let extraAdminEmails = [];
  try { extraAdminEmails = await getInvoiceFolderExtraAdminEmails(); } catch (_) {}
  log(`admin=${adminEmails.length}名 secretary=${secretaryEmails.length}名 extraAdmin=${extraAdminEmails.length}名`);

  // 7. 年/月フォルダの新ルート配下キャッシュ
  const yearCache = new Map();
  const monthCache = new Map();
  async function ensureYear(year) {
    if (yearCache.has(year)) return yearCache.get(year);
    const y = await getOrCreateChildFolder(drive, NEW_ROOT, `${year}年`);
    yearCache.set(year, y.id);
    log(`  year ${year}年 ${y.created ? 'created' : 'reused'}: ${y.id}`);
    return y.id;
  }
  async function ensureMonth(year, month) {
    const key = `${year}/${month}`;
    if (monthCache.has(key)) return monthCache.get(key);
    const yearId = await ensureYear(year);
    const m = await getOrCreateChildFolder(drive, yearId, `${String(month).padStart(2, '0')}月`);
    monthCache.set(key, m.id);
    log(`  month ${year}/${String(month).padStart(2, '0')} ${m.created ? 'created' : 'reused'}: ${m.id}`);
    return m.id;
  }

  // 8. 移行ループ
  let migrated = 0, filesCopied = 0, filesSkipped = 0, filesErr = 0;
  let dbUpdated = 0, fatalErr = 0;
  const dbUpdates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const u = userById.get(row.user_id);
    const userLabel = u ? `${u.email}` : row.user_id;
    const tag = `[${i + 1}/${rows.length}] ${userLabel} ${row.year}/${row.month}`;

    try {
      const monthId = await ensureMonth(row.year, row.month);

      // 個人フォルダ名: 旧フォルダの実名を優先（リネーム不整合の救済）
      let personalName = null;
      try {
        const meta = await drive.files.get({
          fileId: row.folder_id,
          fields: 'name, trashed',
          supportsAllDrives: true,
        });
        if (meta.data && meta.data.name) personalName = meta.data.name;
      } catch (e) {
        warn(`${tag} 旧フォルダ取得失敗 (${row.folder_id}): ${e.message} — DB側情報で続行`);
      }
      if (!personalName) {
        // フォールバック: users 情報から再構築
        if (u) {
          const base = buildInvoiceMemberFolderName(u);
          personalName = buildMemberFolderName(base, row.year, row.month);
        } else {
          personalName = `unknown ${row.year}年${String(row.month).padStart(2, '0')}月`;
        }
      }

      const personal = await getOrCreateChildFolder(drive, monthId, personalName);
      log(`${tag} personal "${personalName}" ${personal.created ? 'created' : 'reused'}: ${personal.id}`);

      // 9. ファイルコピー
      if (!SKIP_FILES) {
        const r = await copyFolderRecursive(drive, row.folder_id, personal.id);
        filesCopied += r.copied; filesSkipped += r.skipped; filesErr += r.errors;
        if (r.copied || r.skipped || r.errors) {
          log(`${tag} files copied=${r.copied} skipped=${r.skipped} errors=${r.errors}`);
        }
      }

      // 10. 権限付与
      const targetCodes = await getRoleCodesOf(row.user_id);
      const targetIsSecretary = targetCodes.has('secretary');
      const targetEmail = u && u.email ? u.email.trim().toLowerCase() : null;

      const wanted = new Set();
      if (targetEmail) wanted.add(targetEmail);
      adminEmails.forEach(em => wanted.add(em));
      if (!targetIsSecretary) secretaryEmails.forEach(em => wanted.add(em));

      if (!DRY_RUN) {
        for (const em of wanted) {
          try { await ensureUserDrivePermission(drive, personal.id, em, 'writer'); }
          catch (e) { warn(`  grant warn ${em}: ${e.message}`); }
        }
        for (const em of extraAdminEmails) {
          try { await ensureUserDrivePermissionWithRoleFallback(drive, personal.id, em, 'fileOrganizer'); }
          catch (e) { warn(`  extra-admin grant warn ${em}: ${e.message}`); }
        }
      } else {
        log(`${tag} [dry-run] would grant: ${Array.from(wanted).join(', ')}${extraAdminEmails.length ? ` + extra ${extraAdminEmails.join(',')}` : ''}`);
      }

      dbUpdates.push({
        id: row.id,
        old_folder_id: row.folder_id,
        new_folder_id: personal.id,
        new_folder_url: `https://drive.google.com/drive/folders/${personal.id}`,
      });
      migrated++;
    } catch (e) {
      fatalErr++;
      warn(`${tag} 失敗: ${e.message}`);
    }
  }

  // 11. DB 更新
  if (!DRY_RUN) {
    for (const u of dbUpdates) {
      const { error: upErr } = await supabase
        .from('member_invoice_folders')
        .update({ folder_id: u.new_folder_id, folder_url: u.new_folder_url })
        .eq('id', u.id);
      if (upErr) {
        warn(`  DB update 失敗 id=${u.id}: ${upErr.message}`);
        fatalErr++;
      } else {
        dbUpdated++;
      }
    }
  } else {
    log('--dry-run 中なので DB 更新はスキップ。予定:');
    dbUpdates.slice(0, 5).forEach(u =>
      log(`  UPDATE id=${u.id} folder_id ${u.old_folder_id} -> ${u.new_folder_id}`)
    );
    if (dbUpdates.length > 5) log(`  ... (他 ${dbUpdates.length - 5} 件)`);
  }

  // 12. system_settings 切替
  if (!DRY_RUN && fatalErr === 0) {
    const { error: ssErr } = await supabase
      .from('system_settings')
      .upsert(
        { key: 'invoice_root_folder_id', value: NEW_ROOT, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (ssErr) warn(`system_settings 更新失敗: ${ssErr.message}`);
    else log(`system_settings.invoice_root_folder_id を切替: ${oldRoot} -> ${NEW_ROOT}`);
  } else if (DRY_RUN) {
    log(`--dry-run: system_settings.invoice_root_folder_id を ${oldRoot} -> ${NEW_ROOT} に切替予定`);
  } else {
    warn(`fatalErr=${fatalErr} のため system_settings は切替しません。失敗を解消してから再実行してください`);
  }

  const duration_ms = Date.now() - startedAt;

  // 13. 監査ログ
  if (!DRY_RUN) {
    const status = fatalErr > 0 ? 'partial' : 'success';
    const { error: auditErr } = await supabase.from('invoice_folder_audit_log').insert({
      approved_by_user_id: null,
      command_args: {
        script: 'migrate_invoice_folders_to_new_drive',
        old_root: oldRoot,
        new_root: NEW_ROOT,
        new_root_drive_id: (newRootMeta && newRootMeta.driveId) || null,
        skip_files: SKIP_FILES,
        limit: LIMIT,
      },
      folders_created_count: migrated,
      folders_skipped_count: 0,
      permissions_granted_count: 0,
      permissions_revoked_count: 0,
      duration_ms,
      status,
      error_message: fatalErr > 0 ? `${fatalErr} fatal errors` : null,
    });
    if (auditErr) warn(`audit_log insert 失敗: ${auditErr.message}`);
  }

  // 14. サマリ
  log('========== サマリ ==========');
  log(`DRY_RUN:                ${DRY_RUN}`);
  log(`migrated personal folders: ${migrated}/${rows.length}`);
  log(`  files copied:           ${filesCopied}`);
  log(`  files skipped(同名既存): ${filesSkipped}`);
  log(`  files errors:           ${filesErr}`);
  log(`db rows updated:          ${dbUpdated}`);
  log(`fatal errors:             ${fatalErr}`);
  log(`duration:                 ${duration_ms}ms`);
  log('---- 後処理 ----');
  log('・新ルートで /api/members/:id/invoice-folders/generate を 1 件試して権限が想定通りか確認');
  log('・問題なければ旧ルート配下を delete_invoice_folders.js または手動で削除');
  log('完了');
}

main().catch(e => {
  console.error('[migrate-invoice] 致命的エラー:', e.stack || e.message);
  process.exit(1);
});

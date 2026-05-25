// workers/invoice-folder-monthly-gen.js
// =============================================================
// 請求書フォルダ 月次自動生成ワーカ
//
// 役割:
//   月が変わったら（JST 基準）、is_active=true のメンバー全員分の
//   「今月の請求書フォルダ」を自動生成する。
//   従来は管理者が各メンバー行の「+生成」ボタンを手動で押す必要があった。
//
// 起動:
//   server.js から startInvoiceFolderMonthlyGen() を1回だけ呼ぶ。
//   1時間に1回ポーリングし、JST 月が system_settings.invoice_auto_gen_last_yyyymm と
//   違っていれば全メンバー分の今月フォルダを生成する。起動直後にも1回流す。
//
// 冪等性:
//   既存生成 API (/api/members/:id/invoice-folders/generate) と同じロジックを再利用。
//   member_invoice_folders に既存レコードがあれば skip（folder_id は再利用）。
//
// 失敗時:
//   1メンバー失敗しても次のメンバーへ進む（catch して logger.warn）。
//   全失敗でもポーリングは止めない。
//
// JST 厳密ロジック:
//   Railway は UTC 動作。toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
//   から YYYY-MM を必ず JST で算出する（memory: feedback_time_logic_jst_explicit）。
//
// 手動実行:
//   node workers/invoice-folder-monthly-gen.js          # 強制実行（last 無視）
//   node workers/invoice-folder-monthly-gen.js --check  # 月が変わっていれば実行
// =============================================================

const supabase = require('../supabase');
const harukaRouter = require('../routes/haruka');
const {
  getDriveService,
  getOrCreateFolder,
  buildMemberFolderName,
  buildInvoiceMemberFolderName,
  ensureUserDrivePermission,
  getInvoiceRootFolderId,
  getInvoiceFolderManagerEmails,
  driveFolderUrl,
} = harukaRouter;

const TICK_MS = 60 * 60 * 1000; // 1時間
const LAST_YYYYMM_KEY = 'invoice_auto_gen_last_yyyymm';

let intervalHandle = null;
let isRunning = false;

// JST の YYYY-MM を返す（UTC 環境でも確実）
function getJstYyyymm() {
  // 'YYYY-MM-DD' → 'YYYY-MM'
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7);
}

function jstYearMonthParts(yyyymm) {
  const year = parseInt(yyyymm.slice(0, 4), 10);
  const month = parseInt(yyyymm.slice(5, 7), 10);
  return { year, month };
}

async function getLastYyyymm() {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', LAST_YYYYMM_KEY)
      .maybeSingle();
    if (error) {
      console.warn('[invoice-monthly-gen] last yyyy-mm 取得失敗:', error.message);
      return null;
    }
    return data && data.value ? data.value : null;
  } catch (e) {
    console.warn('[invoice-monthly-gen] last yyyy-mm 取得 例外:', e.message);
    return null;
  }
}

async function setLastYyyymm(yyyymm) {
  try {
    const { error } = await supabase
      .from('system_settings')
      .upsert(
        { key: LAST_YYYYMM_KEY, value: yyyymm, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (error) console.warn('[invoice-monthly-gen] last yyyy-mm 更新失敗:', error.message);
  } catch (e) {
    console.warn('[invoice-monthly-gen] last yyyy-mm 更新 例外:', e.message);
  }
}

// 在籍メンバー（is_active=true）を全件取得
async function fetchActiveMembers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active')
    .eq('is_active', true)
    .order('full_name', { ascending: true });
  if (error) throw new Error(`users 取得失敗: ${error.message}`);
  return (data || []).filter(u => u.email);
}

// 同姓同名チェック用に全メンバーを取得して baseName -> count を作る
async function buildNameClashMap() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, is_active');
  if (error) throw new Error(`users(clash) 取得失敗: ${error.message}`);
  const map = new Map();
  for (const u of (data || [])) {
    if (!u.email) continue;
    const base = buildInvoiceMemberFolderName(u);
    map.set(base, (map.get(base) || 0) + 1);
  }
  return map;
}

// 1メンバー分の当月フォルダを生成する。
// /api/members/:id/invoice-folders/generate の core ロジックを worker 用に抽出。
// 戻り値: { created: boolean, skipped: boolean, folder_id }
async function ensureMemberMonthlyFolder({
  drive,
  invoiceRootId,
  yearFolderId,
  monthFolderId,
  year,
  month,
  user,
  clashCount,
}) {
  // 同姓同名なら email local part を suffix
  const baseName = buildInvoiceMemberFolderName(user);
  let folderName = baseName;
  if ((clashCount.get(baseName) || 0) > 1) {
    const emailLocal = (user.email || '').split('@')[0];
    folderName = `${baseName} (${emailLocal})`;
  }

  // 既存マッピングがあれば skip（冪等性）
  const { data: existing } = await supabase
    .from('member_invoice_folders')
    .select('folder_id, folder_url')
    .eq('user_id', user.id)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  const memberFolderNameWithMonth = buildMemberFolderName(folderName, year, month);

  let memberFolderId;
  let created = false;
  let skipped = false;

  if (existing && existing.folder_id) {
    memberFolderId = existing.folder_id;
    skipped = true;
  } else {
    memberFolderId = await getOrCreateFolder(drive, monthFolderId, memberFolderNameWithMonth);
    const { error: upErr } = await supabase
      .from('member_invoice_folders')
      .upsert(
        {
          user_id: user.id,
          year,
          month,
          folder_id: memberFolderId,
          folder_url: driveFolderUrl(memberFolderId),
          created_by: null, // システム自動生成
        },
        { onConflict: 'user_id,year,month' }
      );
    if (upErr) throw new Error(`member_invoice_folders upsert 失敗: ${upErr.message}`);
    created = true;
  }

  // 本人 writer
  try {
    await ensureUserDrivePermission(drive, memberFolderId, user.email, 'writer');
  } catch (e) {
    console.warn(`[invoice-monthly-gen] 本人 permission 失敗 ${user.email}: ${e.message}`);
  }
  // 管理者 + 必要なら秘書群
  try {
    const managerEmails = await getInvoiceFolderManagerEmails(user.id);
    for (const em of managerEmails) {
      if (em === (user.email || '').toLowerCase()) continue;
      try {
        await ensureUserDrivePermission(drive, memberFolderId, em, 'writer');
      } catch (e) {
        console.warn(`[invoice-monthly-gen] manager permission 失敗 ${em}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[invoice-monthly-gen] manager 取得失敗 user=${user.id}: ${e.message}`);
  }

  return { created, skipped, folder_id: memberFolderId };
}

// 1回分の月次生成バッチ。指定された yyyymm に対して全在籍メンバー分の今月フォルダを作る。
async function runMonthlyGenerationFor(yyyymm, { force = false } = {}) {
  const { year, month } = jstYearMonthParts(yyyymm);
  const lastYyyymm = await getLastYyyymm();

  const members = await fetchActiveMembers();
  console.log(`[invoice-monthly-gen] starting for ${yyyymm} (last=${lastYyyymm || '-'}), members=${members.length}, force=${force}`);

  if (members.length === 0) {
    console.log('[invoice-monthly-gen] 対象メンバー無し。last を更新して終了');
    await setLastYyyymm(yyyymm);
    return { ok: 0, failed: 0 };
  }

  const startedAt = Date.now();
  const drive = await getDriveService();
  const invoiceRootId = await getInvoiceRootFolderId(drive);

  // 年/月フォルダを一度だけ getOrCreate（メンバー毎にやると遅い）
  const yearLabel = `${year}年`;
  const yearFolderId = await getOrCreateFolder(drive, invoiceRootId, yearLabel);
  const monthLabel = `${String(month).padStart(2, '0')}月`;
  const monthFolderId = await getOrCreateFolder(drive, yearFolderId, monthLabel);

  // 同姓同名マップ
  const clashCount = await buildNameClashMap();

  let auditCreated = 0;
  let auditSkipped = 0;
  let ok = 0;
  let failed = 0;
  const failedUsers = [];

  // シーケンシャル（Drive API レート対策＋ログの読みやすさ）
  for (const user of members) {
    const displayName = user.full_name || user.nickname || (user.email || '').split('@')[0];
    try {
      const r = await ensureMemberMonthlyFolder({
        drive,
        invoiceRootId,
        yearFolderId,
        monthFolderId,
        year,
        month,
        user,
        clashCount,
      });
      if (r.created) auditCreated++;
      if (r.skipped) auditSkipped++;
      ok++;
      console.log(`[invoice-monthly-gen] ok user=${user.id} name=${displayName} ${r.created ? 'created' : 'skipped'}`);
    } catch (e) {
      failed++;
      failedUsers.push({ id: user.id, name: displayName, error: e.message });
      console.warn(`[invoice-monthly-gen] failed user=${user.id} name=${displayName} error=${e.message}`);
    }
  }

  // 監査ログ
  try {
    await supabase.from('invoice_folder_audit_log').insert({
      approved_by_user_id: null, // システム自動実行
      command_args: {
        source: 'invoice-folder-monthly-gen',
        yyyymm,
        year,
        month,
        members_total: members.length,
        force,
      },
      folders_created_count: auditCreated,
      folders_skipped_count: auditSkipped,
      permissions_granted_count: 0,
      permissions_revoked_count: 0,
      duration_ms: Date.now() - startedAt,
      status: failed === 0 ? 'success' : 'partial',
      error_message: failedUsers.length > 0 ? `failed_users=${failedUsers.length}` : null,
    });
  } catch (e) {
    console.warn('[invoice-monthly-gen] audit log insert 失敗:', e.message);
  }

  // last 更新（部分失敗でも、その月の対象になったこと自体は記録する。
  // 次の tick で再実行されるとフォルダが既存判定で skip されるため安全）
  await setLastYyyymm(yyyymm);

  console.log(`[invoice-monthly-gen] done yyyy-mm=${yyyymm} ok=${ok} failed=${failed}`);
  return { ok, failed };
}

// tick: JST 月が last と違えば月次生成を起動
async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const yyyymm = getJstYyyymm();
    const last = await getLastYyyymm();
    if (last === yyyymm) {
      // 何もしない（noisy にならないよう debug 相当にしておく）
      return;
    }
    console.log(`[invoice-monthly-gen] month changed: ${last || '(none)'} -> ${yyyymm}, running batch`);
    await runMonthlyGenerationFor(yyyymm, { force: false });
  } catch (e) {
    console.error('[invoice-monthly-gen] tick 例外:', e.stack || e.message);
  } finally {
    isRunning = false;
  }
}

function startInvoiceFolderMonthlyGen() {
  if (intervalHandle) return;
  console.log(`[invoice-monthly-gen] 起動（${TICK_MS}ms 周期）`);
  // 起動直後に1回流す
  tick().catch(e => console.error('[invoice-monthly-gen] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[invoice-monthly-gen] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }
}

function stopInvoiceFolderMonthlyGen() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startInvoiceFolderMonthlyGen,
  stopInvoiceFolderMonthlyGen,
  runMonthlyGenerationFor,
  tick,
  // テスト用
  _internal: { getJstYyyymm, getLastYyyymm, setLastYyyymm },
};

// 単発実行（手動テスト用）
//   node workers/invoice-folder-monthly-gen.js          → 強制実行（force=true）
//   node workers/invoice-folder-monthly-gen.js --check  → 月が変わっていれば実行
if (require.main === module) {
  require('dotenv').config();
  const isCheck = process.argv.includes('--check');
  (async () => {
    try {
      if (isCheck) {
        console.log('[invoice-monthly-gen] manual --check (月変化があれば実行)');
        await tick();
      } else {
        const yyyymm = getJstYyyymm();
        console.log(`[invoice-monthly-gen] manual force-run for ${yyyymm}`);
        await runMonthlyGenerationFor(yyyymm, { force: true });
      }
      process.exit(0);
    } catch (e) {
      console.error('[invoice-monthly-gen] manual run 失敗:', e.stack || e.message);
      process.exit(1);
    }
  })();
}

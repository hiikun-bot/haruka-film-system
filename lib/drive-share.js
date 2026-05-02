// lib/drive-share.js — クライアント確認用URLを Drive 上で自動公開設定する
//
// 目的:
//   クリエイティブが「クライアントチェック中」ステータスに進んだ瞬間、
//   関連する動画ファイル（faststart 版優先 → なければマスター原本）に対して
//   Drive permissions.create({ role:'reader', type:'anyone' }) を実行し、
//   webViewLink を取得して creatives.client_review_url に保存する。
//
//   これにより手動コピペ運用（PR #167）が完全自動化され、
//   ディレクター/編集者の作業ゼロでクライアント通知に正しい URL が乗る。
//
// 設計上の重要ポイント:
//   - 手動入力で client_review_url が既にある場合は **絶対に上書きしない**
//     （ユーザーが意図して別URLを置いたケースを尊重する）
//     → ?force=true を経由して上書きするときだけ override 可
//   - permissions.create は同じ permission が既にあると 400 を返すので
//     try/catch で握りつぶす（idempotent な op として扱う）
//   - 失敗してもクリエイティブ更新本体は壊さない（呼び出し側が握りつぶす）
//
// 公開API:
//   shareForClientReview({ creativeId, force? })
//     -> Promise<{ url: string|null, source: 'faststart'|'master'|'existing'|'skipped' }>

const { google } = require('googleapis');
const supabase   = require('../supabase');

// Drive クライアント取得（routes/haruka.js / lib/faststart.js と同パターン）
async function getDriveService() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// permissions.create を idempotent に実行する。
// 既に anyone-with-link が付いていれば 400 / 403 が返るが、それは成功扱いでよい。
async function ensureAnyoneReader(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch (e) {
    // 既に同 permission が付いている / sharing policy で同等扱い、等は致命的でない
    const code = e?.code || e?.response?.status;
    const msg  = e?.message || '';
    if (code === 400 || code === 403 || /already exists|cannotShareTeamDriveTopFolderWithAnyoneOrDomains|publishOutNotPermitted|sharingRateLimitExceeded/i.test(msg)) {
      console.warn('[drive-share] permissions.create 既存/制限の可能性 (skip):', code, msg);
      return;
    }
    throw e;
  }
}

// creative_files から「クライアント確認に出すべき動画ファイル」を1件選ぶ。
// 並び順: 最新バージョン優先（version DESC, さらに uploaded_at DESC）。
async function pickPrimaryFile(creativeId) {
  // 旧スキーマ（faststart_* 列なし）も考慮し、まずは select * で取る。
  const { data, error } = await supabase
    .from('creative_files')
    .select('*')
    .eq('creative_id', creativeId)
    .order('version', { ascending: false })
    .order('uploaded_at', { ascending: false })
    .limit(5);
  if (error) {
    // version 列等が無い旧 DB 用 fallback
    const { data: fallback } = await supabase
      .from('creative_files')
      .select('*')
      .eq('creative_id', creativeId)
      .limit(5);
    if (fallback && fallback.length > 0) return fallback[0];
    return null;
  }
  return (data && data.length > 0) ? data[0] : null;
}

// 公開 API.
// returns { url, source, fileId? }
async function shareForClientReview({ creativeId, force = false } = {}) {
  if (!creativeId) throw new Error('creativeId が必要です');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.warn('[drive-share] GOOGLE_SERVICE_ACCOUNT_KEY 未設定。skip');
    return { url: null, source: 'skipped' };
  }

  // 1. creative の現状を取得。client_review_url が既にあれば原則上書きしない。
  const { data: creative, error: cErr } = await supabase
    .from('creatives')
    .select('id, client_review_url')
    .eq('id', creativeId)
    .maybeSingle();
  if (cErr) throw new Error(`creatives 取得失敗: ${cErr.message}`);
  if (!creative) throw new Error(`creative not found: ${creativeId}`);

  if (!force && creative.client_review_url && String(creative.client_review_url).trim()) {
    return { url: creative.client_review_url, source: 'existing' };
  }

  // 2. 関連 creative_files から1件選ぶ
  const file = await pickPrimaryFile(creativeId);
  if (!file) {
    return { url: null, source: 'skipped' };
  }

  // 3. 公開対象 fileId を決定（faststart 完成済 > マスター原本）
  let targetFileId = null;
  let source = null;
  if (file.faststart_drive_file_id && file.faststart_status === 'done') {
    targetFileId = file.faststart_drive_file_id;
    source = 'faststart';
  } else if (file.drive_file_id) {
    targetFileId = file.drive_file_id;
    source = 'master';
  }
  if (!targetFileId) {
    return { url: null, source: 'skipped' };
  }

  // 4. Drive で公開設定 + URL 取得
  const drive = await getDriveService();
  await ensureAnyoneReader(drive, targetFileId);

  let webViewLink = null;
  try {
    const meta = await drive.files.get({
      fileId: targetFileId,
      fields: 'webViewLink, id',
      supportsAllDrives: true,
    });
    webViewLink = meta.data?.webViewLink || null;
  } catch (e) {
    throw new Error(`drive.files.get 失敗 fileId=${targetFileId}: ${e.message}`);
  }

  if (!webViewLink) {
    // faststart が表示用 URL を持っていなければ master 原本にフォールバック
    if (source === 'faststart' && file.drive_file_id) {
      try {
        await ensureAnyoneReader(drive, file.drive_file_id);
        const meta2 = await drive.files.get({
          fileId: file.drive_file_id,
          fields: 'webViewLink, id',
          supportsAllDrives: true,
        });
        webViewLink = meta2.data?.webViewLink || null;
        if (webViewLink) {
          targetFileId = file.drive_file_id;
          source = 'master';
        }
      } catch (_) { /* 致命的でない */ }
    }
  }

  if (!webViewLink) {
    return { url: null, source: 'skipped' };
  }

  // 5. race condition 対策で再取得 → 既に値があれば（force でない限り）尊重
  if (!force) {
    const { data: again } = await supabase
      .from('creatives')
      .select('client_review_url')
      .eq('id', creativeId)
      .maybeSingle();
    if (again && again.client_review_url && String(again.client_review_url).trim()) {
      return { url: again.client_review_url, source: 'existing' };
    }
  }

  // 6. DB 反映
  const { error: upErr } = await supabase
    .from('creatives')
    .update({
      client_review_url: webViewLink,
      updated_at: new Date().toISOString(),
    })
    .eq('id', creativeId);
  if (upErr) {
    // client_review_url 列が無い古い DB は本機能外として失敗扱いにする
    throw new Error(`creatives.client_review_url 更新失敗: ${upErr.message}`);
  }

  return { url: webViewLink, source, fileId: targetFileId };
}

module.exports = {
  shareForClientReview,
};

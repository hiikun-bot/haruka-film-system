// lib/video-organization/drive.js — Google Drive メタ取得 + ダウンロードヘルパー
//
// 認証は既存 lib/drive-share.js と同じパターンで GOOGLE_SERVICE_ACCOUNT_KEY を流用。
// 別キーに差し替えたい場合は VERTEX_AI_SERVICE_ACCOUNT_KEY 等を別途用意するが、
// 今回の MVP では同一キーで Vertex AI も叩く前提。

const { google } = require('googleapis');

function getCredentials() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  return JSON.parse(keyJson);
}

async function getDriveService() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Resumable Upload のセッション発行など、googleapis クライアントを介さず
// 生の fetch で Drive API を直接叩く際に使うサービスアカウントのアクセストークン。
// 案件フォルダの作成・小容量アップロード・メタ取得もすべてこのサービスアカウントなので、
// セッション発行も同一人格に揃えることで「フォルダが存在しない（drive.file スコープ外）」
// による発行失敗を防ぐ。
async function getAccessToken() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('サービスアカウントのアクセストークン取得に失敗しました');
  return token;
}

// Drive 上の動画ファイルメタを取得する。
// videoMediaMetadata.durationMillis から動画時間 (秒) を返すので
// ffprobe を介さず長さ判定が可能。
async function getVideoFileMeta(fileId) {
  const drive = await getDriveService();
  const { data } = await drive.files.get({
    fileId,
    fields: [
      'id', 'name', 'mimeType', 'size',
      'createdTime', 'modifiedTime', 'webViewLink',
      'parents', 'videoMediaMetadata'
    ].join(','),
    supportsAllDrives: true,
  });
  const durationMillis = data?.videoMediaMetadata?.durationMillis
    ? Number(data.videoMediaMetadata.durationMillis) : null;
  return {
    fileId: data.id,
    fileName: data.name,
    mimeType: data.mimeType,
    size: data.size ? Number(data.size) : null,
    createdTime: data.createdTime,
    modifiedTime: data.modifiedTime,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    durationSeconds: durationMillis !== null ? Math.round(durationMillis / 1000) : null,
  };
}

// 親フォルダ名を取得（先頭の parent のみ）。
async function getParentFolderName(parentId) {
  if (!parentId) return null;
  const drive = await getDriveService();
  try {
    const { data } = await drive.files.get({
      fileId: parentId,
      fields: 'id,name',
      supportsAllDrives: true,
    });
    return data?.name || null;
  } catch (_) {
    return null;
  }
}

// Drive 上のファイルをメモリにダウンロードする（base64 で Gemini に渡す用）。
// 大きすぎる動画はメモリ事故になるので、呼び出し側で size を必ずチェックすること。
async function downloadFileBuffer(fileId) {
  const drive = await getDriveService();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// Drive にメディアをアップロードする（素材広場アップロードフォルダ宛て）。
// 戻り値: { fileId, fileName, mimeType, size, webViewLink, parents }
async function uploadFile({ buffer, filename, mimeType, parentFolderId }) {
  if (!parentFolderId) throw new Error('parentFolderId が未指定');
  const drive = await getDriveService();
  const { Readable } = require('stream');
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentFolderId],
      mimeType,
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id,name,mimeType,size,webViewLink,parents,videoMediaMetadata,thumbnailLink,createdTime,modifiedTime',
    supportsAllDrives: true,
  });
  const data = res.data || {};
  const durationMillis = data?.videoMediaMetadata?.durationMillis
    ? Number(data.videoMediaMetadata.durationMillis) : null;
  return {
    fileId: data.id,
    fileName: data.name,
    mimeType: data.mimeType,
    size: data.size ? Number(data.size) : (buffer ? buffer.length : null),
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    durationSeconds: durationMillis !== null ? Math.round(durationMillis / 1000) : null,
    thumbnailLink: data.thumbnailLink || null,
    createdTime: data.createdTime,
    modifiedTime: data.modifiedTime,
  };
}

// 親フォルダ配下に指定名のフォルダを取得（無ければ作成）して folder id を返す。
// 素材広場の「案件あり」アップロードで `素材広場ルート > クライアント名 > 案件名` を
// ensure するのに使う（クリエイティブの getOrCreateFolder と同じ発想）。
//   - SA 認証。Shared Drive 対応（supportsAllDrives / includeItemsFromAllDrives）。
//   - name 内の \ と ' は Drive クエリ用にエスケープする。フォルダ名に使えない文字
//     （/ \ ? % * : | " < >）のサニタイズは呼び出し側の責務（既存クリエイティブと同様）。
async function getOrCreateFolder(parentId, name, { client } = {}) {
  if (!parentId) throw new Error('parentId が未指定');
  const folderName = String(name || '').trim();
  if (!folderName) throw new Error('フォルダ名が空です');
  const drive = client || (await getDriveService());

  // 既存検索（同名フォルダがあれば最初の 1 件を再利用）
  const escaped = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name = '${escaped}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false',
  ].join(' and ');
  const { data: listed } = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (listed?.files?.length) return listed.files[0].id;

  // 無ければ作成
  const { data: created } = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.id;
}

// プレビュープロキシ用: Drive からのストリームを Range ヘッダ対応で読み取る。
// 戻り値: { stream, headers: {content-type, content-length, ...} }
//   range = "bytes=0-99" 形式 or null
async function getFileStream(fileId, range) {
  const drive = await getDriveService();
  const reqOpts = { responseType: 'stream' };
  if (range) {
    reqOpts.headers = { Range: range };
  }
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    reqOpts
  );
  return {
    stream: res.data,
    status: res.status || 200,
    headers: res.headers || {},
  };
}

// Drive 上のファイルを削除する。
//   - 例外は再 throw しない。失敗詳細（status / reason / message）を構造化して返す。
//   - { client } を渡すと SA ではなく任意の Drive クライアントで叩く（ユーザーOAuth でのリトライ用）。
//   - { verify: false } で削除直後の files.get() による存在確認をスキップ可能（既定: true）。
//
// なぜ verify するか:
//   Google Drive API は条件次第で files.delete() が 204 を返しても実体が残るケースがある。
//     - Shared Drive の権限ロール次第（閲覧者で叩いても 204 が返ることが報告されている）
//     - drive.file スコープで他者所有のファイルを叩いた際、自分の view からだけ消えて
//       実体は残るケース（共有設定によっては 403 ではなく 204 になることがある）
//   →「成功表示が出るのに Drive に残る」UX バグの直接原因。delete 後に必ず files.get() で
//      404 を確認するまで成功扱いにしない。
//
// 戻り値:
//   成功時: { ok: true, status: 204, verified: true }
//     - verified: true は「files.get で 404 を確認した」or「verify をスキップした」の意味
//   verify 失敗時（消えたフリ）: { ok: false, status: 'not_actually_deleted', verified: false, reason: 'not_actually_deleted', message }
//   その他失敗時: { ok: false, status: 404|403|401|5xx|null, reason: 'notFound'|'insufficientFilePermissions'|null, message, verified: false }
//
// 旧 API（boolean を期待していた呼び出し側）は result.ok で判定するよう更新済み。
async function deleteFile(fileId, { client, verify = true } = {}) {
  let drive;
  try {
    drive = client || (await getDriveService());
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (e) {
    const status = e?.code || e?.response?.status || null;
    const reason = e?.errors?.[0]?.reason
      || e?.response?.data?.error?.errors?.[0]?.reason
      || null;
    console.warn('[video-org] drive deleteFile failed:', fileId, status, reason, e.message);
    return {
      ok: false,
      status,
      reason,
      message: e.message,
      verified: false,
    };
  }

  // verify スキップ指定なら即成功で返す
  if (!verify) {
    return { ok: true, status: 204, verified: true };
  }

  // 削除直後の verify: files.get() で 404 になれば本当に消えている
  try {
    await drive.files.get({
      fileId,
      fields: 'id,trashed',
      supportsAllDrives: true,
    });
    // 200 で返ってきた = 実体が残っている（削除ハシゴ外し）
    console.warn('[video-org] drive deleteFile verify failed (file still exists):', fileId);
    return {
      ok: false,
      status: 'not_actually_deleted',
      reason: 'not_actually_deleted',
      message: 'files.delete() succeeded but files.get() still returns the file',
      verified: false,
    };
  } catch (verifyErr) {
    const vStatus = verifyErr?.code || verifyErr?.response?.status || null;
    if (vStatus === 404) {
      // 期待通り消えている
      return { ok: true, status: 204, verified: true };
    }
    // 404 以外（403/5xx 等）は verify 自体が失敗しただけ。削除自体は成功した可能性があるが、
    // 安全側に倒して呼び出し側にリトライ判断を任せる。
    console.warn('[video-org] drive deleteFile verify error:', fileId, vStatus, verifyErr.message);
    return {
      ok: false,
      status: 'verify_failed',
      reason: 'verify_failed',
      message: `files.delete returned success but verify (files.get) errored: ${verifyErr.message}`,
      verified: false,
      verifyStatus: vStatus,
    };
  }
}

// Drive 上のファイルをゴミ箱に送る（trashed=true）。完全削除（files.delete）ではなく
// files.update({ trashed: true }) を使う。
//
// なぜ trash 方式か:
//   素材広場のファイルは共有ドライブ（Shared Drive）にあり、SA(haruka-film-drive@...) の
//   ロールは「コンテンツ管理者」。このロールは canTrash=true だが canDelete=false のため、
//   files.delete()（完全削除）は 403 insufficientFilePermissions で必ず失敗する。
//   一方 files.update({ trashed: true }) はコンテンツ管理者でも成功する（実機確認済み）。
//   従来の「files.delete() 前提」実装は SA で物理削除できず、孤児ファイルが共有ドライブに
//   溜まる原因になっていた。削除＝ゴミ箱送りに変更することで SA 主軸で確実に Drive から消える。
//
//   - 例外は再 throw しない。失敗詳細（status / reason / message）を構造化して返す。
//   - { client } を渡すと SA ではなく任意の Drive クライアントで叩く（ユーザーOAuth でのリトライ用）。
//   - { verify: false } で files.get() による trashed 確認をスキップ可能（既定: true）。
//
// verify の意味:
//   trash 後に files.get で trashed===true を確認できたものだけ成功扱いにする。
//   （旧 deleteFile の「get で 404 なら成功」はゴミ箱送りでは不適。ゴミ箱の中身は get で
//    200 + trashed:true として見えるため、404 を成功条件にすると永久に失敗判定になる）
//
// 戻り値:
//   成功時: { ok: true, status: 'trashed', verified: true }
//   verify 失敗時（trashedにならず残っている）: { ok: false, status: 'not_actually_trashed', reason: 'not_actually_trashed', message, verified: false }
//   その他失敗時: { ok: false, status: 404|403|401|5xx|null, reason: 'notFound'|'insufficientFilePermissions'|null, message, verified: false }
async function trashFile(fileId, { client, verify = true } = {}) {
  let drive;
  try {
    drive = client || (await getDriveService());
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
      fields: 'id,trashed',
    });
  } catch (e) {
    const status = e?.code || e?.response?.status || null;
    const reason = e?.errors?.[0]?.reason
      || e?.response?.data?.error?.errors?.[0]?.reason
      || null;
    console.warn('[video-org] drive trashFile failed:', fileId, status, reason, e.message);
    return {
      ok: false,
      status,
      reason,
      message: e.message,
      verified: false,
    };
  }

  // verify スキップ指定なら即成功で返す
  if (!verify) {
    return { ok: true, status: 'trashed', verified: true };
  }

  // verify: files.get で trashed===true を確認する
  try {
    const { data } = await drive.files.get({
      fileId,
      fields: 'id,trashed',
      supportsAllDrives: true,
    });
    if (data?.trashed === true) {
      return { ok: true, status: 'trashed', verified: true };
    }
    // update は成功したのに trashed が立っていない（共有設定によるハシゴ外し）
    console.warn('[video-org] drive trashFile verify failed (still not trashed):', fileId);
    return {
      ok: false,
      status: 'not_actually_trashed',
      reason: 'not_actually_trashed',
      message: 'files.update({trashed:true}) succeeded but files.get shows trashed=false',
      verified: false,
    };
  } catch (verifyErr) {
    const vStatus = verifyErr?.code || verifyErr?.response?.status || null;
    if (vStatus === 404) {
      // get で 404 = 実体ごと消えている（既に手動完全削除済み等）。
      // 削除のゴール（Drive 上から消える）は達成済みなので成功扱い。
      return { ok: true, status: 'trashed', verified: true };
    }
    // 404 以外（403/5xx 等）は verify 自体が失敗しただけ。安全側に倒して呼び出し側に判断を任せる。
    console.warn('[video-org] drive trashFile verify error:', fileId, vStatus, verifyErr.message);
    return {
      ok: false,
      status: 'verify_failed',
      reason: 'verify_failed',
      message: `files.update(trashed) returned success but verify (files.get) errored: ${verifyErr.message}`,
      verified: false,
      verifyStatus: vStatus,
    };
  }
}

// ユーザー OAuth の access_token から Drive クライアントを作る。
//   - SA で削除権限がないファイル（drive.file スコープで他者がアップロードしたもの等）を
//     ユーザー本人のトークンでリトライする用途。
function driveClientWithToken(accessToken) {
  if (!accessToken) throw new Error('accessToken required');
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

// ファイルの存在確認用 薄いラッパー。
//   - { client } を渡すと任意の Drive クライアントで叩く（既定は SA）。
//   - 例外は再 throw しない。{ ok: true, id } / { ok: false, status, reason, message } を返す。
//
// 用途: user OAuth (drive.file スコープ) で 404 のとき、SA で実在確認するための Hybrid フォールバック判定。
// SA 所有のファイル（例: faststart.js が SA でアップロードしたプレビュー webp）は
// user OAuth からは「自分が作っていないファイル」として 404 になるが、SA からは見える。
async function getFile(fileId, { client } = {}) {
  try {
    const drive = client || (await getDriveService());
    const { data } = await drive.files.get({
      fileId,
      fields: 'id,name,trashed,parents',
      supportsAllDrives: true,
    });
    return {
      ok: true,
      id: data?.id || fileId,
      name: data?.name || null,
      trashed: data?.trashed === true,
      parents: data?.parents || [],
    };
  } catch (e) {
    const status = e?.code || e?.response?.status || null;
    const reason = e?.errors?.[0]?.reason
      || e?.response?.data?.error?.errors?.[0]?.reason
      || null;
    return {
      ok: false,
      status,
      reason,
      message: e.message,
    };
  }
}

// 派生ファイル（プレビュー webp / faststart mp4）の「あるべき名前」を、原本（master）の
// 新しいファイル名から導出する。素材広場ではセット判別のため、派生ファイルは原本と同じ
// ベース名で並ぶことが必須（faststart.js の生成時と同じ規約）。
//   - faststart プレビュー: <newBase>_faststart.mp4
//   - それ以外（webp 等）: <newBase> + 派生ファイル自身の拡張子（既定 .webp）
// strategy 列には依存せず、派生ファイルの現在名の末尾だけ見て判定する（取りこぼし防止）。
function deriveMatchingPreviewName(newMasterName, previewCurrentName) {
  const newBase = String(newMasterName || '').replace(/\.[^.\/\\]+$/, '');
  if (!newBase) return null;
  const cur = String(previewCurrentName || '');
  if (/_faststart\.mp4$/i.test(cur)) return `${newBase}_faststart.mp4`;
  const extMatch = cur.match(/(\.[^.\/\\]+)$/);
  const ext = extMatch ? extMatch[1] : '.webp';
  return `${newBase}${ext}`;
}

// 派生ファイル（プレビュー webp / faststart mp4）を原本の新ファイル名に合わせてリネームする。
//   - Drive 操作は既定 SA（プレビューは SA 所有のため）。
//   - 失敗しても致命ではない（再生・解析は drive_file_id 経由で可能）ので throw せず結果配列を返す。
async function renameDerivedPreviewsToMatch({ client, newMasterName, previewFileIds = [] }) {
  const drive = client || (await getDriveService());
  const results = [];
  for (const fileId of (previewFileIds || []).filter(Boolean)) {
    try {
      const { data: meta } = await drive.files.get({
        fileId, fields: 'id,name', supportsAllDrives: true,
      });
      const curName = meta?.name || '';
      const nextName = deriveMatchingPreviewName(newMasterName, curName);
      if (nextName && nextName !== curName) {
        await drive.files.update({
          fileId,
          requestBody: { name: nextName },
          fields: 'id,name',
          supportsAllDrives: true,
        });
        results.push({ fileId, from: curName, to: nextName, renamed: true });
      } else {
        results.push({ fileId, from: curName, to: curName, renamed: false });
      }
    } catch (e) {
      results.push({ fileId, renamed: false, error: e?.message || String(e) });
    }
  }
  return results;
}

// thumbnailLink を取得（プレビュー用静止画 URL）
async function getThumbnailLink(fileId) {
  const drive = await getDriveService();
  try {
    const { data } = await drive.files.get({
      fileId,
      fields: 'thumbnailLink',
      supportsAllDrives: true,
    });
    return data?.thumbnailLink || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getDriveService,
  getAccessToken,
  getVideoFileMeta,
  getParentFolderName,
  getOrCreateFolder,
  downloadFileBuffer,
  uploadFile,
  deleteFile,
  trashFile,
  driveClientWithToken,
  getFileStream,
  getThumbnailLink,
  getFile,
  deriveMatchingPreviewName,
  renameDerivedPreviewsToMatch,
};

// lib/video-organization/auto-apply.js — AI 解析完了後の自動 Drive 振り分け
//
// 背景:
//   旧 Stage 1 では POST /apply ボタンを押しても DRY_RUN モードで Drive 上は無変更だった。
//   本モジュールは AI 解析完了 (status='analysis_completed') の直後に user OAuth で
//   Drive 上のファイル名変更＋フォルダ移動を自動実行する。
//
// 認証ポリシー:
//   素材広場フォルダは Shared Drive で SA はメンバーではないため、ファイル名変更・
//   フォルダ作成・親変更は user OAuth で実行する必要がある（ADR 019）。
//
// 例外時:
//   - needs_human_review=true → 自動適用せず status='awaiting_review' で停止
//   - Drive 操作で失敗 → status='apply_failed' + error_message
//   - 成功 → status='applied' + current_filename/current_parent_folder_name 更新 + applied_at
//
// fire-and-forget で呼ばれる前提。呼び出し側は例外を握りつぶす。

const supabase = require('../../supabase');
const guards = require('./guards');
const driveLib = require('./drive');
const googleOAuth = require('../google-oauth');

function logCtx(prefix, payload) {
  console.log(`[video-org] ${prefix}`, JSON.stringify(payload));
}

// recommended_folder を "/" で分解して、各階層フォルダを user OAuth で作成 or 再利用しながら
// 最終フォルダの ID を返す。
//
// rootFolderId は素材広場アップロードフォルダ（VIDEO_ORG_UPLOAD_FOLDER_ID）配下に新階層を作る前提。
async function ensureFolderPath(userDrive, rootFolderId, folderPath) {
  const parts = String(folderPath || '')
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return rootFolderId;

  let parentId = rootFolderId;
  const created = [];
  for (const name of parts) {
    // 同名フォルダ検索（Shared Drive 横断）
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `'${parentId}' in parents`,
      `trashed = false`,
    ].join(' and ');
    const { data: listed } = await userDrive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
    let folderId = listed?.files?.[0]?.id || null;
    if (!folderId) {
      const createRes = await userDrive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
        },
        fields: 'id,name,parents',
        supportsAllDrives: true,
      });
      folderId = createRes.data.id;
      created.push({ name, id: folderId, parent: parentId });
    }
    parentId = folderId;
  }
  return { finalFolderId: parentId, created };
}

// 新フォルダ内の同名ファイルを検索し、存在すれば _2 / _3 ... を付ける。
// 戻り値: 衝突回避済みのファイル名
async function resolveFilenameCollision(userDrive, parentFolderId, desiredName, excludeFileId) {
  const extMatch = desiredName.match(/^(.*?)(\.[^.]+)?$/);
  const base = extMatch ? extMatch[1] : desiredName;
  const ext = extMatch && extMatch[2] ? extMatch[2] : '';

  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? desiredName : `${base}_${i + 1}${ext}`;
    const q = [
      `name = '${candidate.replace(/'/g, "\\'")}'`,
      `'${parentFolderId}' in parents`,
      `trashed = false`,
    ].join(' and ');
    const { data: listed } = await userDrive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
    const files = (listed?.files || []).filter(f => f.id !== excludeFileId);
    if (files.length === 0) return candidate;
  }
  // 100 連続衝突は異常。タイムスタンプを付与してエスケープ。
  return `${base}_${Date.now()}${ext}`;
}

// ファイルを別フォルダへ移動（addParents/removeParents）し、必要なら同時にリネームする。
async function moveAndRename(userDrive, fileId, { newName, newParentId, oldParentId }) {
  const requestBody = {};
  if (newName) requestBody.name = newName;
  const opts = {
    fileId,
    fields: 'id,name,parents',
    supportsAllDrives: true,
  };
  if (newParentId) {
    opts.addParents = newParentId;
    if (oldParentId && oldParentId !== newParentId) {
      opts.removeParents = oldParentId;
    }
  }
  const res = await userDrive.files.update({
    ...opts,
    requestBody,
  });
  return res.data;
}

// 単一行に対して自動振り分けを実行する。
//   { rowId, userId, source } を受け取り、結果サマリを返す。
//   userId は user OAuth トークン取得に使う。未指定なら row.created_by を使う。
//
// 戻り値:
//   { ok: true, status: 'applied'|'awaiting_review', diff }
//   { ok: false, status: 'apply_failed', error }
async function applyForRow({ rowId, userId, source = 'auto', actorUserId = null }) {
  if (!rowId) return { ok: false, error: 'no-row-id' };

  if (guards.isStopAll()) {
    return { ok: false, error: 'stop-all', skipped: true };
  }

  const { data: item, error: fetchError } = await supabase
    .from('video_file_organization_tests')
    .select('*')
    .eq('id', rowId)
    .maybeSingle();
  if (fetchError) return { ok: false, error: `fetch:${fetchError.message}` };
  if (!item) return { ok: false, error: 'row-not-found' };

  // すでに applied なら何もしない（多重キック耐性）
  if (item.status === 'applied') {
    return { ok: true, status: 'applied', skipped: true, reason: 'already-applied' };
  }

  // 解析結果が無い場合は適用不能
  if (!item.recommended_filename || !item.recommended_folder) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: '提案ファイル名 / フォルダが空です',
      })
      .eq('id', item.id);
    return { ok: false, status: 'apply_failed', error: 'missing-recommendation' };
  }

  // 確認が必要なら自動適用しない
  if (item.needs_human_review === true) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'awaiting_review',
      })
      .eq('id', item.id);
    logCtx('auto-apply-review-required', {
      rowId: item.id, fileId: item.drive_file_id,
      confidence: item.confidence, reason: item.reason,
    });
    return { ok: true, status: 'awaiting_review' };
  }

  // 適用に使う user の決定: 明示 userId > 行の created_by
  const oauthUserId = userId || item.created_by;
  if (!oauthUserId) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: 'user OAuth に紐付けるユーザー (created_by) が空のため自動適用できません',
      })
      .eq('id', item.id);
    return { ok: false, status: 'apply_failed', error: 'no-oauth-user' };
  }

  let token;
  try {
    token = await googleOAuth.getValidAccessToken({
      userId: oauthUserId,
      scopeKey: 'drive.file',
    });
  } catch (e) {
    token = null;
  }
  if (!token) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: 'user OAuth 連携なし (/oauth/google/start 未実施 or refresh_token 失効)',
      })
      .eq('id', item.id);
    return { ok: false, status: 'apply_failed', error: 'oauth-not-connected' };
  }

  const userDrive = driveLib.driveClientWithToken(token.accessToken);

  // ルートフォルダ（素材広場アップロードフォルダ）配下に階層を作る
  const rootFolderId = process.env.VIDEO_ORG_UPLOAD_FOLDER_ID
    || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID
    || item.current_parent_folder_id;
  if (!rootFolderId) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: 'VIDEO_ORG_UPLOAD_FOLDER_ID / GOOGLE_DRIVE_ROOT_FOLDER_ID 未設定',
      })
      .eq('id', item.id);
    return { ok: false, status: 'apply_failed', error: 'no-root-folder' };
  }

  try {
    // 1) 階層フォルダを user OAuth で確保
    const { finalFolderId, created } = await ensureFolderPath(
      userDrive, rootFolderId, item.recommended_folder
    );

    // 2) 衝突回避済みファイル名
    const finalName = await resolveFilenameCollision(
      userDrive, finalFolderId, item.recommended_filename, item.drive_file_id
    );

    // 3) 原本を移動 + リネーム
    await moveAndRename(userDrive, item.drive_file_id, {
      newName: finalName,
      newParentId: finalFolderId,
      oldParentId: item.current_parent_folder_id,
    });

    // 4) プレビュー webp も同じフォルダへ移動（ファイル名はそのまま）
    if (item.preview_drive_file_id) {
      try {
        // プレビューの現親フォルダを取得（DB に持っていないので files.get で確認）
        const previewMeta = await userDrive.files.get({
          fileId: item.preview_drive_file_id,
          fields: 'id,parents',
          supportsAllDrives: true,
        });
        const previewParent = previewMeta.data?.parents?.[0] || null;
        if (previewParent !== finalFolderId) {
          await userDrive.files.update({
            fileId: item.preview_drive_file_id,
            addParents: finalFolderId,
            removeParents: previewParent || undefined,
            fields: 'id,parents',
            supportsAllDrives: true,
          });
        }
      } catch (previewMoveErr) {
        // プレビュー移動の失敗は致命ではない（解析・再生は drive_file_id 経由でも可能）
        console.warn('[video-org] auto-apply: preview move skipped:', previewMoveErr.message);
      }
    }

    // 5) DB 更新
    const newParentName = item.recommended_folder.split('/').pop() || null;
    const { error: upErr } = await supabase
      .from('video_file_organization_tests')
      .update({
        status: 'applied',
        current_filename: finalName,
        current_parent_folder_id: finalFolderId,
        current_parent_folder_name: newParentName,
        applied_at: new Date().toISOString(),
        applied_by: actorUserId || null,
        error_message: null,
      })
      .eq('id', item.id);
    if (upErr) throw upErr;

    logCtx('auto-apply-done', {
      rowId: item.id, fileId: item.drive_file_id,
      source,
      finalFolderId,
      finalName,
      folders_created: created?.length || 0,
    });

    return {
      ok: true,
      status: 'applied',
      diff: {
        from_filename: item.current_filename,
        to_filename: finalName,
        from_folder: item.current_parent_folder_name,
        to_folder: item.recommended_folder,
        folders_created: created,
      },
    };
  } catch (e) {
    const msg = e?.errors?.[0]?.message || e?.message || String(e);
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: `Drive 適用失敗: ${msg}`,
      })
      .eq('id', item.id);
    logCtx('auto-apply-failed', {
      rowId: item.id, fileId: item.drive_file_id,
      source,
      error: msg,
    });
    return { ok: false, status: 'apply_failed', error: msg };
  }
}

module.exports = {
  applyForRow,
};

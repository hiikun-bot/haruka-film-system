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
const { resolveProjectFolder } = require('./project-folder');

function logCtx(prefix, payload) {
  console.log(`[video-org] ${prefix}`, JSON.stringify(payload));
}

// 文字列から撮影日(YYYYMMDD)を抽出する。
//   - YYYYMMDD（20xx 始まり 8 桁）を最優先
//   - 次に YYMMDD（6 桁。月 01-12 / 日 01-31 の妥当性チェック付き。撮影機材の
//     クリップ名 例: A002F525_260613OW → 260613 を 20260613 とみなす）
// 取れなければ null。
function extractDateFromName(name) {
  const s = String(name || '');
  let m = s.match(/(20\d{2})(\d{2})(\d{2})/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) {
    return `${m[1]}${m[2]}${m[3]}`;
  }
  m = s.match(/(?:^|[^0-9])(\d{2})(\d{2})(\d{2})(?:[^0-9]|$)/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) {
    return `20${m[1]}${m[2]}${m[3]}`;
  }
  return null;
}

// ISO 文字列を JST の YYYYMMDD に変換する。
//   Railway は UTC 動作のため、必ず Asia/Tokyo を明示する（サーバーローカル依存を避ける）。
function jstYYYYMMDD(iso) {
  const d = iso ? new Date(iso) : null;
  const valid = d && !Number.isNaN(d.getTime());
  const ymd = (valid ? d : new Date()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  return ymd.replace(/-/g, '');
}

// 案件フォルダ直下に置くファイル名に「撮影日(YYYYMMDD)」を必ず含める。
//   日付単位で「その日撮影した素材」を見分けられるようにするための要件。
//   優先順位:
//     1) recommended_filename が "日付不明..." なら、その語を実日付に差し替える
//     2) 既に先頭 8 桁日付なら そのまま
//     3) それ以外は先頭に日付を付与
//   日付ソース: 元ファイル名から抽出 → 取れなければアップロード日(created_at, JST)
function ensureShootDateInFilename(recommendedName, { originalFilename, createdAtISO }) {
  const name = String(recommendedName || '').trim();
  const date = extractDateFromName(originalFilename) || jstYYYYMMDD(createdAtISO);

  const UNKNOWN = '日付不明';
  if (name.startsWith(UNKNOWN)) {
    return `${date}${name.slice(UNKNOWN.length)}`;
  }
  if (/^\d{8}([_.\-]|$)/.test(name)) {
    return name;
  }
  return name ? `${date}_${name}` : date;
}

// recommended_folder を "/" で分解して、各階層フォルダを SA で作成 or 再利用しながら
// 最終フォルダの ID を返す。
//
// rootFolderId は素材広場アップロードフォルダ（VIDEO_ORG_UPLOAD_FOLDER_ID）配下に新階層を作る前提。
async function ensureFolderPath(drive, rootFolderId, folderPath) {
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
    const { data: listed } = await drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
    let folderId = listed?.files?.[0]?.id || null;
    if (!folderId) {
      const createRes = await drive.files.create({
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

// フォルダに anyone-with-link reader を付与する（冪等）。
// 既に付与済み・権限不足などで失敗しても例外を投げず、apply 本体を止めない。
async function grantAnyoneReader(drive, folderId) {
  if (!folderId) return;
  try {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: { type: 'anyone', role: 'reader' },
      supportsAllDrives: true,
    });
  } catch (e) {
    // 既に anyone 権限がある場合などは無視（重複作成は無害）
    console.warn('[video-org] grantAnyoneReader skip:', folderId, e?.message || e);
  }
}

// 新フォルダ内の同名ファイルを検索し、存在すれば _2 / _3 ... を付ける。
// 戻り値: 衝突回避済みのファイル名
async function resolveFilenameCollision(drive, parentFolderId, desiredName, excludeFileId) {
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
    const { data: listed } = await drive.files.list({
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
async function moveAndRename(drive, fileId, { newName, newParentId, oldParentId }) {
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
  const res = await drive.files.update({
    ...opts,
    requestBody,
  });
  return res.data;
}

// 単一行に対して自動振り分けを実行する。
//   { rowId, userId, source } を受け取り、結果サマリを返す。
//   Drive 操作は SA（サービスアカウント）で行う。userId は監査用の actorUserId と合わせて
//   保持するが、Drive 認証には使わない（旧 user OAuth 方式は廃止）。
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

  // ADR 019 改訂 (2026-06-16): needs_human_review でも止めず常に自動適用する。
  //   「確認して適用する」動線を廃止し、AI 解析完了で必ず Drive 振り分けまで走らせる。
  //   提案ファイル名が気に入らない場合は、適用後に画面のファイル名インライン編集
  //   （POST /rename）で直す運用に変更した。

  // Drive 操作はサービスアカウント (SA) で行う。
  //   素材広場のフォルダ作成（resolveProjectFolder）・アップロード（resumable セッション発行含む / PR #804）・
  //   メタ取得・削除フォールバックはすべて SA 所有のため、適用（フォルダ階層作成＋移動/リネーム）も
  //   同一人格に揃える。以前は user OAuth（drive.file スコープ）で適用していたが、drive.file は
  //   「アプリ自身が作成/開いたファイル」しか触れないため、SA が作った共有ドライブのフォルダ/ファイルは
  //   「存在しない」扱いとなり Drive API が 404「File not found」を返していた（再適用が必ず失敗する原因）。
  let saDrive;
  try {
    saDrive = await driveLib.getDriveService();
  } catch (e) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'apply_failed',
        error_message: `Drive 認証に失敗しました（管理者向け: GOOGLE_SERVICE_ACCOUNT_KEY を確認してください）: ${e?.message || e}`,
      })
      .eq('id', item.id);
    return { ok: false, status: 'apply_failed', error: 'service-account-unavailable' };
  }

  // ルートフォルダ（素材広場アップロードフォルダ）配下に階層を作る。
  //
  // ⚠️ ここで item.current_parent_folder_id へフォールバックしてはいけない。
  //   resolveProjectFolder / ensureFolderPath はこの rootFolderId 直下に
  //   「クライアント/案件」や AI タグ階層を *作成* する。素材が既に案件フォルダ内に
  //   ある状態で（＝再適用時など）current_parent_folder_id をルートにすると、
  //   案件フォルダの *中* にもう一段「クライアント/案件」を作ってしまい、
  //   素材が二重ネストのフォルダへ隔離される（実例: ショート動画/ストリート占い四柱推命はっすい/ショート動画）。
  //   構造ルートは常に設定された素材広場ルートでなければならない。未設定なら適用失敗で止める。
  const rootFolderId = process.env.VIDEO_ORG_UPLOAD_FOLDER_ID
    || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
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
    // 1) 配置先フォルダとファイル名を決定する。
    //    - 案件あり (project_id): 「クライアント > 案件」フォルダ直下に配置する。
    //      AI 提案のタグ階層 (recommended_folder) は作らない。ファイル名には撮影日を必ず含める。
    //    - 案件なし: 従来どおり AI 提案フォルダ (recommended_folder) の階層を素材広場ルート直下に作る。
    let finalFolderId;
    let created = [];
    let desiredName = item.recommended_filename;
    let appliedFolderLabel = item.recommended_folder; // 監査用の「配置先」表示
    let appliedParentName;

    if (item.project_id) {
      let proj;
      try {
        proj = await resolveProjectFolder(item.project_id, rootFolderId);
      } catch (e) {
        await supabase.from('video_file_organization_tests')
          .update({
            status: 'apply_failed',
            error_message: `案件フォルダの解決に失敗しました: ${e?.message || e}`,
          })
          .eq('id', item.id);
        return { ok: false, status: 'apply_failed', error: 'project-folder-unresolved' };
      }
      finalFolderId = proj.folderId;
      appliedParentName = proj.projectName;
      appliedFolderLabel = `${proj.clientName}/${proj.projectName}`;
      // 撮影日を必ずファイル名に含める（日付単位で素材を見分けられるように）
      desiredName = ensureShootDateInFilename(item.recommended_filename, {
        originalFilename: item.original_filename,
        createdAtISO: item.created_at,
      });
    } else {
      const ensured = await ensureFolderPath(
        saDrive, rootFolderId, item.recommended_folder
      );
      finalFolderId = ensured.finalFolderId;
      created = ensured.created;
      appliedParentName = item.recommended_folder.split('/').pop() || null;
    }

    // 振り分け先フォルダに anyone-with-link reader を付与する。
    // 素材広場の素材は共有ドライブ上にあり SA だけがアクセス権を持つため、
    // 個人 Google アカウント（共有ドライブ非メンバー）が UI の「📁 Drive フォルダ」
    // 直リンクを踏むと「アクセス権が必要です」になっていた。フォルダ単位で公開すると
    // 配下のファイルも継承で開ける。失敗しても apply 本体は止めない（fire-and-forget 相当）。
    await grantAnyoneReader(saDrive, finalFolderId);

    // 2) 衝突回避済みファイル名
    const finalName = await resolveFilenameCollision(
      saDrive, finalFolderId, desiredName, item.drive_file_id
    );

    // 3) 原本を移動 + リネーム
    await moveAndRename(saDrive, item.drive_file_id, {
      newName: finalName,
      newParentId: finalFolderId,
      oldParentId: item.current_parent_folder_id,
    });

    // 4) プレビュー webp / faststart も同じフォルダへ移動し、原本と同じベース名に揃える。
    //    素材広場ではセット判別のため、派生ファイルは原本と同じベース名で並ぶ必要がある
    //    （例: 原本 ..._Log.mp4 → プレビュー ..._Log.webp）。移動とリネームを 1 回の update で行う。
    //    プレビューも SA 所有のため、原本と同じ SA クライアントで操作する。
    //    失敗しても致命ではない（解析・再生は drive_file_id 経由でも可能）ので status='applied' は維持。
    const derivedIds = [item.preview_drive_file_id, item.faststart_drive_file_id].filter(Boolean);
    for (const derivedId of derivedIds) {
      try {
        const previewMeta = await saDrive.files.get({
          fileId: derivedId,
          fields: 'id,name,parents',
          supportsAllDrives: true,
        });
        const previewParent = previewMeta.data?.parents?.[0] || null;
        const curName = previewMeta.data?.name || '';
        const nextName = driveLib.deriveMatchingPreviewName(finalName, curName);
        const requestBody = {};
        if (nextName && nextName !== curName) requestBody.name = nextName;
        const opts = { fileId: derivedId, fields: 'id,name,parents', supportsAllDrives: true };
        if (previewParent !== finalFolderId) {
          opts.addParents = finalFolderId;
          if (previewParent) opts.removeParents = previewParent;
        }
        if (requestBody.name || opts.addParents) {
          await saDrive.files.update({ ...opts, requestBody });
        }
      } catch (previewMoveErr) {
        console.warn('[video-org] auto-apply: preview move/rename skipped:', previewMoveErr.message);
      }
    }

    // 5) DB 更新
    const newParentName = appliedParentName;
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
        to_folder: appliedFolderLabel,
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

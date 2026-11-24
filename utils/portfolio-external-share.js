// utils/portfolio-external-share.js
// 🌐 みんなのポートフォリオ（ADR 045）で、HFS の Drive に直送したファイル（source_type='upload'）の
// 「リンクを知っている全員が閲覧可」（anyone-reader）を付け外しする（#1198 のレビュー対応）。
//
//   - 付けるのは登録が確定したとき（POST /portfolio/external-works）だけ。読み取り（inspect）では付けない。
//     以前は inspect で付けていたため、キャンセル・期限切れ・削除のあとも共有が残っていた。
//   - 付けた権限の ID はファイルの appProperties（hfs_public_perm_id）に記録し、外すときはその権限だけを外す。
//   - 記録が無い古い登録（この修正より前）は、HFS が直送したファイル（appProperties.hfs_kind が
//     portfolio_external）に限って anyone 権限を外す（そのファイルに anyone を付けるのは HFS だけ）。
//   - 外部の Drive 共有 URL（source_type='drive'）は持ち主の共有設定なので、ここでは一切触らない。
//
// drive は googleapis の drive v3 クライアント（テストではモックを渡す）。

const PERM_PROP = 'hfs_public_perm_id';
const UPLOAD_KIND = 'portfolio_external';

function httpStatusOf(e) {
  return Number(e?.code || e?.status || e?.response?.status) || 0;
}

/**
 * anyone-reader を付けて、その権限 ID をファイルに記録する。
 * @returns {Promise<{ ok: boolean, permissionId?: string, error?: string }>}
 */
async function grantPublicRead(drive, fileId) {
  try {
    const p = await drive.permissions.create({
      fileId, supportsAllDrives: true, fields: 'id',
      requestBody: { role: 'reader', type: 'anyone' },
    });
    const permissionId = p?.data?.id || null;
    if (permissionId) {
      try {
        await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { appProperties: { [PERM_PROP]: permissionId } } });
      } catch (e) {
        // 記録に失敗しても、外すときは hfs_kind の印で anyone を外せる
        console.warn('[portfolio/external/share] 権限 ID の記録に失敗:', fileId, e?.message || e);
      }
    }
    return { ok: true, permissionId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * HFS が付けた anyone 権限だけを外す。ファイルが既に無い（404）なら外す物が無いので ok。
 * @returns {Promise<{ ok: boolean, removed: string[], error?: string }>}
 */
async function revokePublicRead(drive, fileId) {
  const removed = [];
  try {
    let meta;
    try {
      meta = await drive.files.get({ fileId, supportsAllDrives: true, fields: 'id, appProperties' });
    } catch (e) {
      if (httpStatusOf(e) === 404) return { ok: true, removed };
      throw e;
    }
    const props = (meta?.data?.appProperties && typeof meta.data.appProperties === 'object') ? meta.data.appProperties : {};
    const recorded = props[PERM_PROP] ? String(props[PERM_PROP]) : null;
    const list = await drive.permissions.list({ fileId, supportsAllDrives: true, fields: 'permissions(id, type, role)' });
    const perms = Array.isArray(list?.data?.permissions) ? list.data.permissions : [];
    let targets;
    if (recorded) targets = perms.filter(p => p && p.id === recorded);
    else if (props.hfs_kind === UPLOAD_KIND) targets = perms.filter(p => p && p.type === 'anyone');
    else targets = [];   // HFS が直送した印の無いファイルの共有には触らない
    for (const p of targets) {
      try {
        await drive.permissions.delete({ fileId, permissionId: p.id, supportsAllDrives: true });
        removed.push(p.id);
      } catch (e) {
        if (httpStatusOf(e) === 404) continue;   // 既に外れている
        throw e;
      }
    }
    if (recorded) {
      try {
        await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { appProperties: { [PERM_PROP]: null } } });
      } catch (e) {
        console.warn('[portfolio/external/share] 権限 ID の記録の消去に失敗:', fileId, e?.message || e);
      }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, removed, error: e?.message || String(e) };
  }
}

module.exports = { PERM_PROP, grantPublicRead, revokePublicRead };

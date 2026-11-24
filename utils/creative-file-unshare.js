// utils/creative-file-unshare.js
// クリエイティブのファイル（creative_files 行）が DB から消えたとき、その Drive ファイルに HFS が付けた
// 「リンクを知っている全員が閲覧可」（anyone-reader）を外す（2026-11-24）。
//
// 背景:
//   アップロード（routes/haruka.js の 2 か所）・GET /files/:id/direct-url・lib/faststart.js は、再生のために
//   Drive ファイルへ anyone-reader を付ける。ところがクリエイティブの削除・版の差し替え・取り消しのときに
//   外していなかったので、HFS から消えたファイルが公開のまま 619 件たまっていた。
//
// 方針:
//   - 外すのは DB の削除が確定したあと。外すのに失敗しても削除は成功のまま（ログと自動エラー通知に残す）。
//   - 同じ Drive ファイルをまだ使っている所があれば外さない:
//       creative_files（原本 / 高速化版）・creatives の URL 欄（client_review_url＝lib/drive-share.js のクライアント確認 URL、
//       delivery_url / final_delivery_url / frameio_url＝手で貼る納品・確認用リンク）・
//       素材広場（video_file_organization_tests の原本 / プレビュー / 高速化版）・みんなのポートフォリオ（未削除の外部作品）
//     確認に失敗したら「使っているかもしれない」とみなして外さない（安全側）。
//   - 外すのは type=anyone / role=reader で、フォルダから引き継いだのではない（ファイル自身に付いた）権限だけ。
//     HFS が付けるのはこの形だけなので、持ち主が付けた編集権限や共有ドライブのメンバー権限には触らない。
//     ただし HFS は付けた権限の ID を記録していないため、誰かが Drive 上で手で「リンクを知っている全員（閲覧者）」に
//     したものも同じ形で外れる（HFS から消えたファイルなので外れてよい、という判断）。
//   - 案件削除などで「削除前に読んだ一覧」と実際の連鎖削除の間に登録されたファイルは対象から漏れうる（ごく短い間の競合）。
//
// supabase / drive はテストで偽物を渡せるよう引数で受け取る。

// Drive のファイル ID に使われる文字だけを許す（PostgREST の or() に埋め込むため。外れる ID は「使用中」扱いで触らない）
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const IN_CHUNK = 50;      // .in() の URL 長を抑える
const LIKE_CHUNK = 10;    // URL 欄の ilike を or() でまとめる ID の数（列数 × ID 数の条件になる）
// creatives の URL 欄のうち、Drive のファイルリンクが入りうるもの（client_review_url は lib/drive-share.js が自動で入れる。
// 残りはメンバーが手で貼る納品・確認用リンク）。ここに同じファイルがあれば外部に渡したリンクなので外さない
const CREATIVE_URL_COLS = ['client_review_url', 'delivery_url', 'final_delivery_url', 'frameio_url'];
const CONCURRENCY = 4;    // Drive API を同時に叩く数

function httpStatusOf(e) {
  return Number(e?.code || e?.status || e?.response?.status) || 0;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** creative_files 行の配列から Drive ファイル ID（原本 + 高速化版）を重複なしで取り出す */
function collectDriveIds(rows) {
  const ids = new Set();
  for (const r of (rows || [])) {
    if (!r) continue;
    if (r.drive_file_id) ids.add(String(r.drive_file_id));
    if (r.faststart_drive_file_id) ids.add(String(r.faststart_drive_file_id));
  }
  return [...ids];
}

/**
 * ids のうち、まだどこかで使われている ID の集合を返す。問い合わせに失敗したら throw（呼び出し側で外さない）。
 */
async function findStillReferencedIds(supabase, ids) {
  const used = new Set();
  const safe = ids.filter(id => DRIVE_ID_RE.test(id));
  ids.filter(id => !DRIVE_ID_RE.test(id)).forEach(id => used.add(id));
  if (safe.length === 0) return used;

  const must = (r, what) => {
    if (r && r.error) throw new Error(`${what} の確認に失敗: ${r.error.message || r.error}`);
    return Array.isArray(r?.data) ? r.data : [];
  };
  const markCols = (rows, cols) => {
    for (const row of rows) for (const c of cols) if (row && row[c]) used.add(String(row[c]));
  };

  for (const part of chunk(safe, IN_CHUNK)) {
    const list = part.join(',');
    const [cfA, cfB, vot, pew] = await Promise.all([
      supabase.from('creative_files').select('drive_file_id').in('drive_file_id', part),
      supabase.from('creative_files').select('faststart_drive_file_id').in('faststart_drive_file_id', part),
      supabase.from('video_file_organization_tests')
        .select('drive_file_id, faststart_drive_file_id, preview_drive_file_id')
        .or(`drive_file_id.in.(${list}),faststart_drive_file_id.in.(${list}),preview_drive_file_id.in.(${list})`),
      supabase.from('portfolio_external_works').select('drive_file_id').in('drive_file_id', part).is('deleted_at', null),
    ]);
    markCols(must(cfA, 'creative_files'), ['drive_file_id']);
    markCols(must(cfB, 'creative_files(高速化版)'), ['faststart_drive_file_id']);
    markCols(must(vot, '素材広場'), ['drive_file_id', 'faststart_drive_file_id', 'preview_drive_file_id']);
    // みんなのポートフォリオの表がまだ無い環境（migration 未適用）では使用中の作品も無いので無視する
    if (pew && pew.error && !/42P01|PGRST205|does not exist|Could not find the table/i.test(`${pew.error.code || ''} ${pew.error.message || ''}`)) {
      must(pew, 'みんなのポートフォリオ');
    }
    if (pew && !pew.error) markCols(pew.data || [], ['drive_file_id']);
  }

  // クライアント確認 URL（webViewLink に ID が入る）と、手で貼る納品・確認用 URL。部分一致で探す
  for (const part of chunk(safe, LIKE_CHUNK)) {
    const r = await supabase.from('creatives').select(CREATIVE_URL_COLS.join(', '))
      .or(part.flatMap(id => CREATIVE_URL_COLS.map(c => `${c}.ilike.*${id}*`)).join(','));
    const rows = must(r, 'クリエイティブの URL 欄');
    for (const row of rows) {
      const text = CREATIVE_URL_COLS.map(c => String(row?.[c] || '')).join(' ');
      for (const id of part) if (text.includes(id)) used.add(id);
    }
  }
  return used;
}

/**
 * HFS が付けた形の anyone-reader（ファイル自身に付いたもの）だけを外す。
 * ファイルが無い（404）なら外す物が無いので ok。
 * @returns {Promise<{ ok: boolean, removed: string[], gone?: boolean, error?: string }>}
 */
async function revokeAnyoneReader(drive, fileId) {
  const removed = [];
  try {
    let list;
    try {
      list = await drive.permissions.list({
        fileId, supportsAllDrives: true,
        fields: 'permissions(id,type,role,permissionDetails(inherited))',
      });
    } catch (e) {
      if (httpStatusOf(e) === 404) return { ok: true, removed, gone: true };
      throw e;
    }
    const perms = Array.isArray(list?.data?.permissions) ? list.data.permissions : [];
    const targets = perms.filter(p => p && p.type === 'anyone' && p.role === 'reader'
      // 共有ドライブでフォルダから引き継いだ権限はファイル側では外せない（フォルダの設定）ので触らない
      && !(Array.isArray(p.permissionDetails) && p.permissionDetails.length > 0
        && p.permissionDetails.every(d => d && d.inherited === true)));
    for (const p of targets) {
      try {
        await drive.permissions.delete({ fileId, permissionId: p.id, supportsAllDrives: true });
        removed.push(p.id);
      } catch (e) {
        if (httpStatusOf(e) === 404) continue;   // 既に外れている
        throw e;
      }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, removed, error: e?.message || String(e) };
  }
}

async function runPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i; i += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * 消えた creative_files 行の Drive ファイルについて、ほかで使われていなければ anyone-reader を外す。
 * 例外は投げない（呼び出し側の削除処理を巻き込まない）。
 *
 * @param {object} opts
 * @param {object}   opts.supabase
 * @param {Function} opts.getDrive      async () => drive v3 クライアント
 * @param {object[]} [opts.rows]        消えた creative_files 行（drive_file_id / faststart_drive_file_id）
 * @param {string[]} [opts.driveIds]    直接 ID を渡す場合
 * @param {string}   opts.reason        ログ・通知に出す経路名（例: 'creatives-bulk-delete'）
 * @param {Function} [opts.notifyError] async (payload) => void。自動エラー通知（notifyAutoError）
 * @param {Function} [opts.onRevoked]   (fileId) => void。外した／既に無いファイル ID（付与済みキャッシュの掃除用）
 * @param {object}   [opts.logger]      console 互換
 * @returns {Promise<{ ok: boolean, checked: number, skippedInUse: number, revoked: string[], gone: number, failed: Array<{fileId:string,error:string}>, error?: string }>}
 */
async function revokeSharingForRemovedFiles(opts) {
  const {
    supabase, getDrive, rows, driveIds, reason = 'unknown',
    notifyError = null, onRevoked = null, logger = console,
  } = opts || {};
  const summary = { ok: true, checked: 0, skippedInUse: 0, revoked: [], gone: 0, failed: [] };
  const notify = (message, extra) => {
    if (typeof notifyError !== 'function') return;
    try {
      Promise.resolve(notifyError({
        source: 'server',
        kind: 'drive-unshare-failed',
        message: `[${reason}] ${message}`,
        // 通知文面に出るのは stack 欄なので、対象のファイル ID はここに入れる
        stack: extra ? JSON.stringify(extra).slice(0, 3000) : null,
      })).catch(() => {});
    } catch (_) { /* 通知の失敗で巻き込まない */ }
  };
  try {
    const ids = [...new Set([...(collectDriveIds(rows)), ...((driveIds || []).filter(Boolean).map(String))])];
    summary.checked = ids.length;
    if (ids.length === 0) return summary;

    let used;
    try {
      used = await findStillReferencedIds(supabase, ids);
    } catch (e) {
      // 使用中か分からないものは外さない
      summary.ok = false;
      summary.error = e?.message || String(e);
      logger.warn(`[drive-unshare] ${reason}: 使用中かの確認に失敗したため公開設定を外していません (${ids.length} 件): ${summary.error}`);
      notify(`使用中かの確認に失敗したため Drive の公開設定を外していません（${ids.length} 件）: ${summary.error}`, { fileIds: ids.slice(0, 50) });
      return summary;
    }
    const targets = ids.filter(id => !used.has(id));
    summary.skippedInUse = ids.length - targets.length;
    if (targets.length === 0) return summary;

    let drive;
    try {
      drive = await getDrive();
    } catch (e) {
      summary.ok = false;
      summary.error = e?.message || String(e);
      logger.warn(`[drive-unshare] ${reason}: Drive に接続できず公開設定を外していません (${targets.length} 件): ${summary.error}`);
      notify(`Drive に接続できず公開設定を外していません（${targets.length} 件）: ${summary.error}`, { fileIds: targets.slice(0, 50) });
      return summary;
    }

    await runPool(targets, CONCURRENCY, async (fileId) => {
      const r = await revokeAnyoneReader(drive, fileId);
      if (!r.ok) { summary.failed.push({ fileId, error: r.error }); return; }
      if (r.gone) summary.gone += 1;
      if (r.removed.length > 0) summary.revoked.push(fileId);
      if (typeof onRevoked === 'function') { try { onRevoked(fileId); } catch (_) {} }
    });

    if (summary.revoked.length > 0) {
      logger.info(`[drive-unshare] ${reason}: 公開設定を外しました ${summary.revoked.length} 件`, { fileIds: summary.revoked.slice(0, 50) });
    }
    if (summary.failed.length > 0) {
      summary.ok = false;
      logger.warn(`[drive-unshare] ${reason}: 公開設定を外せなかったファイル ${summary.failed.length} 件`, summary.failed.slice(0, 20));
      notify(`Drive の公開設定を外せなかったファイルが ${summary.failed.length} 件あります（DB の削除は完了済み）: ${summary.failed[0].error}`, { failed: summary.failed.slice(0, 50) });
    }
    return summary;
  } catch (e) {
    summary.ok = false;
    summary.error = e?.message || String(e);
    logger.warn(`[drive-unshare] ${reason}: 予期しない失敗: ${summary.error}`);
    notify(`公開設定の解除で予期しない失敗: ${summary.error}`);
    return summary;
  }
}

module.exports = {
  DRIVE_ID_RE,
  collectDriveIds,
  findStillReferencedIds,
  revokeAnyoneReader,
  revokeSharingForRemovedFiles,
};

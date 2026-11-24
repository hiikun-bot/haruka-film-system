// utils/creative-zip-targets.js
// クリエイティブ一覧の「⬇ まとめてDL」（#1318）で使う純関数。レビュー対応で切り出した。
//
//   - fetchAllRows: PostgREST は 1 回の問い合わせで既定 1000 行までしか返さない。修正履歴の多い案件だと
//     creative_files が 1000 行を超え、黙って切れる（最新版のつもりで旧版を入れる・取りこぼす）ので、
//     range でページを分けて最後まで取る。
//   - pickLatestFileByCreative: 各クリエイティブの最新版（version 最大 → uploaded_at 新しい → id）を選ぶ。
//   - summarizeZipTargets: 件数・合計容量・上限超過・容量が確かめられないファイルをまとめる。
//     容量が分からないファイルを 0 と数えると 1GB の上限が保証できないので、1 件でもあれば止める（blocked）。

const PAGE_SIZE = 1000;

/**
 * @param {(from:number, to:number) => PromiseLike<{data:any[]|null, error:any}>} fetchPage
 *   from〜to（両端含む）の行を返す。安定した並び順（order）を付けておくこと。
 * @param {{ pageSize?: number, maxPages?: number }} [opts]
 */
//   サーバー側の上限（max rows）が pageSize より小さくても切れないよう、「空のページが返るまで」読み、
//   次の開始位置は実際に返ってきた行数だけ進める。
async function fetchAllRows(fetchPage, { pageSize = PAGE_SIZE, maxPages = 1000 } = {}) {
  const rows = [];
  let from = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message || String(error));
    const got = data || [];
    if (!got.length) return rows;
    rows.push(...got);
    from += got.length;
  }
  throw new Error('行数が多すぎて最後まで読み切れませんでした');
}

function isNewerFile(f, cur) {
  const fv = Number(f.version) || 0;
  const cv = Number(cur.version) || 0;
  if (fv !== cv) return fv > cv;
  const fu = String(f.uploaded_at || '');
  const cu = String(cur.uploaded_at || '');
  if (fu !== cu) return fu > cu;
  return String(f.id || '') > String(cur.id || '');   // 同時刻でも結果が毎回同じになるように
}

/** @returns {Map<string, object>} creative_id -> 最新のファイル行 */
function pickLatestFileByCreative(files) {
  const latest = new Map();
  for (const f of files || []) {
    if (!f || !f.creative_id || !f.drive_file_id) continue;
    const cur = latest.get(f.creative_id);
    if (!cur || isNewerFile(f, cur)) latest.set(f.creative_id, f);
  }
  return latest;
}

/**
 * @param {Array<{file_size?:number, size_unknown?:boolean, downloadName?:string}>} targets
 * @param {{ creatives: number, maxBytes: number }} opts
 */
//   容量が「分からない」= size_unknown（Drive に聞けなかった）か file_size が無い。0 バイトは分かっている扱い
//   （空ファイル・Google ドキュメント等の size が無いファイルは、Drive に聞いて確かめた上で 0 にしてある）。
function isSizeKnown(t) {
  if (!t || t.size_unknown) return false;
  if (t.file_size === null || t.file_size === undefined || t.file_size === '') return false;
  const n = Number(t.file_size);
  return Number.isFinite(n) && n >= 0;
}

function summarizeZipTargets(targets, { creatives, maxBytes }) {
  const list = targets || [];
  const unknown = list.filter(t => !isSizeKnown(t));
  const totalBytes = list.reduce((s, t) => s + (isSizeKnown(t) ? Number(t.file_size) : 0), 0);
  return {
    creatives,
    files: list.length,
    without_file: Math.max(0, creatives - list.length),
    total_bytes: totalBytes,
    max_bytes: maxBytes,
    too_large: totalBytes > maxBytes,
    unreadable: unknown.length,
    unreadable_names: unknown.slice(0, 10).map(t => t.downloadName || t.generated_name || t.original_name || t.drive_file_id || ''),
    // 容量が確かめられないファイルがあると上限を守れないので、ZIP を作らない
    blocked: unknown.length > 0,
  };
}

// Drive への問い合わせで、待てば通る失敗か（レート制限・一時的なサーバーエラー・タイムアウト）
function isTransientDriveError(e) {
  const code = Number(e?.code || e?.status || e?.response?.status) || 0;
  if (code === 429 || code >= 500) return true;
  const reasons = (e?.errors || e?.response?.data?.error?.errors || []).map(x => String(x?.reason || ''));
  if (code === 403 && reasons.some(r => /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(r))) return true;
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|timeout/i.test(String(e?.message || ''));
}

/**
 * Drive のファイル容量を聞く。一時的な失敗は少し待って取り直す。
 * @returns {Promise<{ known: true, size: number } | { known: false }>}
 */
async function lookupDriveSize(getMeta, { retries = 2, waitMs = 500, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const meta = await getMeta();
      const n = Number(meta?.data?.size);
      // size が無い（Google ドキュメント等）・0 バイトは「確かめた上で 0」
      return { known: true, size: Number.isFinite(n) && n > 0 ? n : 0 };
    } catch (e) {
      if (attempt < retries && isTransientDriveError(e)) { await sleep(waitMs * (attempt + 1)); continue; }
      return { known: false };
    }
  }
}

module.exports = { PAGE_SIZE, fetchAllRows, pickLatestFileByCreative, summarizeZipTargets, isSizeKnown, isTransientDriveError, lookupDriveSize };

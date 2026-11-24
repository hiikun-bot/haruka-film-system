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
async function fetchAllRows(fetchPage, { pageSize = PAGE_SIZE, maxPages = 1000 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message || String(error));
    const got = data || [];
    rows.push(...got);
    if (got.length < pageSize) return rows;
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
function summarizeZipTargets(targets, { creatives, maxBytes }) {
  const list = targets || [];
  const unknown = list.filter(t => t.size_unknown || !(Number(t.file_size) > 0));
  const totalBytes = list.reduce((s, t) => s + (Number(t.file_size) > 0 ? Number(t.file_size) : 0), 0);
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

module.exports = { PAGE_SIZE, fetchAllRows, pickLatestFileByCreative, summarizeZipTargets };

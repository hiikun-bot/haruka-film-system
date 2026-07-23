// lib/portfolio-poster.js
// =====================================================
// 作品ギャラリー用のポスター（動画サムネ）生成
//
// なぜ必要か:
//   Drive が自動生成する thumbnailLink は「動画の冒頭付近のフレーム」なので、
//   冒頭が黒フェードの動画だとサムネが真っ黒になる。ギャラリーで並べると
//   ファイル未登録カードと見分けが付かず、作品として成立しない。
//
// 方針:
//   1. まず Drive のサムネをそのまま使う（速い・追加コストゼロ）
//   2. そのサムネが「ほぼ単色（＝黒）」と判定されたときだけ ffmpeg で作り直す
//      - ffmpeg の thumbnail フィルタは指定フレーム数の中から「代表的な1枚」を選ぶ。
//        真っ黒・単調なフレームは自然に避けられるので、狙ったことがそのまま実現できる
//   3. 生成したポスターは一時ディレクトリにキャッシュ（デプロイで消えるが作り直せる）
//
// 単色判定にデコードは使わない:
//   JPEG は情報量が少ないほどファイルが小さくなる。=s800 のサムネが数KBしか無い時点で
//   ほぼ単色（＝黒画面）と判断できる。デコーダを足さずに済むので依存も増えない。
// =====================================================

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let ffmpeg = null;
try {
  const ffmpegPath = require('ffmpeg-static');
  ffmpeg = require('fluent-ffmpeg');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch (_) { /* ffmpeg が無い環境では生成せず Drive サムネのままにする */ }

// =s800 のサムネがこのサイズ未満なら「ほぼ単色＝黒」とみなす。
// 実測: 真っ黒の 800px JPEG は 2〜5KB、絵が入っていれば 30KB 以上になる。
const BLACK_THUMB_MAX_BYTES = 9000;

// ffmpeg に渡すために先頭から落とすバイト数。faststart 済み（moov が先頭）の mp4 なら
// これだけで冒頭数十秒がデコードできる。moov が末尾のファイルは解析に失敗するので
// Drive サムネへフォールバックする（＝壊れるより黒いまま出す）。
const PREFIX_BYTES = 12 * 1024 * 1024;

// 同時に走らせる ffmpeg の数。埋まっているときは生成せず Drive サムネを返し、
// 次のリクエストで作られるのを待つ（リクエストを待たせない）
const MAX_CONCURRENT = 2;
let running = 0;

// 生成に失敗したファイルを一定時間覚えておき、毎回叩き直さない
const failedUntil = new Map(); // creativeFileId -> 再試行してよい時刻(ms)
const FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// 同じファイルへの同時リクエストは1本にまとめる。ギャラリーは同じサムネURLを
// 複数リクエストが同時に叩きうるので、まとめないと同じ動画を何本も落としに行く
const inflight = new Map(); // cacheKey -> Promise<string|null>

// 「今は混んでいて作れなかった」ぶんを背景で作るための待ち行列。
// リクエストは待たせず 404 を返し、フロントの再取得でここで作られた物を拾わせる。
const queue = [];            // { drive, driveFileId, cacheKey }
const queued = new Set();    // cacheKey
const QUEUE_MAX = 200;

const CACHE_DIR = path.join(os.tmpdir(), 'haruka-portfolio-posters');

function cachePathFor(cacheKey) {
  return path.join(CACHE_DIR, `${String(cacheKey).replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`);
}

function isAvailable() { return !!ffmpeg; }

/** Drive サムネのバイト列が「ほぼ単色（＝黒）」かどうか。maxBytes は配信サイズに応じて呼び出し側が調整する */
function looksBlank(buf, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : BLACK_THUMB_MAX_BYTES;
  return !!buf && buf.length > 0 && buf.length < limit;
}

/** キャッシュ済みポスターがあればそのパスを返す */
function getCachedPoster(cacheKey) {
  try {
    const p = cachePathFor(cacheKey);
    return fs.existsSync(p) ? p : null;
  } catch (_) { return null; }
}

/**
 * Drive の動画から代表フレームを1枚抜き出してキャッシュする。
 * @param {object} opts
 * @param {object} opts.drive        googleapis の drive クライアント
 * @param {string} opts.driveFileId  Drive のファイルID（faststart 版があればそちらを渡す）
 * @param {string} opts.cacheKey     creative_files.id（キャッシュのキー）
 * @returns {Promise<string|null>} 生成できたポスターのパス。できなければ null
 */
async function generatePoster({ drive, driveFileId, cacheKey }) {
  if (!ffmpeg || !drive || !driveFileId) return null;

  const cached = getCachedPoster(cacheKey);
  if (cached) return cached;

  const until = failedUntil.get(cacheKey) || 0;
  if (Date.now() < until) return null;

  // 既に同じファイルを生成中なら、その結果に相乗りする（Drive を二重に叩かない）
  const already = inflight.get(cacheKey);
  if (already) return already;

  if (running >= MAX_CONCURRENT) return null;   // 混んでいる時は諦めて Drive サムネのまま

  const p = _runGeneration({ drive, driveFileId, cacheKey });
  inflight.set(cacheKey, p);
  p.finally(() => { inflight.delete(cacheKey); _pumpQueue(); });
  return p;
}

/**
 * 背景で作らせたいときに使う。作れる状態なら生成を始め、混んでいれば待ち行列に積む。
 * 呼び出し側は待たない（＝リクエストを止めない）。
 */
function queuePoster({ drive, driveFileId, cacheKey }) {
  if (!ffmpeg || !drive || !driveFileId || !cacheKey) return;
  if (getCachedPoster(cacheKey)) return;
  if (Date.now() < (failedUntil.get(cacheKey) || 0)) return;   // 失敗直後は積まない
  if (inflight.has(cacheKey) || queued.has(cacheKey)) return;  // 二重に積まない
  if (queue.length >= QUEUE_MAX) return;                       // 溜まりすぎたら諦める（次の閲覧で拾う）
  queued.add(cacheKey);
  queue.push({ drive, driveFileId, cacheKey });
  _pumpQueue();
}

/** 空きスロットぶんだけ待ち行列から取り出して生成する */
function _pumpQueue() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    queued.delete(job.cacheKey);
    if (getCachedPoster(job.cacheKey) || inflight.has(job.cacheKey)) continue;
    const p = _runGeneration(job);
    inflight.set(job.cacheKey, p);
    p.finally(() => { inflight.delete(job.cacheKey); _pumpQueue(); });
  }
}

async function _runGeneration({ drive, driveFileId, cacheKey }) {
  running += 1;
  const tmpVideo = path.join(CACHE_DIR, `src-${String(cacheKey).replace(/[^a-zA-Z0-9_-]/g, '')}.bin`);
  const outPath  = cachePathFor(cacheKey);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    await downloadPrefix(drive, driveFileId, tmpVideo, PREFIX_BYTES);
    await extractRepresentativeFrame(tmpVideo, outPath);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('ポスターが生成されませんでした');
    return outPath;
  } catch (e) {
    console.warn('[portfolio-poster] 生成失敗:', driveFileId, e.message);
    failedUntil.set(cacheKey, Date.now() + FAIL_COOLDOWN_MS);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    return null;
  } finally {
    running -= 1;
    try { if (fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo); } catch (_) {}
  }
}

/** Drive から先頭 maxBytes だけ落として保存する（全体をダウンロードしない） */
function downloadPrefix(drive, fileId, destPath, maxBytes) {
  return new Promise((resolve, reject) => {
    drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    ).then(res => {
      const out = fs.createWriteStream(destPath);
      let written = 0;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        try { res.data.destroy(); } catch (_) {}
        out.end(() => (err ? reject(err) : resolve(destPath)));
      };
      res.data.on('data', chunk => {
        written += chunk.length;
        out.write(chunk);
        if (written >= maxBytes) finish(null);   // 必要な分だけ取ったら切る
      });
      res.data.on('end', () => finish(null));
      res.data.on('error', finish);
    }).catch(reject);
  });
}

/**
 * thumbnail フィルタで「代表的な1枚」を抜く。
 * thumbnail=300 は 300 フレーム（30fps なら約10秒ぶん）を見比べて最も特徴のある
 * フレームを選ぶので、冒頭の黒フェードは自動的に外れる。
 */
function extractRepresentativeFrame(srcPath, outPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(srcPath)
      .outputOptions([
        '-vf', "thumbnail=300,scale='min(800,iw)':-2",
        '-frames:v', '1',
        '-q:v', '4',
        '-an',
      ])
      .output(outPath)
      .on('end', () => resolve(outPath))
      .on('error', err => reject(err));
    // 壊れたファイル等で固まらないよう保険
    const timer = setTimeout(() => {
      try { cmd.kill('SIGKILL'); } catch (_) {}
      reject(new Error('ffmpeg タイムアウト'));
    }, 45000);
    cmd.on('end', () => clearTimeout(timer));
    cmd.on('error', () => clearTimeout(timer));
    cmd.run();
  });
}

module.exports = {
  isAvailable,
  looksBlank,
  getCachedPoster,
  generatePoster,
  queuePoster,
  BLACK_THUMB_MAX_BYTES,
};

// haruka.html 配信最適化モジュール
//
// 背景: public/haruka.html は約2.5MBの単一HTML SPA で、うち約1.9MBがインラインJS。
// 体感速度の支配要因は「転送量」と「ブラウザのJSパース時間」なので、
// サーバー起動時にバックグラウンドで
//   1. インライン <script> を terser でミニファイ（コメント除去 + ローカル変数mangle）
//   2. 組み立て後HTMLを brotli / gzip で事前圧縮してメモリ保持
//   3. ETag を計算（If-None-Match 一致なら 304）
// しておき、リクエスト時は Accept-Encoding に応じて即座にバッファを返す。
//
// 安全設計:
// - 準備完了までは従来どおり res.sendFile で元ファイルを配信（起動をブロックしない）
// - ミニファイに失敗したブロックは「元のまま」残す（配信が死なないこと最優先）
// - mangle はローカル変数のみ（toplevel: false）。インライン onclick 等が参照する
//   グローバル関数名・トップレベル宣言は一切変えない
// - type="module" / src 付き <script> は無変換
// - Content-Encoding を自前で付けるため compression ミドルウェアは二重圧縮しない
//   （compression は Content-Encoding 済みレスポンスをスキップする）
// - 認証必須ページなので Cache-Control: private, no-cache（共有キャッシュ禁止・毎回再検証）
// - ファイル mtime の変化を軽量チェック（2秒スロットルの fs.stat）し、変わったら再構築。
//   再構築中は元ファイルの sendFile にフォールバックするので古い内容は配らない

const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const util = require('util');
const crypto = require('crypto');
const { minify } = require('terser');

const brotliCompress = util.promisify(zlib.brotliCompress);
const gzip = util.promisify(zlib.gzip);

const HTML_PATH = path.join(__dirname, '..', 'public', 'haruka.html');

const TERSER_OPTIONS = {
  // ローカル変数のみ短縮。トップレベル（=グローバル）の関数・変数名は
  // インライン onclick / 他scriptブロックから参照されるため絶対に変えない
  mangle: { toplevel: false },
  compress: { defaults: true },
  format: { comments: false },
};

// 事前構築済みの配信データ。null の間は sendFile フォールバック
// { raw, br, gz, etagBase, builtMtimeMs }
let state = null;
let building = false;
let lastStatCheckAt = 0;
const STAT_THROTTLE_MS = 2000;

// <script ...> 開きタグの属性から「無変換で残すべきか」を判定
function shouldSkipScript(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return true; // 外部スクリプト
  const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (typeMatch) {
    const type = (typeMatch[1] || typeMatch[2] || typeMatch[3] || '').trim().toLowerCase();
    // 古典スクリプト以外（module / JSON / template 等）は無変換
    if (type && type !== 'text/javascript' && type !== 'application/javascript') return true;
  }
  return false;
}

// インライン <script> ブロックをミニファイして HTML を再組み立て
async function minifyInlineScripts(html) {
  const scriptRe = /(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/gi;
  const parts = [];
  const jobs = [];
  let lastIndex = 0;
  let match;
  let failedBlocks = 0;
  let minifiedBlocks = 0;

  while ((match = scriptRe.exec(html)) !== null) {
    const [whole, openTag, attrs, code, closeTag] = match;
    parts.push(html.slice(lastIndex, match.index));
    lastIndex = match.index + whole.length;

    if (shouldSkipScript(attrs) || !code.trim()) {
      parts.push(whole);
      continue;
    }

    const slot = parts.length;
    parts.push(whole); // フォールバック値（失敗時はそのまま）
    jobs.push(
      minify(code, TERSER_OPTIONS)
        .then((result) => {
          if (result && typeof result.code === 'string' && result.code.length > 0) {
            parts[slot] = openTag + result.code + closeTag;
            minifiedBlocks++;
          } else {
            failedBlocks++;
          }
        })
        .catch((e) => {
          failedBlocks++;
          console.warn('[haruka-html] script block minify failed (kept original):', e.message);
        })
    );
  }
  parts.push(html.slice(lastIndex));
  await Promise.all(jobs);
  return { html: parts.join(''), minifiedBlocks, failedBlocks };
}

// バックグラウンド構築（並行実行ガード付き・例外は握りつぶしてフォールバック継続）
async function rebuild() {
  if (building) return;
  building = true;
  try {
    const startedAt = Date.now();
    const stat = await fsp.stat(HTML_PATH);
    const original = await fsp.readFile(HTML_PATH, 'utf8');

    const { html, minifiedBlocks, failedBlocks } = await minifyInlineScripts(original);
    const raw = Buffer.from(html, 'utf8');

    // brotli は quality 11（事前圧縮なので時間をかけてよい）。gzip は level 9。
    // 同期版だとイベントループを数秒塞ぐため必ず非同期版を使う。
    const [br, gz] = await Promise.all([
      brotliCompress(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      }),
      gzip(raw, { level: 9 }),
    ]);

    const etagBase = crypto.createHash('sha1').update(raw).digest('hex');
    state = { raw, br, gz, etagBase, builtMtimeMs: stat.mtimeMs };

    const kb = (n) => Math.round(n / 1024) + 'KB';
    console.log(
      `[haruka-html] optimized delivery ready in ${Date.now() - startedAt}ms: ` +
      `original=${kb(Buffer.byteLength(original))} minified=${kb(raw.length)} ` +
      `gzip=${kb(gz.length)} brotli=${kb(br.length)} ` +
      `(blocks: ${minifiedBlocks} minified, ${failedBlocks} kept original)`
    );
  } catch (e) {
    // 構築失敗でも配信は sendFile フォールバックで生き続ける
    state = null;
    console.error('[haruka-html] build failed, falling back to sendFile:', e.message);
  } finally {
    building = false;
  }
}

// mtime 変化チェック（2秒スロットル）。変わっていたら破棄して再構築を開始
async function checkFreshness() {
  if (!state) return;
  const now = Date.now();
  if (now - lastStatCheckAt < STAT_THROTTLE_MS) return;
  lastStatCheckAt = now;
  try {
    const stat = await fsp.stat(HTML_PATH);
    if (stat.mtimeMs !== state.builtMtimeMs) {
      console.log('[haruka-html] source file changed, rebuilding...');
      state = null; // 再構築完了までは元ファイルを配信
      rebuild();
    }
  } catch (_) {
    // stat 失敗は無視（次回リクエストで再確認）
  }
}

// サーバー起動時に呼ぶ。起動はブロックしない（fire & forget）
function init() {
  setImmediate(() => { rebuild(); });
}

// haruka.html を返す全ルートから呼ぶ配信ハンドラ
async function serve(req, res) {
  try {
    await checkFreshness();
    const s = state;
    if (!s) {
      // 構築前 / 構築失敗 / 再構築中は従来どおり元ファイルを配信
      return res.sendFile(HTML_PATH);
    }

    // Accept-Encoding に応じて brotli 優先で選択
    const accept = String(req.headers['accept-encoding'] || '');
    let body = s.raw;
    let encoding = null;
    if (/\bbr\b/.test(accept)) {
      body = s.br;
      encoding = 'br';
    } else if (/\bgzip\b/.test(accept)) {
      body = s.gz;
      encoding = 'gzip';
    }

    // ETag はエンコーディングごとに変える（RFC 9110: 表現が違えば ETag も違う）
    const etag = `"${s.etagBase}${encoding ? '-' + encoding : ''}"`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 認証必須ページのため private。no-cache = 毎回 If-None-Match で再検証（304なら転送ゼロ）
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').map((v) => v.trim()).includes(etag)) {
      return res.status(304).end();
    }

    // Content-Encoding を先に付けることで compression ミドルウェアはスキップされる
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body.length);
    return res.status(200).end(body);
  } catch (e) {
    console.error('[haruka-html] serve error, falling back to sendFile:', e.message);
    if (!res.headersSent) return res.sendFile(HTML_PATH);
  }
}

module.exports = {
  init,
  serve,
  // テスト用に内部を公開
  _minifyInlineScripts: minifyInlineScripts,
  _rebuild: rebuild,
  _getState: () => state,
  _HTML_PATH: HTML_PATH,
};

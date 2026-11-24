'use strict';
// メンバーが上げた画像・ファイルを「同じサイト（HFS のオリジン）」で配信するときの共通部品。
//
// 方針
//   - 画像の種類は送ってきた側の申告（Content-Type / data URL の mime / ファイル名）を信じず、
//     中身の先頭バイト（マジックバイト）で決める。許すのは PNG / JPEG / WebP / GIF だけ。
//     SVG・HTML などはここを通らない（保存時は 400、既存行は配信しない）。
//   - 保存する data URL は「中身から判定した種類＋デコードし直した base64」で組み立て直す
//     （申告の mime や余計なパラメータは捨てる）。
//   - 配信時も保存済みの mime は使わず、中身から判定し直した許可リストの image/* だけを返す。
//     あわせて nosniff / inline / CSP（スクリプト等を一切読ませない）を付ける。
//   - Drive からのプロキシ配信（動画・画像・PDF など種類が多いもの）は
//     safeProxyContentType で許可リスト外を application/octet-stream（ダウンロード扱い）に落とす。

const SAFE_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// 画像レスポンス用の CSP。画像そのものを表示するだけなので、何も読み込ませない・スクリプトを動かさない。
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// プロキシ配信用の CSP。動画・音声の再生を妨げないよう sandbox だけ（スクリプト・フォーム・同一オリジン扱いを止める）。
const PROXY_CSP = 'sandbox';

/** 中身の先頭バイトから画像の種類を判定する。許可リスト外・判定不能なら null。 */
function sniffImageMime(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 12) return null;
  const b = (i) => buf[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47
    && b(4) === 0x0D && b(5) === 0x0A && b(6) === 0x1A && b(7) === 0x0A) return 'image/png';
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  const ascii = (s, e) => String.fromCharCode(...buf.slice(s, e));
  const head6 = ascii(0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// data:<mime>[;param...];base64,<base64>
//   mime は申告なので判定には使わない（形式チェックだけ）。base64 部は文字種を厳密に見る。
const DATA_URL_RE = /^data:([a-zA-Z0-9.+\/-]+)((?:;[a-zA-Z0-9=._+-]+)*);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * 画像の data URL を検証し、中身から判定した種類で組み立て直す。
 * @param {string} dataUrl
 * @param {{maxBytes?: number}} [opts] maxBytes = デコード後のバイト数の上限
 * @returns {{mime: string, buf: Buffer, dataUrl: string} | null}
 */
function parseImageDataUrl(dataUrl, opts = {}) {
  if (typeof dataUrl !== 'string') return null;
  const m = DATA_URL_RE.exec(dataUrl.replace(/\s+/g, ''));
  if (!m) return null;
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) return null;
  if (opts.maxBytes && buf.length > opts.maxBytes) return null;
  const mime = sniffImageMime(buf);
  if (!mime) return null;
  return { mime, buf, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

/**
 * アップロードされたバイト列（multer の file.buffer など）から保存用 data URL を作る。
 * 申告の mimetype は見ない。許可リスト外なら null。
 */
function imageBufferToDataUrl(buf) {
  const mime = sniffImageMime(buf);
  if (!mime) return null;
  return { mime, dataUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}` };
}

/** 画像レスポンスの安全ヘッダーを付ける（Content-Type は呼び出し側が許可リストの値を渡す）。 */
function setSafeImageHeaders(res, mime) {
  if (!SAFE_IMAGE_MIMES.includes(mime)) throw new Error(`unsafe image mime: ${mime}`);
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Security-Policy', IMAGE_CSP);
}

/**
 * DB に保存済みの data URL を画像として配信する。
 * 中身が許可リストの画像でなければ（SVG/HTML の旧行など）配信せず 404。
 * @returns 送信したら true、404 を返したら false
 */
function sendStoredImageDataUrl(res, dataUrl, { cacheControl = 'private, max-age=31536000, immutable' } = {}) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) { res.status(404).end(); return false; }
  setSafeImageHeaders(res, parsed.mime);
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Length', parsed.buf.length);
  res.end(parsed.buf);
  return true;
}

// Drive プロキシでそのまま表示してよい種類。これ以外はダウンロード扱い。
//   SVG は image/svg+xml のまま返す（<img> で表示するため）が、CSP sandbox でスクリプトは動かない。
function isInlineSafeProxyMime(mime) {
  const t = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!t) return false;
  if (/^video\/[a-z0-9.+-]+$/.test(t)) return true;
  if (/^audio\/[a-z0-9.+-]+$/.test(t)) return true;
  if (SAFE_IMAGE_MIMES.includes(t)) return true;
  return ['image/svg+xml', 'image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/tiff', 'application/pdf'].includes(t);
}

/** Drive などから中継するときの Content-Type。許可リスト外は application/octet-stream。 */
function safeProxyContentType(mime) {
  if (!isInlineSafeProxyMime(mime)) return 'application/octet-stream';
  return String(mime).split(';')[0].trim().toLowerCase();
}

/**
 * プロキシ配信の安全ヘッダー。
 *   - nosniff は常に
 *   - 許可リスト外の種類は Content-Disposition: attachment（呼び出し側が既に付けていれば上書きしない）
 *   - PDF 以外は CSP sandbox（Chrome の PDF ビューアは sandbox だと開けないため PDF だけ外す）
 * @returns 実際に使う Content-Type
 */
function applyProxySafetyHeaders(res, mime) {
  const type = safeProxyContentType(mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (type === 'application/octet-stream' && !res.getHeader('Content-Disposition')) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  if (type !== 'application/pdf') res.setHeader('Content-Security-Policy', PROXY_CSP);
  return type;
}

module.exports = {
  SAFE_IMAGE_MIMES,
  IMAGE_CSP,
  PROXY_CSP,
  sniffImageMime,
  parseImageDataUrl,
  imageBufferToDataUrl,
  setSafeImageHeaders,
  sendStoredImageDataUrl,
  isInlineSafeProxyMime,
  safeProxyContentType,
  applyProxySafetyHeaders,
};

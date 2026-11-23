// utils/invoice-receipt.js
// 🧾 立替経費の領収書（写真・PDF）まわりの純関数（ADR 046 追補 2026-11-23）。DB・Drive には触らない。
//
//   - 列（invoice_items.expense_date 〜 receipt_uploaded_at）の一覧と、列がまだ無い環境の見分け
//   - アップロードされたファイルの種類をバイト列の先頭で判定（画面から来た Content-Type は信用しない）
//   - Drive 上のファイル名 `領収書_YYYYMMDD_<内容>_<金額>円.<拡張子>`（ファイル名に使えない文字は置換）
//   - 閲覧の可否（本人 or 請求書を見られる管理者）
//
// 日付の判定は JST 固定（今日の日付は toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })）。
'use strict';

// 1 ファイル 10MB まで（画面で縮小してから送るので、通常は数百 KB）
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

// 立替経費の行に足した列（migrations/2026-11-23_invoice_items_expense_receipt.sql）
const RECEIPT_COLUMNS = [
  'expense_date', 'expense_payee', 'receipt_status', 'receipt_missing_reason',
  'receipt_file_id', 'receipt_file_name', 'receipt_mime_type', 'receipt_uploaded_at',
];
const RECEIPT_SELECT = RECEIPT_COLUMNS.join(', ');

// 受け付けるファイルの種類 → 拡張子
const RECEIPT_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const RECEIPT_MIME_TYPES = Object.keys(RECEIPT_MIME_EXT);

// Drive の「領収書」サブフォルダ名（本人の請求書月フォルダの中。振込管理のスキャンはサブフォルダの中を見ない）
const RECEIPT_FOLDER_NAME = '領収書';

/**
 * 列がまだ無い（migration 未適用）ことによるエラーか。
 * PostgREST は 42703（column ... does not exist）か「Could not find the 'x' column」を返す。
 */
function isMissingReceiptColumnError(err) {
  if (!err) return false;
  const msg = String(err.message || err.details || '');
  const missing = err.code === '42703' || err.code === 'PGRST204'
    || /column .* does not exist/i.test(msg) || /could not find the .* column/i.test(msg);
  // ほかの列が無いエラー（別の migration 未適用）と混ぜない。メッセージには必ず列名が入る
  return missing && RECEIPT_COLUMNS.some(c => msg.includes(c));
}

/**
 * バイト列の先頭でファイルの種類を判定する。対応外は null。
 *   JPEG: FF D8 FF / PNG: 89 50 4E 47 0D 0A 1A 0A / PDF: %PDF-
 *   HEIC/HEIF: 4〜8 バイト目が 'ftyp' で、ブランドが heic/heix/hevc/hevx/heim/heis/mif1/msf1/heif
 */
function sniffReceiptMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = (i) => buf[i];
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47 && b(4) === 0x0D && b(5) === 0x0A && b(6) === 0x1A && b(7) === 0x0A) return 'image/png';
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46 && b(4) === 0x2D) return 'application/pdf';
  const ascii = (s, e) => String.fromCharCode(...buf.slice(s, e));
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}

function extOfMime(mime) {
  return RECEIPT_MIME_EXT[mime] || null;
}

/** ファイル名に使えない文字（/ \ : * ? " < > | 制御文字）を全角や _ に置き換え、空白を詰めて max 文字で切る */
function sanitizeFileNamePart(v, max = 40) {
  let s = String(v ?? '').normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  // 記号だけ（'.._..' など）は名前にしない
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

/** JST の今日 'YYYY-MM-DD' */
function jstToday(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * Drive 上のファイル名。`領収書_YYYYMMDD_<内容>_<金額>円.<拡張子>`
 *   日付: 立替経費の日付（未入力なら JST の今日）
 *   内容: 立替経費の内容（空なら「立替経費」）
 *   金額: 入っていなければ省く
 */
function buildReceiptFileName({ expenseDate, label, amount, mime, now } = {}) {
  const ext = extOfMime(mime) || 'bin';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expenseDate || '')) || /^(\d{4})-(\d{2})-(\d{2})/.exec(jstToday(now));
  const ymd = `${m[1]}${m[2]}${m[3]}`;
  const what = sanitizeFileNamePart(label) || '立替経費';
  const n = Number(amount);
  const yen = (amount !== null && amount !== undefined && amount !== '' && Number.isFinite(n) && n >= 0) ? `_${Math.trunc(n)}円` : '';
  return `領収書_${ymd}_${what}${yen}.${ext}`;
}

/**
 * 領収書を見てよいか。本人（請求書の発行者）か、請求書を見られる管理者（isStaff＝admin/秘書の実効ロール）だけ。
 * 判定の作りは GET /invoices/:id と同じ。
 */
function canViewReceipt({ invoice, userId, isStaff }) {
  if (!invoice || !userId) return false;
  return invoice.issuer_id === userId || !!isStaff;
}

/** Content-Disposition（日本語ファイル名は RFC 5987 で渡す） */
function receiptContentDisposition(name, { download = false } = {}) {
  const safe = String(name || 'receipt');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

module.exports = {
  RECEIPT_MAX_BYTES, RECEIPT_COLUMNS, RECEIPT_SELECT, RECEIPT_MIME_TYPES, RECEIPT_MIME_EXT, RECEIPT_FOLDER_NAME,
  isMissingReceiptColumnError, sniffReceiptMime, extOfMime, sanitizeFileNamePart, jstToday,
  buildReceiptFileName, canViewReceipt, receiptContentDisposition,
};

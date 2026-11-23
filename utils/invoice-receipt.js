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

/**
 * 保存（PUT）で領収書の状態・理由を書いてよいか（古いタブの自動保存で、別の端末が付けた領収書を消さないため）。
 *   prevFileId : DB に今入っている領収書ファイル（無ければ null）
 *   seenFileId : 画面が見ていた領収書ファイル（送られてこなければ null 扱い）
 *   status     : 画面が送ってきた状態（'attached' / 'missing' / null）。undefined は「送っていない」
 * @returns {{ write: boolean, conflict: boolean, clearFile: boolean, dropStatus: boolean }}
 *   write      … receipt_status / receipt_missing_reason を書く
 *   conflict   … 画面が古い（別の画面で領収書が付け替えられた）。何も書かずに「再読み込みして」を返す
 *   clearFile  … 「領収書なし」に切り替えたので、今のファイルを外してゴミ箱へ
 *   dropStatus … ファイルがある行の状態を空（null）に戻そうとしている → 状態は書かない（理由は書く）
 */
function decideReceiptWrite({ prevFileId, seenFileId, status }) {
  const prev = prevFileId || null;
  const seen = seenFileId || null;
  if (prev !== seen) return { write: false, conflict: true, clearFile: false, dropStatus: false };
  const clearFile = !!prev && status === 'missing';
  const dropStatus = !!prev && status === null;
  return { write: true, conflict: false, clearFile, dropStatus };
}

// 一覧（GET /invoices）で、本人でも管理者でもない人には見せない立替経費の項目
const RECEIPT_PRIVATE_FIELDS = ['expense_payee', 'receipt_missing_reason', 'receipt_file_id', 'receipt_file_name', 'receipt_mime_type'];

/** 請求書一覧の 1 件から、立替経費の支払先・理由・ファイルの項目を外す（元のオブジェクトを書き換える） */
function stripPrivateReceiptFields(invoice) {
  for (const it of ((invoice && invoice.invoice_items) || [])) {
    for (const k of RECEIPT_PRIVATE_FIELDS) delete it[k];
  }
  return invoice;
}

/**
 * フォルダ直下にファイル（サブフォルダは数えない）が 1 つ以上あるか。メンバー一覧の「請求書提出済み」表示に使う。
 * 「領収書」サブフォルダだけがある月（領収書を付けたが請求書はまだ）を提出済みにしないため、フォルダを除いて数える。
 * エラー時は false（画面を止めない）
 */
async function checkFolderHasFiles(drive, folderId) {
  if (!folderId) return false;
  try {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(id)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return Array.isArray(r.data.files) && r.data.files.length > 0;
  } catch (e) {
    console.warn(`[invoice-folders] checkFolderHasFiles warn folder=${folderId}: ${e.message}`);
    return false;
  }
}

module.exports = {
  RECEIPT_MAX_BYTES, RECEIPT_COLUMNS, RECEIPT_SELECT, RECEIPT_MIME_TYPES, RECEIPT_MIME_EXT, RECEIPT_FOLDER_NAME,
  RECEIPT_PRIVATE_FIELDS,
  isMissingReceiptColumnError, sniffReceiptMime, extOfMime, sanitizeFileNamePart, jstToday,
  buildReceiptFileName, canViewReceipt, receiptContentDisposition,
  decideReceiptWrite, stripPrivateReceiptFields, checkFolderHasFiles,
};

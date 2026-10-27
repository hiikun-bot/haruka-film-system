// 💸 振込管理（payout）の純関数群
// - Chatwork 定型文の組み立て / 請求書PDFテキストからの請求額抽出 / 差分チェック判定
// - 外部API・DB非依存（routes/haruka.js の /admin/payouts* から遅延 require される）
// - テスト: tests/utils/payout.test.js

// 振込完了メッセージ（定型文＋任意メモ）。
// 宛名行（「◯◯さん」）は付けない（ユーザー指示 2026-08-29: 修正が多いため名前は不要）。
// メモが空/空白のみのときは定型文だけを返す（メモ表記は付けない）。
function buildPayoutMessage({ month, memo }) {
  const m = Number(month);
  const base = [
    '今月もお疲れ様でした！',
    `${m}月分を振り込みましたので、ご確認をお願いします。`,
    'いつも助かっております！',
    '来月もどうぞよろしくお願いいたします！',
  ].join('\n');
  const note = String(memo || '').trim();
  return note ? `${base}\n\n${note}` : base;
}

// 請求書PDF（テキスト化済み）から振り込む額を抽出する。
// 優先0: 「差引お振込額」の直後に現れる最初の金額（ADR 046 新方式＝源泉徴収を引いた後の額。source='sashihiki'）
// 優先1: 「ご請求金額」の直後に現れる最初の金額
// 優先2: 「合計」表記の金額のうち最大値（小計/税額行との混同を避けるため最大値を採る）
// 数字は全角・カンマ混在を許容。100円未満・10億以上は誤検出として棄却。
function extractInvoiceAmount(text) {
  if (!text) return null;
  const normalized = String(text)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ',')
    .replace(/￥/g, '¥');

  const parseNum = (s) => {
    const n = Number(String(s).replace(/[^0-9]/g, ''));
    if (!Number.isFinite(n) || n < 100 || n >= 1e9) return null;
    return n;
  };

  // 見出しの後方 80 文字以内の最初のもっともらしい金額を採る。
  // 「ご請求金額（税込・内税10%）¥6,000」のような税率・日付の数字はスキップする。
  const firstAmountAfter = (tail) => {
    const numRe = /([0-9][0-9,]*)/g;
    let m2;
    while ((m2 = numRe.exec(tail)) !== null) {
      const after = tail.slice(m2.index + m2[1].length);
      if (/^\s*[%％年月日/]/.test(after)) continue; // 税率・年月日はスキップ
      const n = parseNum(m2[1]);
      if (n != null) return n;
    }
    return null;
  };

  // 新方式（税抜＋源泉）の請求書は「差引お振込額」が振り込む額（「ご請求金額（税込）」より優先）。
  // 旧方式の PDF にはこの見出しが無いので、旧方式の抽出結果は変わらない。
  const sashihiki = normalized.match(/差\s*引\s*お?\s*振\s*込\s*額([\s\S]{0,80})/);
  if (sashihiki) {
    // 次の見出し（ご請求金額・源泉・小計・消費税）より後ろの数字は拾わない
    const tail = sashihiki[1].split(/ご\s*請\s*求|源\s*泉|小\s*計|消\s*費\s*税/)[0];
    const n = firstAmountAfter(tail);
    if (n != null) return { amount: n, source: 'sashihiki' };
  }

  const seikyu = normalized.match(/ご\s*請\s*求\s*金\s*額([\s\S]{0,80})/);
  if (seikyu) {
    const n = firstAmountAfter(seikyu[1]);
    if (n != null) return { amount: n, source: 'seikyu' };
  }

  const totals = [];
  const re = /合\s*計[^0-9]{0,30}([0-9][0-9,]*)/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const n = parseNum(m[1]);
    if (n != null) totals.push(n);
  }
  if (totals.length) return { amount: Math.max(...totals), source: 'gokei' };
  return null;
}

// 請求額（税込額面） vs 実制作データ集計（税抜ベースの per-unit 合計）の差分判定。
// 実データは税抜のことが多いため、「額面一致」または「実データ×1.1 ≒ 額面（±1% or ±100円）」
// を match とする。請求額が無ければ unknown。
// taxExclusive=true（ADR 046 新方式: 請求額＝税抜小計）のときは税込換算での一致を見ない
// （税抜小計が実データ×1.1 に一致する＝10% 上乗せ請求を「一致」と誤判定しないため）。
function evaluatePayoutDiff({ invoiceAmount, actualTotal, taxExclusive = false }) {
  const invoice = Number(invoiceAmount);
  const actual = Number(actualTotal) || 0;
  if (!Number.isFinite(invoice) || invoice <= 0) {
    return { status: 'unknown', delta: null, delta_with_tax: null };
  }
  const tolerance = (base) => Math.max(100, Math.round(base * 0.01));
  const delta = invoice - actual;
  if (taxExclusive) {
    return { status: Math.abs(delta) <= tolerance(actual) ? 'match' : 'diff', delta, delta_with_tax: null };
  }
  const withTax = Math.round(actual * 1.1);
  const deltaWithTax = invoice - withTax;
  const match = Math.abs(delta) <= tolerance(actual) || Math.abs(deltaWithTax) <= tolerance(withTax);
  return { status: match ? 'match' : 'diff', delta, delta_with_tax: deltaWithTax };
}

// Drive の個人フォルダ名（例: '安齋 智光 2026年04月' / '井上　さやか 2026年08月'）から
// 氏名部分を取り出して比較用に正規化する（空白全除去）。
function normalizeFolderPersonName(folderName) {
  return String(folderName || '')
    .replace(/\s*\d{4}年\d{1,2}月\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '') // 同姓同名回避の '(emailローカル)' サフィックス
    .replace(/[\s　]+/g, '');
}

function normalizePersonName(name) {
  return String(name || '').replace(/[\s　]+/g, '');
}

// 複数の実データ候補（当月のみ / +前月 / +未納品 / +前月+未納品）に対して請求額を突合し、
// 最初に一致した根拠を返す。どれとも合わなければ当月基準の diff を返す。
function evaluatePayoutDiffMulti({ invoiceAmount, currentTotal, prevTotal, undeliveredTotal, taxExclusive = false }) {
  const cur = Number(currentTotal) || 0;
  const prev = Number(prevTotal) || 0;
  const und = Number(undeliveredTotal) || 0;
  const candidates = [
    { basis: 'current', label: '当月納品分', total: cur },
    { basis: 'current_prev', label: '当月＋前月納品分', total: cur + prev },
    { basis: 'current_undelivered', label: '当月＋未納品先行分', total: cur + und },
    { basis: 'current_prev_undelivered', label: '当月＋前月＋未納品先行分', total: cur + prev + und },
  ];
  for (const c of candidates) {
    const v = evaluatePayoutDiff({ invoiceAmount, actualTotal: c.total, taxExclusive });
    if (v.status === 'match') {
      return { ...v, matched_basis: c.basis, matched_label: c.label, matched_total: c.total };
    }
    if (v.status === 'unknown') return { ...v, matched_basis: null, matched_label: null, matched_total: null };
  }
  const base = evaluatePayoutDiff({ invoiceAmount, actualTotal: cur, taxExclusive });
  return { ...base, matched_basis: null, matched_label: null, matched_total: null };
}

// 請求書PDFテキストから、HFS照合用のクリエイティブキーを抽出する。
// - tails: ファイル名末尾の7桁連番（0始まり。例 0000345）
// - names: 短命名（例 044_bn_1080_1920 のようなハビー型）
// 電話番号・口座番号などの連続数字に埋もれた誤検出を避けるため前後に数字が無いことを要求する。
function extractCreativeKeys(text) {
  const t = String(text || '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  const tails = new Set();
  const names = new Set();
  let m;
  const tailRe = /(?<![0-9])(0[0-9]{6})(?![0-9])/g;
  while ((m = tailRe.exec(t)) !== null) tails.add(m[1]);
  const nameRe = /(?<![0-9_])([0-9]{3}_[A-Za-z]{1,4}_[0-9]{3,4}_[0-9]{3,4})(?![0-9])/g;
  while ((m = nameRe.exec(t)) !== null) names.add(m[1]);
  return { tails: Array.from(tails), names: Array.from(names) };
}

// 同じ請求書（appProperties.hfs_invoice_id）の PDF が複数あるとき、最新改訂（hfs_rev 降順、同点は
// modifiedTime 降順）の 1 枚だけ残す。ADR 047: 請求書システムは PDF を上書きせず新規作成し、旧版の
// ゴミ箱送りが失敗すると同じ請求書の PDF が 2 枚残り得る。その場合でも支払額を二重に数えないための保険。
// hfs_invoice_id の無いファイル（手動アップロード等）はそのまま通す。
// @returns {{ kept: object[], dropped: object[] }}
function dedupeInvoicePdfFiles(files) {
  const kept = [];
  const dropped = [];
  const bestById = new Map(); // hfs_invoice_id -> file
  const rev = (f) => String((f && f.appProperties && f.appProperties.hfs_rev) || '');
  const mod = (f) => String((f && f.modifiedTime) || '');
  for (const f of files || []) {
    const invId = f && f.appProperties && f.appProperties.hfs_invoice_id;
    if (!invId) { kept.push(f); continue; }
    const cur = bestById.get(invId);
    if (!cur) { bestById.set(invId, f); continue; }
    const newer = rev(f) !== rev(cur) ? rev(f) > rev(cur) : mod(f) > mod(cur);
    if (newer) { dropped.push(cur); bestById.set(invId, f); }
    else dropped.push(f);
  }
  for (const f of bestById.values()) kept.push(f);
  return { kept, dropped };
}

// ---------- ADR 046 Stage 4: 新方式（税抜＋源泉）の請求書と振込管理 ----------

// 金額の出どころのうち「請求書の振込額そのもの」として合算してよいもの。
//   hfs_db    : HFS 製 PDF（appProperties.hfs_invoice_id）の請求書を DB で引いた payout_amount（新方式）
//   sashihiki : PDF の「差引お振込額」
//   seikyu    : PDF の「ご請求金額」（旧方式）
const AUTHORITATIVE_AMOUNT_SOURCES = ['hfs_db', 'sashihiki', 'seikyu'];

/**
 * HFS 製 PDF に対応する請求書（DB の invoices 行）から振込額を決める。
 * 新方式（tax_mode='exclusive'）で提出済み・承認済み、かつ payout_amount が数値のときだけ値を返す。
 * 旧方式（inclusive）や未提出は null（＝従来どおり PDF の文字から読む。旧方式の結果は変えない）。
 * @returns {null|{ amount, source:'hfs_db', hfs_invoice_id, tax_mode, subtotal_amount, total_amount, withholding_amount }}
 */
function hfsInvoicePayoutAmount(inv) {
  if (!inv || inv.tax_mode !== 'exclusive') return null;
  if (!['submitted', 'approved'].includes(inv.status)) return null;
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Math.round(Number(v));
  const payout = num(inv.payout_amount);
  if (payout == null || payout <= 0) return null;
  return {
    amount: payout,
    source: 'hfs_db',
    hfs_invoice_id: String(inv.id),
    tax_mode: 'exclusive',
    subtotal_amount: num(inv.subtotal_amount),
    total_amount: num(inv.total_amount),
    withholding_amount: num(inv.withholding_amount),
  };
}

/**
 * pdf_files のうち請求額の合算に使うファイル。
 * 「削除」「テンプレ」を冠した PDF は差し替え前の旧版・雛形なので除外。
 * 振込額そのもの（hfs_db / sashihiki / seikyu）が 1 件でもあればそれだけを合算。
 * 無ければ金額が取れたファイルがちょうど 1 件のときだけ採用（作業時間報告書など請求書以外の
 * PDF の「合計」を誤って足し込まないため）。
 */
function countedInvoicePdfFiles(pdfFiles) {
  const candidates = (pdfFiles || []).filter(f => !/削除|テンプレ/.test(String(f.name || '')));
  const priced = candidates.filter(f => Number.isFinite(Number(f.amount)) && Number(f.amount) > 0);
  const auth = priced.filter(f => AUTHORITATIVE_AMOUNT_SOURCES.includes(f.amount_source));
  if (auth.length) return auth;
  if (priced.length === 1) return priced;
  return [];
}

/** 振込額（請求額）の合計。合算できるファイルが無ければ null */
function sumInvoicePdfAmounts(pdfFiles) {
  const files = countedInvoicePdfFiles(pdfFiles);
  if (!files.length) return null;
  return files.reduce((s, f) => s + Number(f.amount), 0);
}

/**
 * 差分チェック（実データ per-unit＝税抜との突合）で請求書側に使う金額。
 *   - 手入力（amount_source='manual'）や旧方式だけ: 従来どおり invoice_amount（税込額面）・税込換算あり
 *   - 合算対象がすべて新方式の HFS 請求書: 税抜小計（subtotal_amount）の合計・税込換算なし
 *   - 新旧が混在: 新方式は税込（total_amount）に揃えて合算・税込換算あり
 * （新方式の invoice_amount は源泉を引いた差引お振込額なので、そのまま実データと比べると取り違える）
 * @returns {{ amount: number|null, tax_exclusive: boolean, basis: 'invoice'|'subtotal'|'mixed' }}
 */
function resolveDiffInvoiceBasis({ invoiceAmount, amountSource, pdfFiles }) {
  const legacy = { amount: invoiceAmount ?? null, tax_exclusive: false, basis: 'invoice' };
  if (amountSource === 'manual') return legacy;
  const files = countedInvoicePdfFiles(pdfFiles);
  const isExcl = (f) => f.amount_source === 'hfs_db' && f.tax_mode === 'exclusive'
    && Number.isFinite(Number(f.subtotal_amount)) && Number.isFinite(Number(f.total_amount));
  const excl = files.filter(isExcl);
  if (!excl.length) return legacy;
  if (excl.length === files.length) {
    return { amount: excl.reduce((s, f) => s + Number(f.subtotal_amount), 0), tax_exclusive: true, basis: 'subtotal' };
  }
  return {
    amount: files.reduce((s, f) => s + Number(isExcl(f) ? f.total_amount : f.amount), 0),
    tax_exclusive: false,
    basis: 'mixed',
  };
}

module.exports = {
  AUTHORITATIVE_AMOUNT_SOURCES,
  hfsInvoicePayoutAmount,
  countedInvoicePdfFiles,
  sumInvoicePdfAmounts,
  resolveDiffInvoiceBasis,
  dedupeInvoicePdfFiles,
  buildPayoutMessage,
  extractInvoiceAmount,
  evaluatePayoutDiff,
  evaluatePayoutDiffMulti,
  extractCreativeKeys,
  normalizeFolderPersonName,
  normalizePersonName,
};

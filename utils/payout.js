// 💸 振込管理（payout）の純関数群
// - Chatwork 定型文の組み立て / 請求書PDFテキストからの請求額抽出 / 差分チェック判定
// - 外部API・DB非依存（routes/haruka.js の /admin/payouts* から遅延 require される）
// - テスト: tests/utils/payout.test.js

// 振込完了メッセージ（定型文＋任意メモ）。
// メモが空/空白のみのときは定型文だけを返す（メモ表記は付けない）。
function buildPayoutMessage({ displayName, month, memo }) {
  const name = String(displayName || '').trim() || 'メンバー';
  const m = Number(month);
  const base = `${name}さん\n今月もお疲れ様でした。${m}月分を振り込みましたので、ご確認をお願いします。`;
  const note = String(memo || '').trim();
  return note ? `${base}\n\n${note}` : base;
}

// 請求書PDF（テキスト化済み）から税込請求額を抽出する。
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

  const seikyu = normalized.match(/ご\s*請\s*求\s*金\s*額[^0-9]{0,60}([0-9][0-9,]*)/);
  if (seikyu) {
    const n = parseNum(seikyu[1]);
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
function evaluatePayoutDiff({ invoiceAmount, actualTotal }) {
  const invoice = Number(invoiceAmount);
  const actual = Number(actualTotal) || 0;
  if (!Number.isFinite(invoice) || invoice <= 0) {
    return { status: 'unknown', delta: null, delta_with_tax: null };
  }
  const withTax = Math.round(actual * 1.1);
  const delta = invoice - actual;
  const deltaWithTax = invoice - withTax;
  const tolerance = (base) => Math.max(100, Math.round(base * 0.01));
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
function evaluatePayoutDiffMulti({ invoiceAmount, currentTotal, prevTotal, undeliveredTotal }) {
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
    const v = evaluatePayoutDiff({ invoiceAmount, actualTotal: c.total });
    if (v.status === 'match') {
      return { ...v, matched_basis: c.basis, matched_label: c.label, matched_total: c.total };
    }
    if (v.status === 'unknown') return { ...v, matched_basis: null, matched_label: null, matched_total: null };
  }
  const base = evaluatePayoutDiff({ invoiceAmount, actualTotal: cur });
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

module.exports = {
  buildPayoutMessage,
  extractInvoiceAmount,
  evaluatePayoutDiff,
  evaluatePayoutDiffMulti,
  extractCreativeKeys,
  normalizeFolderPersonName,
  normalizePersonName,
};

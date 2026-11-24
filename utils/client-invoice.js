// クライアント請求書（/client-invoice/generate）の明細と金額をサーバーで決める（純関数・jest）。
//
// 以前は画面から送られた明細・金額をそのまま請求書に入れ、送られた金額で creatives.client_fee まで
// 書き換えていた（2026-11-24 修正）。今は:
//   ・対象（クライアント × 月）の候補はサーバーが作る（納品完了 delivered_at の JST 月・status='納品'）
//   ・金額は請求突合チェッカー（billing-recon）と同じ: 成果物グループのクライアント単価 → 無ければ creatives.client_fee
//   ・画面から送られた明細・金額は「画面で見ていたものと同じか」の照合だけに使い、違えば 409
//   ・同じ制作が別のクライアント請求書に入っていれば 409（二重請求）

// 候補 1 件の金額。line は単価解決後の成果物グループ（無ければ null）
function clientPriceOf(creative, line) {
  const linePrice = Number(line && line.client_unit_price);
  if (Number.isFinite(linePrice) && linePrice > 0) return { amount: Math.round(linePrice), source: 'line' };
  const fee = Number(creative && creative.client_fee);
  if (Number.isFinite(fee) && fee > 0) return { amount: Math.round(fee), source: 'client_fee' };
  return { amount: 0, source: 'unknown' };
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

// 画面から送られた選択（items: [{ creative_id, client_fee }]）を、サーバーの候補と突き合わせる。
//   candidates … [{ id, file_name, amount, billed_invoice_number? }]（サーバーが作った候補）
//   expectedTotal … 画面に出ていた合計（任意。送られていれば照合する）
// 返り値:
//   { ok: true, rows: [{ creative_id, file_name, amount }], total }
//   { ok: false, status, error, problems: [{ creative_id, file_name, reason, expected?, actual? }] }
//     reason: not_candidate（対象月・クライアントの納品済みに無い）/ duplicate（同じ制作を 2 回）/
//             no_price（単価が未設定）/ amount_mismatch（画面の金額とサーバーの金額が違う）/
//             already_billed（別のクライアント請求書に入っている）
function checkClientInvoiceSelection({ candidates, items, expectedTotal }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, error: '請求する明細を選んでください', problems: [] };
  }
  const byId = new Map((candidates || []).map(c => [String(c.id), c]));
  const seen = new Set();
  const problems = [];
  const rows = [];
  for (const it of items) {
    const id = it && it.creative_id != null ? String(it.creative_id) : '';
    const c = byId.get(id);
    if (!c) { problems.push({ creative_id: id || null, file_name: null, reason: 'not_candidate' }); continue; }
    if (seen.has(id)) { problems.push({ creative_id: id, file_name: c.file_name || null, reason: 'duplicate' }); continue; }
    seen.add(id);
    if (c.billed_invoice_number) {
      problems.push({ creative_id: id, file_name: c.file_name || null, reason: 'already_billed', invoice_number: c.billed_invoice_number });
      continue;
    }
    const amount = Math.round(Number(c.amount) || 0);
    if (amount <= 0) { problems.push({ creative_id: id, file_name: c.file_name || null, reason: 'no_price' }); continue; }
    const sent = toInt(it.client_fee);
    if (sent !== null && sent !== amount) {
      problems.push({ creative_id: id, file_name: c.file_name || null, reason: 'amount_mismatch', expected: amount, actual: Number.isNaN(sent) ? null : sent });
      continue;
    }
    rows.push({ creative_id: c.id, file_name: c.file_name || null, amount });
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (problems.length > 0) {
    return { ok: false, status: 409, error: problemMessage(problems), problems };
  }
  const exp = toInt(expectedTotal);
  if (exp !== null && exp !== total) {
    return {
      ok: false, status: 409,
      error: `画面の合計（¥${Number.isNaN(exp) ? '?' : exp.toLocaleString('ja-JP')}）とサーバーで計算した合計（¥${total.toLocaleString('ja-JP')}）が違います。画面を開き直してください`,
      problems: [{ creative_id: null, file_name: null, reason: 'total_mismatch', expected: total, actual: Number.isNaN(exp) ? null : exp }],
    };
  }
  return { ok: true, rows, total };
}

const REASON_LABEL = {
  not_candidate: 'この月・クライアントの納品済みに無い',
  duplicate: '同じ制作が 2 回選ばれている',
  no_price: 'クライアント単価が未設定',
  amount_mismatch: '金額が変わっている',
  already_billed: '別のクライアント請求書に入っている',
};

function problemMessage(problems) {
  const head = problems.slice(0, 3).map(p => {
    const name = p.file_name || p.creative_id || '(不明)';
    const extra = p.reason === 'amount_mismatch' ? `（現在 ¥${Number(p.expected).toLocaleString('ja-JP')}）`
      : p.reason === 'already_billed' && p.invoice_number ? `（${p.invoice_number}）` : '';
    return `${name}: ${REASON_LABEL[p.reason] || p.reason}${extra}`;
  });
  const more = problems.length > 3 ? ` ほか ${problems.length - 3} 件` : '';
  return `請求書を作れませんでした。画面を開き直してください — ${head.join(' / ')}${more}`;
}

module.exports = { clientPriceOf, checkClientInvoiceSelection, REASON_LABEL };

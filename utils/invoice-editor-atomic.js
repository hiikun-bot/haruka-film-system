'use strict';
// ADR 046 追補 2026-11-24（3）: 請求書エディタの保存・CR の追加・提出を DB の関数（1 トランザクション）で行うための純関数。
//   DB 側: migrations/2026-11-24_invoice_editor_atomic_submit.sql の invoice_editor_save_draft / invoice_editor_submit
//   - 関数に渡す引数の組み立て（送ってよい列だけ・行の種類ごと）
//   - 関数の戻り値・エラーを HTTP の応答に読み替える
//   - 提出時に画面が送ってきた明細（id・単価・数量）と保存済みの明細の突き合わせ
// 判定ロジック（本人の分・納品済み・参考単価・理由・領収書・合計）は utils/invoice-editor.js のまま。ここは「DB に何を渡すか」だけ。

const SAVE_FN = 'invoice_editor_save_draft';
const SUBMIT_FN = 'invoice_editor_submit';

const NOT_READY = {
  status: 503,
  body: {
    error: '請求書の保存の仕組みを更新中です。少し時間をおいてからもう一度お試しください（管理者: DB の更新が必要です）',
    code: 'ATOMIC_SAVE_NOT_READY',
  },
};
const CONFLICT_MESSAGE = '別の画面でこの請求書が更新されています。再読み込みしてください';

/** 関数が本番にまだ無い（migration 未適用）ときの PostgREST / Postgres のエラーか */
function isMissingFunctionError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  return /Could not find the function|function .* does not exist/i.test(String(error.message || ''));
}

// 更新の行（p_updates）に入れてよい列。関数の側でも行の種類ごとに絞る（ここは余計なものを送らないため）
const UPDATE_KEYS = ['unit_price', 'quantity', 'label', 'price_change_reason', 'manual_reason', 'expense_date', 'expense_payee', 'sort_order', 'total_amount'];
// 追加の行（p_inserts）に入れてよい列
const INSERT_KEYS = [
  'creative_id', 'creative_label', 'cost_type', 'label', 'unit', 'unit_price', 'quantity', 'manual_reason',
  'original_unit_price', 'price_change_reason', 'sort_order', 'total_amount',
  'expense_date', 'expense_payee', 'receipt_status', 'receipt_missing_reason',
];

function pick(row, keys) {
  const out = {};
  for (const k of keys) if (row && Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined) out[k] = row[k];
  return out;
}

/** p_updates の 1 行: { id, ...変える列 } */
function updateArg(id, row) {
  return { id, ...pick(row, UPDATE_KEYS) };
}

/** p_inserts の 1 行: { client_key, ...列 }。client_key は関数が返す id_map の鍵（必ず付ける） */
function insertArg(clientKey, row) {
  return { client_key: String(clientKey), ...pick(row, INSERT_KEYS) };
}

/**
 * p_receipt_writes の 1 行。rc は PUT が「書くことにした」領収書の状態・理由（＋写真を外すなら receipt_file_id: null など）。
 * guardFileId … 画面が見ていた（＝読み出したときの）領収書ファイル。DB の行が同じときだけ書く
 */
function receiptWriteArg({ id, rc, guardFileId }) {
  const out = { id, guard_file_id: guardFileId || null };
  if (rc && Object.prototype.hasOwnProperty.call(rc, 'receipt_status')) out.receipt_status = rc.receipt_status;
  if (rc && Object.prototype.hasOwnProperty.call(rc, 'receipt_missing_reason')) out.receipt_missing_reason = rc.receipt_missing_reason;
  if (rc && Object.prototype.hasOwnProperty.call(rc, 'receipt_file_id') && rc.receipt_file_id === null) out.clear_file = true;
  return out;
}

/** p_invoice: 合計列（保存後の明細から計算した値）＋ 源泉あり/なし・備考（キーがあるときだけ変える） */
function invoiceArg(totals, { withholdingEnabled, notes } = {}) {
  const out = {
    subtotal_amount: totals.subtotal,
    tax_amount: totals.tax,
    total_amount: totals.total,
    withholding_amount: totals.withholding,
    payout_amount: totals.payout,
  };
  if (typeof withholdingEnabled === 'boolean') out.withholding_enabled = withholdingEnabled;
  if (notes !== undefined) out.notes = notes;
  return out;
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 提出の指紋（p_items）: アプリが検証に使った明細そのもの。関数はロックの中で DB の明細と差集合で照らす */
function submitFingerprint(items) {
  return (items || []).map(it => ({
    id: it.id,
    creative_id: it.creative_id || null,
    cost_type: it.cost_type || null,
    unit_price: intOrNull(it.unit_price),
    quantity: numOrNull(it.quantity),
  }));
}

/** 参考単価の控え直し（p_ref_updates）: 変わった CR 行だけ */
function refUpdatesArg(items, refPriceOf) {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.creative_id) continue;
    const ref = refPriceOf(it);
    const v = ref == null ? 0 : ref;
    if (it.original_unit_price !== v) out.push({ id: it.id, original_unit_price: v });
  }
  return out;
}

/** p_totals */
function totalsArg(totals) {
  return { subtotal: totals.subtotal, tax: totals.tax, total: totals.total, withholding: totals.withholding, payout: totals.payout };
}

/**
 * 提出時に画面が送ってきた明細（id・単価・数量）と保存済みの明細を突き合わせる（ADR 046 追補 2026-11-24（3）(c)）。
 *   - 単価・数量は parseMoney で厳格に読む（不正なら 400 と行番号）
 *   - 行の増減・単価の違い・HFS外の行の数量の違いがあれば stale（409・保存し直してから提出）
 * displayed が配列でなければ何もしない（古い画面からの提出。関数の指紋照合はどちらでも効く）
 * @returns {{ error?: {status, body}, stale?: boolean }}
 */
function compareDisplayedItems(displayed, items, { parseMoney, maxQuantity, isManualLine, isFixedLine }) {
  if (!Array.isArray(displayed)) return {};
  const byId = new Map((items || []).map(it => [it.id, it]));
  const seen = new Set();
  let stale = displayed.length !== byId.size;
  for (let i = 0; i < displayed.length; i++) {
    const d = displayed[i] || {};
    const it = typeof d.id === 'string' ? byId.get(d.id) : null;
    // 作業時間・一式の行の金額はサーバー計算の固定額（画面では直せない）なので、行があることだけ確かめる
    if (it && isFixedLine(it)) {
      if (seen.has(d.id)) stale = true;
      seen.add(d.id);
      continue;
    }
    const price = parseMoney(d.unit_price);
    if (price.error) return { error: { status: 400, body: { error: `${i + 1}行目: 単価は${price.error}`, index: i, code: 'BAD_INPUT' } } };
    if (!it || seen.has(d.id)) { stale = true; continue; }
    seen.add(d.id);
    if (intOrNull(it.unit_price) !== price.value) stale = true;
    if (isManualLine(it)) {
      const q = parseMoney(d.quantity, { max: maxQuantity });
      if (q.error) return { error: { status: 400, body: { error: `${i + 1}行目: 数量は${q.error}`, index: i, code: 'BAD_INPUT' } } };
      if (numOrNull(it.quantity) !== (q.value == null ? null : q.value)) stale = true;
    }
  }
  return { stale };
}

const STALE_BODY = {
  error: '画面の明細と保存済みの明細が違います。保存が終わるのを待ってから、もう一度「提出する」を押してください',
  code: 'STALE_ITEMS',
};

/** invoice_editor_save_draft の {ok:false} を HTTP に */
function saveFailureToHttp(result) {
  const code = result && result.code;
  if (code === 'CONFLICT') return { status: 409, body: { error: CONFLICT_MESSAGE, code: 'CONFLICT', updated_at: result.updated_at } };
  if (code === 'NOT_EDITABLE') return { status: 400, body: { error: '提出済みの請求書は編集できません', code: 'NOT_EDITABLE' } };
  if (code === 'NOT_EXCLUSIVE') return { status: 400, body: { error: 'この請求書は旧方式（内税）です。「修正」から編集してください', code: 'NOT_EXCLUSIVE' } };
  if (code === 'NOT_FOUND') return { status: 404, body: { error: '請求書が見つかりません' } };
  return { status: 500, body: { error: '保存できませんでした' } };
}

/** 関数呼び出しのエラー（{ error }）を HTTP に。null なら呼び出し元で 500 扱いにしない（＝エラーではない） */
function rpcErrorToHttp(error) {
  if (!error) return null;
  if (isMissingFunctionError(error)) return NOT_READY;
  // 更新しようとした明細が無い（別の画面で消された）→ 読み直してもらう
  if (String(error.code || '') === 'P0002' || /ITEM_NOT_FOUND|item not found/i.test(`${error.hint || ''} ${error.message || ''}`)) {
    return { status: 409, body: { error: '明細が見つかりません（別の画面で消された可能性があります）。再読み込みしてください', code: 'CONFLICT' } };
  }
  // 請求済み記録の主キー違反（ロックの中の確認をすり抜けた二重請求。通常は起きない）
  if (String(error.code || '') === '23505') {
    return { status: 409, body: { error: '提出できません。すでに提出済みの請求書に入っている明細があります', code: 'INVOICE_CHECK_FAILED', problems: [] } };
  }
  return { status: 500, body: { error: error.message || 'DB エラー' } };
}

/**
 * invoice_editor_submit の {ok:false} を HTTP に。
 * DUPLICATE は画面がどの行か分かるよう problems（item_id・code・message）を INVOICE_CHECK_FAILED で返す（従来の 409 と同じ形）
 */
function submitFailureToHttp(result, { itemsById } = {}) {
  const code = result && result.code;
  if (code === 'CONFLICT') return { status: 409, body: { error: CONFLICT_MESSAGE, code: 'CONFLICT' } };
  if (code === 'STALE_ITEMS') return { status: 409, body: STALE_BODY };
  if (code === 'NOT_EDITABLE') return { status: 400, body: { error: `この状態では提出できません（現在: ${result.status}）` } };
  if (code === 'NOT_EXCLUSIVE') return { status: 400, body: { error: 'この請求書は旧方式（内税）です。「修正」から編集してください', code: 'NOT_EXCLUSIVE' } };
  if (code === 'NOT_FOUND') return { status: 404, body: { error: '請求書が見つかりません' } };
  if (code === 'NO_ISSUER') return { status: 400, body: { error: '請求書の発行者がありません' } };
  if (code === 'DUPLICATE') {
    const problems = (Array.isArray(result.problems) ? result.problems : []).map(p => {
      const it = itemsById && itemsById.get(p.item_id);
      const name = (it && (it.creative_label || it.label)) || '';
      const inInvoice = p.code === 'DUPLICATE_IN_INVOICE';
      return {
        item_id: p.item_id,
        creative_id: p.creative_id || null,
        code: inInvoice ? 'DUPLICATE_IN_INVOICE' : 'DUPLICATE',
        message: `${name ? name + ': ' : ''}${inInvoice ? 'この請求書の中に同じ明細が 2 行あります' : 'すでに提出済みの請求書に入っています'}`,
      };
    });
    return { status: 409, body: { error: '提出できません。赤い行を直してください', code: 'INVOICE_CHECK_FAILED', problems } };
  }
  return { status: 500, body: { error: '提出できませんでした' } };
}

module.exports = {
  SAVE_FN, SUBMIT_FN, NOT_READY, CONFLICT_MESSAGE, STALE_BODY, UPDATE_KEYS, INSERT_KEYS,
  isMissingFunctionError, updateArg, insertArg, receiptWriteArg, invoiceArg,
  submitFingerprint, refUpdatesArg, totalsArg, compareDisplayedItems,
  saveFailureToHttp, rpcErrorToHttp, submitFailureToHttp,
};

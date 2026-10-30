// utils/bank-transfer-plan.js — 総合振込の明細組み立て（純関数・ADR 054 §1-5 / §4）
// =============================================================
// DB・HTTP 非依存。routes/bank-transfer.js が取ってきた行を渡して明細を作る。
// テスト: tests/bank-transfer-plan.test.js
//
// 金額の決め方（§1-5）:
//   同 issuer_id/year/month の請求書（invoice_type IS NULL・status が submitted/approved）があれば
//     exclusive … payout_amount（差引お振込額。無ければ total_amount − withholding_amount）
//     inclusive … total_amount（税込）
//   複数あれば合算（invoice_id は先頭・警告つき）。無ければ payout_records.invoice_amount を使い
//   「請求書なし（PDF抽出額）」の警告を付ける。
//
// 除外（§4・excluded[] に理由を返す）:
//   口座列に不備 / bank_info_updated_at が 7 日以内 / status='paid' 済み / is_active=false /
//   金額 0 以下 / 同月に有効な依頼明細（awaiting_approval 等）がすでにある人
// =============================================================

const crypto = require('crypto');
const { buildBeneficiary, maskAccountNumber } = require('./zengin-format');

const BANK_INFO_GUARD_DAYS = 7;
const BILLED_INVOICE_STATUSES = ['submitted', 'approved'];
// 同月の二重振込防止（§3-2 / §4 追補）: これらの状態の batch に failed/returned でない明細がある人は除外
// （expired / cancelled / failed の batch の明細だけが再依頼できる）
const BLOCKING_BATCH_STATUSES = ['requesting', 'requested', 'awaiting_approval', 'approved', 'processing', 'completed'];
const REUSABLE_ITEM_STATUSES = ['failed', 'returned'];

const EXCLUDE_REASONS = {
  record_not_found: '振込レコードが見つかりません',
  wrong_month: '指定した年月の振込レコードではありません',
  user_not_found: 'メンバーが見つかりません',
  inactive: '退職済み（無効）のメンバーです',
  already_paid: 'すでに振込済みです',
  duplicate_in_month: 'この月はすでに総合振込を依頼済みです（二重振込防止）',
  bank_info_recent: '口座情報が変更されてから 7 日以内です',
  bank_info_invalid: '口座情報に不備があります',
  amount_zero: '振込額が 0 以下です',
  amount_unknown: '振込額が分かりません（請求書も PDF 抽出額もありません）',
};

function displayNameOf(u) {
  if (!u) return '(不明なメンバー)';
  const full = String(u.full_name || '').trim();
  const nick = String(u.nickname || '').trim();
  if (nick && full && nick !== full) return `${nick}（${full}）`;
  return full || nick || '(不明なメンバー)';
}

function daysSince(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (now - t) / (24 * 60 * 60 * 1000);
}

/** 請求書 1 枚の「振り込む額」と台帳用の内訳 */
function invoicePayout(inv) {
  const total = Number(inv.total_amount) || 0;
  if (String(inv.tax_mode || 'inclusive') === 'exclusive') {
    const withholding = Number(inv.withholding_amount) || 0;
    const payout = inv.payout_amount != null ? Number(inv.payout_amount) : total - withholding;
    return {
      amount: payout,
      gross_amount: total,
      tax_amount: Number(inv.tax_amount) || 0,
      withholding_amount: withholding,
    };
  }
  return { amount: total, gross_amount: total, tax_amount: null, withholding_amount: 0 };
}

/**
 * @param {object} p
 * @param {Array<object>} p.records       選択された payout_records 行（存在しない id は notFoundIds で渡す）
 * @param {Array<string>} [p.notFoundIds] 見つからなかった payout_record_id
 * @param {Array<object>} p.users         対象メンバーの users 行（口座列・is_active・bank_info_updated_at）
 * @param {Array<object>} p.invoices      同月の請求書（issuer_id・status・tax_mode・total_amount・payout_amount…）
 * @param {Set<string>|Array<string>} [p.blockedUserIds] 同月に有効な依頼明細がある user_id
 * @param {number} p.year
 * @param {number} p.month
 * @param {number} [p.now]               Date.now()
 * @returns {{ items: Array<object>, excluded: Array<object>, warnings: string[], total_count: number, total_amount: number }}
 */
function planTransferItems({ records, notFoundIds = [], users, invoices, blockedUserIds, year, month, now = Date.now() }) {
  const userById = new Map((users || []).map(u => [u.id, u]));
  const blocked = blockedUserIds instanceof Set ? blockedUserIds : new Set(blockedUserIds || []);
  const invoicesByUser = new Map();
  for (const inv of invoices || []) {
    if (!inv || !inv.issuer_id) continue;
    if (inv.invoice_type != null) continue;                         // クライアント請求書は対象外
    if (!BILLED_INVOICE_STATUSES.includes(String(inv.status))) continue;
    if (Number(inv.year) !== Number(year) || Number(inv.month) !== Number(month)) continue;
    if (!invoicesByUser.has(inv.issuer_id)) invoicesByUser.set(inv.issuer_id, []);
    invoicesByUser.get(inv.issuer_id).push(inv);
  }

  const excluded = [];
  const candidates = [];
  const warnings = [];

  for (const id of notFoundIds || []) {
    excluded.push({ payout_record_id: id, user_id: null, display_name: null, reason_code: 'record_not_found', reason: EXCLUDE_REASONS.record_not_found });
  }

  // 決定的な並び（preview と request で同じ順＝同じハッシュ）: 氏名 → user_id
  const sorted = [...(records || [])].sort((a, b) => {
    const ua = userById.get(a.user_id), ub = userById.get(b.user_id);
    const na = String(ua?.full_name || ''), nb = String(ub?.full_name || '');
    if (na !== nb) return na < nb ? -1 : 1;
    return String(a.user_id) < String(b.user_id) ? -1 : 1;
  });

  for (const rec of sorted) {
    const u = userById.get(rec.user_id);
    const base = { payout_record_id: rec.id, user_id: rec.user_id, display_name: displayNameOf(u) };
    const exclude = (code, extra = {}) => excluded.push({ ...base, reason_code: code, reason: EXCLUDE_REASONS[code], ...extra });

    if (Number(rec.year) !== Number(year) || Number(rec.month) !== Number(month)) { exclude('wrong_month'); continue; }
    if (!u) { exclude('user_not_found'); continue; }
    if (u.is_active === false) { exclude('inactive'); continue; }
    if (String(rec.status) === 'paid') { exclude('already_paid'); continue; }
    if (blocked.has(rec.user_id)) { exclude('duplicate_in_month'); continue; }

    const since = daysSince(u.bank_info_updated_at, now);
    if (since != null && since < BANK_INFO_GUARD_DAYS) {
      const remaining = Math.max(1, Math.ceil(BANK_INFO_GUARD_DAYS - since));
      exclude('bank_info_recent', { days_remaining: remaining, reason: `口座情報が変更されてから 7 日以内です（あと ${remaining} 日）` });
      continue;
    }

    const bene = buildBeneficiary(u);
    if (!bene.ok) { exclude('bank_info_invalid', { errors: bene.errors, reason: `口座情報に不備があります: ${bene.errors.join(' / ')}` }); continue; }

    const itemWarnings = [...bene.warnings];
    const invs = invoicesByUser.get(rec.user_id) || [];
    let amount = 0, gross = null, tax = null, withholding = null, invoiceId = null, invoiceNumbers = [], amountSource;
    if (invs.length) {
      amountSource = 'invoice';
      gross = 0; tax = 0; withholding = 0;
      for (const inv of invs) {
        const p = invoicePayout(inv);
        amount += p.amount;
        gross += p.gross_amount;
        if (p.tax_amount != null) tax += p.tax_amount;
        withholding += p.withholding_amount;
        invoiceNumbers.push(inv.invoice_number || inv.id);
      }
      invoiceId = invs[0].id;
      if (invs.length > 1) itemWarnings.push(`請求書が ${invs.length} 件あるため合算しました（${invoiceNumbers.join(', ')}）`);
      if (rec.invoice_amount != null && Number(rec.invoice_amount) !== amount) {
        itemWarnings.push(`振込管理の請求額（PDF 抽出 ${Number(rec.invoice_amount).toLocaleString('ja-JP')}円）と請求書の額が一致しません`);
      }
    } else if (rec.invoice_amount != null && Number(rec.invoice_amount) > 0) {
      amountSource = 'pdf';
      amount = Number(rec.invoice_amount);
      gross = amount;
      itemWarnings.push('請求書なし（PDF 抽出額を使用）');
    } else {
      exclude('amount_unknown');
      continue;
    }
    amount = Math.round(amount);
    if (!Number.isFinite(amount) || amount <= 0) { exclude('amount_zero', { amount }); continue; }

    candidates.push({
      ...base,
      ...bene.item,
      account_number_last4: maskAccountNumber(bene.item.account_number),
      amount,
      invoice_id: invoiceId,
      invoice_numbers: invoiceNumbers,
      amount_source: amountSource,
      gross_amount: gross,
      tax_amount: tax,
      withholding_amount: withholding,
      warnings: itemWarnings,
    });
  }

  const items = candidates.map((c, i) => ({ item_id: i + 1, ...c }));
  const totalAmount = items.reduce((s, it) => s + it.amount, 0);
  if (items.some(it => it.amount_source === 'pdf')) warnings.push('請求書が無く PDF 抽出額を使った明細があります。金額を確認してください');
  return { items, excluded, warnings, total_count: items.length, total_amount: totalAmount };
}

/** 明細＋振込指定日のハッシュ（preview_token と request で同一内容かを確認する） */
function planHash(items, transferDesignatedDate) {
  const core = (items || []).map(it => [
    it.payout_record_id, it.user_id, it.bank_code, it.branch_code, it.account_type_code,
    it.account_number, it.beneficiary_name, Number(it.amount),
  ]);
  return crypto.createHash('sha256').update(JSON.stringify({ d: String(transferDesignatedDate), core })).digest('hex');
}

/** 銀行 API の総合振込ボディ（手数料事前照会・依頼で同じ形） */
function buildBulkTransferBody({ accountId, transferDesignatedDate, transferDataName, items, remitterName }) {
  const body = {
    accountId: String(accountId),
    transferDesignatedDate: String(transferDesignatedDate),
    transferDateHolidayCode: '1', // 非営業日なら翌営業日
    totalCount: String(items.length),
    totalAmount: String(items.reduce((s, it) => s + Number(it.amount), 0)),
    bulkTransfers: items.map(it => ({
      itemId: String(it.item_id),
      beneficiaryBankCode: it.bank_code,
      beneficiaryBranchCode: it.branch_code,
      accountTypeCode: it.account_type_code,
      accountNumber: it.account_number,
      beneficiaryName: it.beneficiary_name,
      transferAmount: String(it.amount),
    })),
  };
  if (transferDataName) body.transferDataName = String(transferDataName).slice(0, 10);
  if (remitterName) body.remitterName = String(remitterName);
  return body;
}

/** 振込データ名（10 文字以内・全半角可） */
function transferDataNameFor(year, month) {
  return `${String(year).slice(-2)}年${Number(month)}月分報酬`.slice(0, 10);
}

/** 画面・通知・DB(request_summary) 向けのマスク済み要約（口座番号は下4桁のみ） */
function summarizeItems(items) {
  return (items || []).map(it => ({
    item_id: it.item_id,
    payout_record_id: it.payout_record_id,
    user_id: it.user_id,
    display_name: it.display_name,
    account_number_last4: it.account_number_last4 || maskAccountNumber(it.account_number),
    beneficiary_name: it.beneficiary_name,
    amount: it.amount,
    amount_source: it.amount_source,
    invoice_id: it.invoice_id || null,
    invoice_numbers: it.invoice_numbers || [],
    warnings: it.warnings || [],
  }));
}

/** YYYY-MM-DD（JST の日付文字列）として妥当か。過去日は不可 */
function validateDesignatedDate(value, todayJst) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: '振込指定日は YYYY-MM-DD で指定してください' };
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false, error: '振込指定日が実在しない日付です' };
  if (todayJst && s < todayJst) return { ok: false, error: '振込指定日が過去の日付です' };
  const limit = new Date(Date.UTC(y, m - 1, d));
  const today = todayJst ? new Date(`${todayJst}T00:00:00Z`) : null;
  if (today && (limit - today) / 86400000 > 90) return { ok: false, error: '振込指定日は 90 日以内にしてください' };
  return { ok: true, value: s };
}

// ---------- 二重依頼の除外（§3-2-4）・指定日の突き合わせ（§3-2-5）・台帳スナップショット（§5） ----------

/**
 * 同月の batch と明細から「新しい依頼に含めてはいけない user_id」を求める（純関数）。
 * @param {Array<{id:string,status:string}>} batches 同月の payout_transfer_batches
 * @param {Array<{batch_id:string,user_id:string,status:string}>} items それらの明細
 * @returns {Set<string>}
 */
function blockedUserIdsFromItems(batches, items) {
  const blockingBatch = new Set((batches || []).filter(b => BLOCKING_BATCH_STATUSES.includes(String(b.status))).map(b => b.id));
  const out = new Set();
  for (const it of items || []) {
    if (!blockingBatch.has(it.batch_id)) continue;
    if (REUSABLE_ITEM_STATUSES.includes(String(it.status))) continue;
    if (it.user_id) out.add(it.user_id);
  }
  return out;
}

/** request 時の再評価: 明細の user_id が blocked に含まれていれば、その user_id の一覧（空なら OK） */
function alreadyRequestedUserIds(items, blockedUserIds) {
  const blocked = blockedUserIds instanceof Set ? blockedUserIds : new Set(blockedUserIds || []);
  return [...new Set((items || []).map(it => it.user_id).filter(id => blocked.has(id)))];
}

/**
 * preview_token の日付と request body の日付の突き合わせ。
 * @returns {{ ok: true, value: string } | { ok: false, code: 'date_required'|'date_mismatch', error: string }}
 */
function checkDesignatedDateMatch(tokenDate, bodyDate) {
  const body = String(bodyDate || '').trim();
  if (!body) return { ok: false, code: 'date_required', error: 'transfer_designated_date を指定してください（確認画面の振込指定日）' };
  if (body !== String(tokenDate || '').trim()) {
    return { ok: false, code: 'date_mismatch', error: '振込指定日が確認した内容と違います。日付を変えたときは、もう一度「依頼内容を確認」からやり直してください' };
  }
  return { ok: true, value: body };
}

/**
 * payout_records.ledger_snapshot の中身（支払時点で凍結する台帳の元データ）。
 * @param {{ amount:number, invoices?:Array<object>, now?:Date }} p invoices は同月の提出済/承認済の請求書（複数なら合算）
 */
function buildLedgerSnapshot({ amount, invoices = [], now = new Date() }) {
  const invs = (invoices || []).filter(Boolean);
  const sum = (key) => (invs.some(i => i[key] != null) ? invs.reduce((s, i) => s + (Number(i[key]) || 0), 0) : null);
  const exclusive = invs.filter(i => String(i.tax_mode || 'inclusive') === 'exclusive');
  return {
    amount: Number(amount) || 0,
    invoice_id: invs[0]?.id || null,
    invoice_number: invs.map(i => i.invoice_number).filter(Boolean).join(', ') || null,
    invoice_count: invs.length,
    subtotal_amount: sum('subtotal_amount'),
    tax_amount: sum('tax_amount'),
    withholding_amount: exclusive.length ? exclusive.reduce((s, i) => s + (Number(i.withholding_amount) || 0), 0) : (invs.length ? 0 : null),
    payout_amount: invs.length ? invs.reduce((s, i) => s + invoicePayout(i).amount, 0) : null,
    total_amount: sum('total_amount'),
    snapshot_at: now.toISOString(),
  };
}

/**
 * 応答が消えた依頼（requesting）が銀行に受け付けられていないか、総合振込状況照会（一括照会）の結果から探す。
 * 振込データ名＋件数＋合計が一致する受付があれば、その受付番号と振込ステータスを返す（純関数）。
 * @returns {{ applyNo: string, transferStatus: string|null } | null}
 */
function matchPendingAcceptance(statusRes, batch) {
  const details = Array.isArray(statusRes?.bulkTransferDetails) ? statusRes.bulkTransferDetails : [];
  for (const d of details) {
    const responses = Array.isArray(d.bulktransferResponses) ? d.bulktransferResponses : [];
    const hit = responses.find(r =>
      String(r.transferDataName || '') === String(batch.transfer_data_name || '')
      && Number(r.totalCount) === Number(batch.total_count)
      && Number(r.totalAmount) === Number(batch.total_amount)
      && (!batch.transfer_designated_date || !r.transferDesignatedDate || String(r.transferDesignatedDate) === String(batch.transfer_designated_date)));
    if (!hit) continue;
    const applyNo = ((d.transferApplies || [])[0] || {}).applyNo || null;
    if (!applyNo) continue;
    return { applyNo: String(applyNo), transferStatus: d.transferStatus != null ? String(d.transferStatus) : null };
  }
  return null;
}

module.exports = {
  BANK_INFO_GUARD_DAYS,
  BILLED_INVOICE_STATUSES,
  BLOCKING_BATCH_STATUSES,
  REUSABLE_ITEM_STATUSES,
  EXCLUDE_REASONS,
  blockedUserIdsFromItems,
  alreadyRequestedUserIds,
  checkDesignatedDateMatch,
  buildLedgerSnapshot,
  matchPendingAcceptance,
  displayNameOf,
  invoicePayout,
  planTransferItems,
  planHash,
  buildBulkTransferBody,
  transferDataNameFor,
  summarizeItems,
  validateDesignatedDate,
};

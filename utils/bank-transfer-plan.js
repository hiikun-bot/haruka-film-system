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

// ---------- 銀行のステータス変換（仕様 p.95〜96）・レビュー対応の純関数（PR #1279） ----------
// 総合振込状況照会 bulkTransferDetails[].transferStatus → payout_transfer_batches.status
const TRANSFER_STATUS_TO_BATCH = {
  '2': 'awaiting_approval', // 申請中
  '3': 'cancelled',         // 差戻
  '4': 'cancelled',         // 取下げ
  '5': 'expired',           // 期限切れ
  '8': 'cancelled',         // 承認取消/予約取消
  '11': 'approved',         // 予約中
  '12': 'processing',       // 手続中
  '13': 'processing',       // リトライ中
  '20': 'completed',        // 手続済
  '30': 'completed',        // 不能・組戻あり（明細ごとに returned / failed）
  '40': 'failed',           // 手続不成立
};
const TRANSFER_STATUS_NAMES = {
  '2': '申請中', '3': '差戻', '4': '取下げ', '5': '期限切れ', '8': '承認取消/予約取消',
  '11': '予約中', '12': '手続中', '13': 'リトライ中', '20': '手続済', '30': '不能・組戻あり', '40': '手続不成立',
};
const TERMINAL_BATCH_STATUSES = ['completed', 'expired', 'cancelled', 'failed'];
const TERMINAL_ITEM_STATUSES = ['completed', 'returned', 'failed'];

function mapTransferStatus(code) {
  return TRANSFER_STATUS_TO_BATCH[String(code)] || null;
}

/**
 * 状況照会の明細 1 件 → payout_transfer_items.status
 *   unableDetailInfos[].transferDetailStatus 1=手続済 2=手続不成立、refundStatus 2=組戻済、isRepayment=資金返却
 */
function mapItemStatus(info, batchStatus) {
  const un = Array.isArray(info?.unableDetailInfos) ? info.unableDetailInfos : [];
  const detailStatus = un.map(u => String(u.transferDetailStatus || '')).find(Boolean) || null;
  const refund = un.map(u => String(u.refundStatus || '')).find(Boolean) || null;
  const repaid = un.some(u => u.isRepayment === true);
  if (detailStatus === '2') return 'failed';
  if (repaid || refund === '2') return 'returned';
  if (detailStatus === '1') return 'completed';
  if (batchStatus === 'completed') return 'completed';
  if (batchStatus === 'failed') return 'failed';
  return 'pending';
}

/**
 * レビュー #1: request 時に「preview では含まれていたが今は同月の別依頼に引っかかった人」の user_id。
 * preview_token には plan に含めた record ids だけ入れるので、ここに出た人は preview 後に別の依頼が入った人。
 */
function requestConflicts(planned) {
  return [...new Set((planned?.excluded || []).filter(e => e.reason_code === 'duplicate_in_month').map(e => e.user_id).filter(Boolean))];
}

/**
 * レビュー #4: 総合振込依頼の 2xx 応答を「受付」か「応答消失扱い」かに分ける。
 * applyNo（16 桁）と resultCode 1/2 が揃っていなければ、受付番号なしで固まらないよう pending（同じキーで再送）にする。
 */
function classifyRequestResponse(result) {
  const applyNo = result && result.applyNo != null ? String(result.applyNo).trim() : '';
  const resultCode = result && result.resultCode != null ? String(result.resultCode) : null;
  if (!/^\d{16}$/.test(applyNo)) return { outcome: 'pending', reason: `受付番号が応答に含まれていません（applyNo=${applyNo || '-'}）` };
  if (!['1', '2'].includes(resultCode)) return { outcome: 'pending', reason: `結果コードが想定外です（resultCode=${resultCode || '-'}）` };
  return {
    outcome: 'accepted',
    applyNo,
    resultCode,
    status: resultCode === '1' ? 'approved' : 'awaiting_approval',
    approvedAt: resultCode === '1' ? (result.applyEndDatetime || null) : null,
  };
}

/**
 * レビュー #5: 依頼結果照会の resultCode → batch の次の状態。
 * 取消依頼中（cancelRequested）の 8:期限切 は「取消依頼の期限切れ」なので元の依頼の状態を保ち、取消マーカーを消す。
 * @returns {{ status: string|null, clearCancel: boolean, note: string|null, inquire: boolean }} status=null は変更なし、inquire=true は状況照会へ
 */
function decideBatchFromResultCode({ resultCode, status, cancelRequested }) {
  const code = resultCode != null ? String(resultCode) : null;
  if (code === '8') {
    if (cancelRequested) return { status: null, clearCancel: true, note: '取消依頼が承認されないまま期限切れになりました（元の依頼は残っています）', inquire: false };
    return { status: 'expired', clearCancel: false, note: null, inquire: false };
  }
  if (code === '2') {
    const next = !cancelRequested && ['requesting', 'requested', 'awaiting_approval'].includes(status) ? 'awaiting_approval' : null;
    return { status: next, clearCancel: false, note: null, inquire: false };
  }
  if (code === '1') return { status: null, clearCancel: false, note: null, inquire: true };
  return { status: null, clearCancel: false, note: `依頼結果照会の結果コードが不明です（${code || '-'}）`, inquire: false };
}

/**
 * レビュー #3: 状況照会の明細（全ページ分）から各 item の次の status を決める。
 * info が無い item は「未確定」として返し、呼び出し側は全件確定するまで batch を completed にしない。
 * @returns {{ patches: Array<{id, item_id, status, error_detail}>, unresolved: number[] }}
 */
function resolveItemStatuses({ items, infos, transferStatus }) {
  const batchStatus = mapTransferStatus(transferStatus);
  const infoByItemId = new Map((infos || []).map(i => [String(i.itemId), i]));
  const patches = [];
  const unresolved = [];
  for (const it of items || []) {
    if (TERMINAL_ITEM_STATUSES.includes(it.status)) continue;
    const info = infoByItemId.get(String(it.item_id));
    if (!info) {
      if (batchStatus === 'failed') { patches.push({ id: it.id, item_id: it.item_id, status: 'failed', error_detail: { transfer_status: transferStatus, reason: 'batch_failed' } }); continue; }
      unresolved.push(it.item_id);
      continue;
    }
    const next = mapItemStatus(info, batchStatus);
    if (next === 'pending') { unresolved.push(it.item_id); continue; }
    const un = info.unableDetailInfos?.[0] || {};
    patches.push({
      id: it.id, item_id: it.item_id, status: next,
      error_detail: next === 'completed' ? null : {
        transfer_detail_status: un.transferDetailStatus || null,
        refund_status: un.refundStatus || null,
        is_repayment: un.isRepayment || null,
        repayment_date: un.repaymentDate || null,
        transfer_status: transferStatus,
      },
    });
  }
  return { patches, unresolved };
}

/**
 * レビュー #2: batch が expired / cancelled / failed になるとき、未確定（pending）の item を failed に落とす
 * （部分ユニークインデックス uq_payout_transfer_items_active_record は pending/completed だけを数えるので、再依頼できるようになる）。
 */
function itemsToFailOnTerminal(items, reason) {
  return (items || []).filter(it => it.status === 'pending').map(it => ({
    id: it.id, item_id: it.item_id, status: 'failed', error_detail: { reason: reason || 'batch_terminated' },
  }));
}

/** 状況照会（明細つき）のページング: 次に渡す bulktransferItemKey。これ以上無ければ null */
function nextItemKeyFor({ startKey, fetchedCount, totalCount, pageSize = 500 }) {
  const start = Number(startKey) || 1;
  const n = Number(fetchedCount) || 0;
  if (n === 0) return null;
  const next = start + n;
  if (next > Number(totalCount)) return null;
  if (n < pageSize) return null;
  return next;
}

module.exports = {
  BANK_INFO_GUARD_DAYS,
  BILLED_INVOICE_STATUSES,
  BLOCKING_BATCH_STATUSES,
  REUSABLE_ITEM_STATUSES,
  TERMINAL_BATCH_STATUSES,
  TERMINAL_ITEM_STATUSES,
  TRANSFER_STATUS_TO_BATCH,
  TRANSFER_STATUS_NAMES,
  EXCLUDE_REASONS,
  mapTransferStatus,
  mapItemStatus,
  requestConflicts,
  classifyRequestResponse,
  decideBatchFromResultCode,
  resolveItemStatuses,
  itemsToFailOnTerminal,
  nextItemKeyFor,
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

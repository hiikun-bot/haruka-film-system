// utils/bank-transfer.js — 総合振込の業務ロジック（DB・通知つき。ADR 054 Stage B）
// =============================================================
// routes/bank-transfer.js（管理者操作）と workers/bank-transfer-poller.js（10 分ごとの照会）が共用する。
//   - 明細の入力集め（payout_records / users / invoices / 同月の依頼済み）→ utils/bank-transfer-plan.js で組み立て
//   - preview_token（HMAC 署名・10 分期限・明細ハッシュ・依頼者 id）
//   - bank_api_audit_logs への記録（秘密情報なし）
//   - 管理者マイチャットへの一報（バグ報告・単価承認待ちと同じ経路: resolveAdminMyChatRoomId → sendChatworkRoom）
//   - 依頼結果照会 → 状況照会 → batch / items の更新 → 完了時の payout_records 消し込み＋本人通知
//   - 口座情報が変わったときの本人・管理者通知（§1-4）
//
// ログに口座番号・受取人名・トークンを出さない（口座番号は下4桁のみ）。
// =============================================================

const crypto = require('crypto');
const supabase = require('../supabase');
const aozora = require('./aozora-api');
const plan = require('./bank-transfer-plan');
const googleLogin = require('./google-login');
const { signState, verifyState, getStateSecret } = googleLogin;
const { maskAccountNumber } = require('./zengin-format');
const { notifyMember } = require('./member-notify');
const { buildPayoutMessage } = require('./payout');

const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
const REAUTH_TTL_MS = 10 * 60 * 1000;
const REQUESTING_RETRY_AFTER_MS = 15 * 60 * 1000; // requesting（応答待ち）が 15 分続いたらワーカが同じキーで 1 回だけ再送
const REQUESTING_MAX_AUTO_RETRIES = 1;

const USER_COLUMNS = 'id, full_name, nickname, is_active, bank_code, branch_code, account_type, account_number, account_holder_kana, bank_info_updated_at, chatwork_dm_id, chatwork_direct_room_id, slack_dm_id';
const INVOICE_COLUMNS = 'id, invoice_number, issuer_id, status, year, month, invoice_type, tax_mode, subtotal_amount, tax_amount, total_amount, withholding_amount, payout_amount';
const BATCH_COLUMNS = 'id, connection_id, year, month, idempotency_key, transfer_designated_date, transfer_data_name, total_count, total_amount, fee_precheck, request_summary, apply_no, result_code, status, requested_by, requested_at, approved_at, completed_at, last_polled_at, last_error, created_at, updated_at';
const ITEM_COLUMNS = 'id, batch_id, payout_record_id, user_id, item_id, bank_code, branch_code, account_type_code, account_number, beneficiary_name, amount, invoice_id, amount_source, gross_amount, tax_amount, withholding_amount, status, error_detail, created_at, updated_at';

function stateSecret() {
  return getStateSecret();
}

// ---------- 再認証（§1-3）: server.js の /auth/* と routes/bank-transfer.js で同じ判定を使う（レビュー #11） ----------
/** セッションの reauth_at が 10 分以内か */
function reauthStatus(req) {
  const at = Number(req?.session?.reauth_at || 0);
  const remaining = at ? Math.max(0, REAUTH_TTL_MS - (Date.now() - at)) : 0;
  return { ok: remaining > 0, remaining_sec: Math.floor(remaining / 1000) };
}

/** /haruka.html 始まりの next にクエリを足して戻す（オープンリダイレクト防止は safeNext） */
function reauthRedirect(res, next, params) {
  const url = new URL(googleLogin.safeNext(next), 'http://x');
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
  return res.redirect(url.pathname + url.search);
}

function todayJst(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function yen(n) {
  return `${Number(n || 0).toLocaleString('ja-JP')}円`;
}

// ---------- 監査ログ ----------
async function audit({ actorUserId = null, action, connectionId = null, batchId = null, detail = null, req = null }) {
  const row = {
    actor_user_id: actorUserId,
    action,
    connection_id: connectionId,
    batch_id: batchId,
    detail: detail || null,
  };
  if (req) {
    try {
      const { getClientIP, getUserAgent } = require('./client-ip');
      row.ip_address = getClientIP(req) || null;
      row.user_agent = (getUserAgent(req) || '').slice(0, 500) || null;
    } catch (_) { /* noop */ }
  }
  const { error } = await supabase.from('bank_api_audit_logs').insert(row);
  if (error) console.warn(`[bank-transfer] 監査ログの保存に失敗 action=${action}: ${error.message}`);
}

// ---------- 管理者マイチャット ----------
/** バグ報告・単価承認待ちと同じ経路で管理者（CHATWORK_API_TOKEN 名義人）のマイチャットへ送る */
async function sendAdminMyChat(text) {
  const notif = require('../notifications');
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) return { ok: false, reason: 'no_token' };
  const roomId = await notif.resolveAdminMyChatRoomId(token);
  if (!roomId) return { ok: false, reason: 'no_room' };
  const r = await notif.sendChatworkRoom(roomId, text, { token });
  if (!r.ok) console.warn(`[bank-transfer] マイチャット送信に失敗 reason=${r.reason}`);
  return r;
}

function chatInfo(title, lines) {
  return `[info][title]${title}[/title]${lines.filter(Boolean).join('\n')}[/info]`;
}

// ---------- preview_token ----------
// ids には「plan に含めた payout_record_id」だけを入れる（除外済みは入れない・レビュー #1）。
// jti は使い捨て判定用（request が request_summary.preview_jti に保存し、同じ jti の batch があれば 409 preview_used・レビュー #2b）
function signPreviewToken({ year, month, payoutRecordIds, transferDesignatedDate, hash, requesterId, connectionId, totalCount, totalAmount, totalFee, now = Date.now(), jti = crypto.randomUUID() }) {
  return signState({
    v: 2,
    jti: String(jti),
    y: Number(year), m: Number(month),
    ids: [...new Set(payoutRecordIds)].map(String).sort(),
    d: String(transferDesignatedDate),
    h: hash,
    u: String(requesterId),
    c: String(connectionId),
    n: Number(totalCount), t: Number(totalAmount), f: totalFee == null ? null : Number(totalFee),
    exp: now + PREVIEW_TOKEN_TTL_MS,
  }, stateSecret());
}

function verifyPreviewToken(token, now = Date.now()) {
  const p = verifyState(String(token || ''), stateSecret(), now);
  if (!p || p.v !== 2 || !p.jti || !Array.isArray(p.ids) || !p.h || !p.u || !p.d) return null;
  return p;
}

// ---------- 明細の入力集め ----------
async function loadPlanInputs({ year, month, payoutRecordIds }) {
  const ids = [...new Set((payoutRecordIds || []).map(String))];
  if (!ids.length) return { records: [], notFoundIds: [], users: [], invoices: [], blockedUserIds: new Set() };

  const { data: records, error: rErr } = await supabase
    .from('payout_records').select('id, user_id, year, month, status, invoice_amount, amount_source, paid_at').in('id', ids);
  if (rErr) throw new Error(`payout_records 取得失敗: ${rErr.message}`);
  const found = new Set((records || []).map(r => r.id));
  const notFoundIds = ids.filter(id => !found.has(id));
  const userIds = [...new Set((records || []).map(r => r.user_id).filter(Boolean))];
  if (!userIds.length) return { records: records || [], notFoundIds, users: [], invoices: [], blockedUserIds: new Set() };

  const [{ data: users, error: uErr }, { data: invoices, error: iErr }, blockedUserIds] = await Promise.all([
    supabase.from('users').select(USER_COLUMNS).in('id', userIds),
    supabase.from('invoices').select(INVOICE_COLUMNS).in('issuer_id', userIds).eq('year', year).eq('month', month)
      .is('invoice_type', null).in('status', plan.BILLED_INVOICE_STATUSES),
    loadBlockedUserIds({ year, month, userIds }),
  ]);
  if (uErr) throw new Error(`users 取得失敗: ${uErr.message}`);
  if (iErr) throw new Error(`invoices 取得失敗: ${iErr.message}`);
  return { records: records || [], notFoundIds, users: users || [], invoices: invoices || [], blockedUserIds };
}

/** 同月に有効な依頼（requested〜completed）の明細がある user_id */
async function loadBlockedUserIds({ year, month, userIds }) {
  const { data: batches, error } = await supabase
    .from('payout_transfer_batches').select('id').eq('year', year).eq('month', month).in('status', plan.BLOCKING_BATCH_STATUSES);
  if (error) throw new Error(`payout_transfer_batches 取得失敗: ${error.message}`);
  const batchIds = (batches || []).map(b => b.id);
  if (!batchIds.length) return new Set();
  const { data: items, error: iErr } = await supabase
    .from('payout_transfer_items').select('batch_id, user_id, status').in('batch_id', batchIds).in('user_id', userIds);
  if (iErr) throw new Error(`payout_transfer_items 取得失敗: ${iErr.message}`);
  // 明細が failed / returned で終わった人は再依頼できる（判定は純関数・jest あり）
  return plan.blockedUserIdsFromItems(batches, items);
}

/** 明細を組み立てる（preview / request 共用） */
async function buildPlan({ year, month, payoutRecordIds, now = Date.now() }) {
  const inputs = await loadPlanInputs({ year, month, payoutRecordIds });
  return plan.planTransferItems({ ...inputs, year, month, now });
}

// ---------- API レスポンス整形（口座は下4桁のみ） ----------
function batchToJson(b, items) {
  if (!b) return null;
  const out = {
    id: b.id,
    connection_id: b.connection_id,
    year: b.year,
    month: b.month,
    transfer_designated_date: b.transfer_designated_date,
    transfer_data_name: b.transfer_data_name,
    total_count: b.total_count,
    total_amount: b.total_amount,
    total_fee: b.fee_precheck && b.fee_precheck.total_fee != null ? Number(b.fee_precheck.total_fee) : null,
    fee_precheck: b.fee_precheck || null,
    request_summary: b.request_summary || null,
    apply_no: b.apply_no || null,
    result_code: b.result_code || null,
    status: b.status,
    status_label: BATCH_STATUS_LABELS[b.status] || b.status,
    requested_by: b.requested_by || null,
    requested_at: b.requested_at || null,
    approved_at: b.approved_at || null,
    completed_at: b.completed_at || null,
    last_polled_at: b.last_polled_at || null,
    last_error: b.last_error || null,
    created_at: b.created_at || null,
    updated_at: b.updated_at || null,
  };
  if (items) out.items = items.map(itemToJson);
  return out;
}

const BATCH_STATUS_LABELS = {
  requesting: '送信結果を確認中', requested: '依頼中', awaiting_approval: '承認待ち', approved: '承認済（予約中）', processing: '手続中',
  completed: '完了', expired: '期限切れ', cancelled: '取消', failed: '失敗',
};
const ITEM_STATUS_LABELS = { pending: '未完了', completed: '完了', returned: '資金返却', failed: '不成立' };

function itemToJson(it, user) {
  if (!it) return null;
  return {
    id: it.id,
    batch_id: it.batch_id,
    payout_record_id: it.payout_record_id,
    user_id: it.user_id,
    display_name: user ? plan.displayNameOf(user) : (it.display_name || null),
    item_id: it.item_id,
    bank_code: it.bank_code,
    branch_code: it.branch_code,
    account_type_code: it.account_type_code,
    account_number_last4: maskAccountNumber(it.account_number),
    beneficiary_name: it.beneficiary_name,
    amount: it.amount,
    invoice_id: it.invoice_id || null,
    amount_source: it.amount_source,
    gross_amount: it.gross_amount,
    tax_amount: it.tax_amount,
    withholding_amount: it.withholding_amount,
    status: it.status,
    status_label: ITEM_STATUS_LABELS[it.status] || it.status,
    error_detail: it.error_detail || null,
    created_at: it.created_at || null,
    updated_at: it.updated_at || null,
  };
}

async function loadBatch(id) {
  const { data, error } = await supabase.from('payout_transfer_batches').select(BATCH_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`payout_transfer_batches 取得失敗: ${error.message}`);
  return data || null;
}

async function loadItems(batchId) {
  const { data, error } = await supabase.from('payout_transfer_items').select(ITEM_COLUMNS).eq('batch_id', batchId).order('item_id', { ascending: true });
  if (error) throw new Error(`payout_transfer_items 取得失敗: ${error.message}`);
  return data || [];
}

async function loadUsersMap(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await supabase.from('users').select(USER_COLUMNS).in('id', ids);
  return new Map((data || []).map(u => [u.id, u]));
}

async function updateBatch(id, patch) {
  const { data, error } = await supabase
    .from('payout_transfer_batches').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select(BATCH_COLUMNS).single();
  if (error) throw new Error(`payout_transfer_batches 更新失敗: ${error.message}`);
  return data;
}

// ---------- 依頼受付後の要約（§1-6） ----------
function buildRequestSummaryText({ batch, items, envName }) {
  const lines = [
    `受付番号: ${batch.apply_no || '-'}`,
    `対象: ${batch.year}年${batch.month}月分 ／ 振込指定日 ${batch.transfer_designated_date}`,
    `件数: ${batch.total_count}件 ／ 合計: ${yen(batch.total_amount)}${batch.fee_precheck && batch.fee_precheck.total_fee != null ? `（手数料 ${yen(batch.fee_precheck.total_fee)}）` : ''}`,
    `状態: ${BATCH_STATUS_LABELS[batch.status] || batch.status}${batch.result_code === '2' ? '（銀行画面での承認が必要です）' : ''}`,
    envName === 'staging' ? '※ 開発環境（sunabar）への依頼です' : null,
    '',
    ...items.map(it => `・${it.display_name || it.beneficiary_name} ${it.account_number_last4 || maskAccountNumber(it.account_number)} ${yen(it.amount)}${it.amount_source === 'pdf' ? '（請求書なし・PDF額）' : ''}`),
    '',
    '銀行アプリ／ブックマークから入って、この内容と一致することを確認してから承認してください（メールのリンクは踏まない）。',
  ];
  return chatInfo('🏦 総合振込を依頼しました', lines);
}

// ---------- 依頼結果照会 → 状況照会 → 反映 ----------
function parseStatusResponse(statusRes) {
  const details = Array.isArray(statusRes?.bulkTransferDetails) ? statusRes.bulkTransferDetails : [];
  const d = details[0] || null;
  if (!d) return { transferStatus: null, infos: [], detailAvailable: false, totalFee: null };
  const responses = Array.isArray(d.bulktransferResponses) ? d.bulktransferResponses : [];
  const infos = responses.flatMap(r => (Array.isArray(r.bulkTransferInfos) ? r.bulkTransferInfos : []));
  return {
    transferStatus: d.transferStatus != null ? String(d.transferStatus) : null,
    transferStatusName: d.transferStatusName || aozora.TRANSFER_STATUS_NAMES[String(d.transferStatus)] || null,
    infos,
    detailAvailable: statusRes.detailInfoResult === true,
    totalFee: d.totalFee != null ? Number(d.totalFee) : null,
    applyStatus: (((d.transferApplies || [])[0] || {}).transferApplyDetails || []).map(x => x.applyStatus).find(Boolean) || null,
  };
}

/**
 * 1 つの batch を銀行に照会して DB に反映する。
 * @returns {Promise<{ batch: object, items: object[], changed: boolean, resultCode: string|null, transferStatus: string|null }>}
 */
/**
 * 明細の status 変更を (batch_id, item_id) の upsert で一括反映する（レビュー #13）。
 * upsert は INSERT ... ON CONFLICT なので NOT NULL 列をすべて含めた完全な行で送る。
 */
async function upsertItemPatches(items, patches, nowIso = new Date().toISOString()) {
  if (!patches || !patches.length) return;
  const byId = new Map(items.map(it => [it.id, it]));
  const rows = patches.map(p => {
    const it = byId.get(p.id);
    if (!it) return null;
    const { created_at, ...rest } = it;
    return { ...rest, status: p.status, error_detail: p.error_detail ?? null, updated_at: nowIso };
  }).filter(Boolean);
  if (!rows.length) return;
  const { error } = await supabase.from('payout_transfer_items').upsert(rows, { onConflict: 'batch_id,item_id' });
  if (error) throw new Error(`payout_transfer_items 一括更新に失敗: ${error.message}`);
}

/**
 * batch が expired / cancelled / failed になるとき、pending の明細を failed に落とす（レビュー #2）。
 * 部分ユニークインデックス uq_payout_transfer_items_active_record（pending/completed）から外れ、同じ振込レコードを再依頼できる。
 */
async function failPendingItems(batchId, reason, items = null) {
  const list = items || await loadItems(batchId);
  const patches = plan.itemsToFailOnTerminal(list, reason);
  await upsertItemPatches(list, patches);
  return patches;
}

/** 状況照会（明細つき）を bulktransferItemKey で全ページ取得する（レビュー #3） */
async function fetchAllTransferInfos(conn, batch, opts) {
  let statusRes = null;
  let infos = [];
  let key = 1;
  let pages = 0;
  const maxPages = Math.ceil((Number(batch.total_count) || 1) / 500) + 1;
  while (pages < maxPages) {
    const res = await aozora.bulkTransferStatus(conn, { accountId: conn.account_id, applyNo: batch.apply_no, detail: true, itemKey: key > 1 ? key : undefined }, opts);
    const parsed = parseStatusResponse(res);
    if (!statusRes) statusRes = { ...parsed };
    if (!parsed.detailAvailable) break; // 依頼完了直後は明細が読めない（10 分程度）
    infos = infos.concat(parsed.infos);
    pages++;
    const next = plan.nextItemKeyFor({ startKey: key, fetchedCount: parsed.infos.length, totalCount: batch.total_count });
    if (!next) break;
    key = next;
  }
  return { ...(statusRes || { transferStatus: null, detailAvailable: false, totalFee: null }), infos, pages };
}

async function pollBatch(batch, conn, { actorUserId = null, req = null } = {}) {
  const nowIso = new Date().toISOString();
  const prevStatus = batch.status;
  const onRefreshed = (c) => audit({ actorUserId, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });

  if (!batch.apply_no) {
    // requesting（応答待ち）は retryRequestingBatch の担当。ここでは触らない
    return { batch, items: await loadItems(batch.id), changed: false, resultCode: null, transferStatus: null };
  }

  let resultRes;
  try {
    resultRes = await aozora.bulkTransferRequestResult(conn, { accountId: conn.account_id, applyNo: batch.apply_no }, { onRefreshed });
  } catch (e) {
    const detail = e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message };
    await updateBatch(batch.id, { last_polled_at: nowIso, last_error: `依頼結果照会に失敗: ${e.message}` });
    await audit({ actorUserId, action: 'error', batchId: batch.id, connectionId: conn.id, detail: { step: 'request-result', ...detail }, req });
    throw e;
  }
  const resultCode = resultRes.resultCode != null ? String(resultRes.resultCode) : null;
  const patch = { last_polled_at: nowIso, last_error: null, result_code: ['1', '2', '8'].includes(resultCode) ? resultCode : batch.result_code };
  const summary = batch.request_summary || {};
  // 取消依頼を出した／出そうとして応答が消えた（cancel_attempted_at）あとは「最後の依頼＝取消」の結果コードになる（レビュー #5 / #8）
  const cancelRequested = !!(summary.cancel_requested_at || summary.cancel_attempted_at);
  let items = await loadItems(batch.id);
  let transferStatus = null;
  let infos = [];
  let detailAvailable = false;
  let itemPatches = [];
  let unresolved = [];

  const decided = plan.decideBatchFromResultCode({ resultCode, status: batch.status, cancelRequested });
  if (decided.status) patch.status = decided.status;
  if (decided.note) patch.last_error = decided.note;
  if (decided.clearCancel) {
    const { cancel_requested_at, cancel_attempted_at, cancel_result_code, ...rest } = summary;
    patch.request_summary = { ...rest, cancel_expired_at: nowIso };
  }
  if (decided.inquire) {
    if (!batch.approved_at) patch.approved_at = resultRes.applyEndDatetime || nowIso;
    let fetched;
    try {
      fetched = await fetchAllTransferInfos(conn, batch, { onRefreshed });
    } catch (e) {
      const detail = e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message };
      await updateBatch(batch.id, { ...patch, last_error: `状況照会に失敗: ${e.message}` });
      await audit({ actorUserId, action: 'error', batchId: batch.id, connectionId: conn.id, detail: { step: 'status', ...detail }, req });
      throw e;
    }
    transferStatus = fetched.transferStatus;
    infos = fetched.infos;
    detailAvailable = fetched.detailAvailable;
    const mapped = plan.mapTransferStatus(transferStatus);
    if (mapped) {
      patch.status = mapped;
    } else if (!transferStatus) {
      // 承認済みだが状況照会にまだ出てこない（依頼中・作成中は照会対象外）→ approved のまま次回
      patch.status = ['requesting', 'requested', 'awaiting_approval'].includes(batch.status) ? 'approved' : batch.status;
    }
    if (fetched.totalFee != null) patch.fee_precheck = { ...(batch.fee_precheck || {}), actual_total_fee: fetched.totalFee };
    // 明細の反映。info が無い item が残るあいだは completed にしない（レビュー #3）
    const resolved = plan.resolveItemStatuses({ items, infos, transferStatus });
    itemPatches = resolved.patches;
    unresolved = resolved.unresolved;
    if (mapped === 'completed' && unresolved.length) {
      patch.status = 'processing';
      patch.last_error = detailAvailable
        ? `明細 ${unresolved.length} 件（番号 ${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? '…' : ''}）が状況照会で確認できません。次回の照会で再確認します`
        : '銀行側で明細がまだ読めません（依頼完了後 10 分程度）。次回の照会で確認します';
    }
  }

  const finalStatus = patch.status || batch.status;
  // 終了状態（expired / cancelled / failed）では pending の明細を failed に落として再依頼できるようにする（レビュー #2）
  if (['expired', 'cancelled', 'failed'].includes(finalStatus)) {
    const reasonByStatus = { expired: 'batch_expired', cancelled: 'batch_cancelled', failed: 'batch_failed' };
    const already = new Set(itemPatches.map(p => p.id));
    for (const p of plan.itemsToFailOnTerminal(items, reasonByStatus[finalStatus])) if (!already.has(p.id)) itemPatches.push(p);
  }
  await upsertItemPatches(items, itemPatches, nowIso);
  if (itemPatches.length) items = await loadItems(batch.id);

  // 完了（または終了状態）になったら completed_at を必ず立てる（源泉徴収台帳はこれを支払日に使う。items に completed_at 列は無い）
  if (plan.TERMINAL_BATCH_STATUSES.includes(finalStatus) && !batch.completed_at) patch.completed_at = nowIso;
  // 終了状態になったら取消マーカーは不要
  if (plan.TERMINAL_BATCH_STATUSES.includes(finalStatus) && (summary.cancel_requested_at || summary.cancel_attempted_at) && !patch.request_summary) {
    const { cancel_requested_at, cancel_attempted_at, ...rest } = summary;
    patch.request_summary = rest;
  }

  const updated = await updateBatch(batch.id, patch);
  const changed = updated.status !== prevStatus || itemPatches.length > 0;
  await audit({
    actorUserId, action: 'poll', batchId: batch.id, connectionId: conn.id,
    detail: { result_code: resultCode, transfer_status: transferStatus, status_before: prevStatus, status_after: updated.status, items_changed: itemPatches.length, unresolved: unresolved.length, detail_available: detailAvailable },
    req,
  });

  // 完了 → payout_records 消し込み＋本人へ通知（既存の「振込完了→送信」と同じ文面・経路）
  if (updated.status === 'completed' && (prevStatus !== 'completed' || itemPatches.length)) {
    await settleCompletedItems(updated, items, { actorUserId });
  }
  // 期限切れ・失敗・取消・返却 → 管理者マイチャットへ
  if (changed) await notifyBatchOutcome(updated, items, { prevStatus, itemPatches });

  return { batch: updated, items, changed, resultCode, transferStatus };
}

/** completed の明細 → payout_records を paid にして本人へ振込完了メッセージ */
async function settleCompletedItems(batch, items, { actorUserId = null } = {}) {
  const done = items.filter(it => it.status === 'completed' && it.payout_record_id);
  if (!done.length) return;
  const { data: recs } = await supabase.from('payout_records').select('id, user_id, year, month, status, memo, paid_via').in('id', done.map(it => it.payout_record_id));
  const recById = new Map((recs || []).map(r => [r.id, r]));
  const users = await loadUsersMap(done.map(it => it.user_id));
  const paidAt = batch.transfer_designated_date ? `${batch.transfer_designated_date}T00:00:00+09:00` : new Date().toISOString();
  let notified = 0;
  for (const it of done) {
    const rec = recById.get(it.payout_record_id);
    if (!rec || rec.status === 'paid') continue; // 手動で消し込み済みなら触らない（二重通知防止）
    const user = users.get(it.user_id);
    const text = buildPayoutMessage({ month: batch.month });
    let sent = { ok: false, body: null };
    if (user) {
      try { sent = await notifyMember(user, { chatwork: text, slack: text }); } catch (e) { sent = { ok: false, reason: e.message }; }
    }
    // 台帳の元データを支払時点で凍結（§5 追補）。請求書を後から直しても源泉額は変わらない
    let ledgerSnapshot = null;
    try { ledgerSnapshot = await loadLedgerSnapshotForRecord(rec, it.amount); } catch (e) { console.warn(`[bank-transfer] ledger_snapshot 作成失敗 record=${rec.id}: ${e.message}`); }
    const patch = {
      status: 'paid',
      paid_at: new Date(paidAt).toISOString(),
      paid_via: 'aozora_api',
      transfer_item_id: it.id,
      ledger_snapshot: ledgerSnapshot,
      updated_at: new Date().toISOString(),
    };
    if (sent.ok) { patch.message_sent_at = new Date().toISOString(); patch.message_body = sent.body || text; notified++; }
    const { error } = await supabase.from('payout_records').update(patch).eq('id', rec.id);
    if (error) console.warn(`[bank-transfer] payout_records 消し込み失敗 record=${rec.id}: ${error.message}`);
    if (!sent.ok) console.warn(`[bank-transfer] 振込完了の本人通知に失敗 user=${it.user_id}: ${sent.reason || '-'}`);
  }
  await audit({ actorUserId, action: 'complete', batchId: batch.id, connectionId: batch.connection_id, detail: { settled: done.length, notified } });
}

async function notifyBatchOutcome(batch, items, { prevStatus, itemPatches }) {
  const head = `受付番号 ${batch.apply_no || '-'} ／ ${batch.year}年${batch.month}月分 ${batch.total_count}件・${yen(batch.total_amount)}`;
  if (batch.status === 'expired' && prevStatus !== 'expired') {
    await sendAdminMyChat(chatInfo('⏰ 総合振込の依頼が期限切れになりました', [head, '承認されないまま期限が切れたため、送金されていません。振込管理からもう一度依頼してください。']));
    return;
  }
  if (batch.status === 'failed' && prevStatus !== 'failed') {
    await sendAdminMyChat(chatInfo('❌ 総合振込が手続不成立になりました', [head, batch.last_error || '残高不足・限度額超過・出金口座規制などが考えられます。銀行画面で原因を確認してください。']));
    return;
  }
  if (batch.status === 'cancelled' && prevStatus !== 'cancelled') {
    await sendAdminMyChat(chatInfo('🚫 総合振込の依頼が取り消されました', [head]));
    return;
  }
  const bad = (itemPatches || []).filter(p => p.status === 'returned' || p.status === 'failed');
  if (bad.length) {
    const users = await loadUsersMap(items.map(it => it.user_id));
    const lines = bad.map(p => {
      const it = items.find(x => x.id === p.id);
      const u = it ? users.get(it.user_id) : null;
      return `・${plan.displayNameOf(u)} ${maskAccountNumber(it?.account_number)} ${yen(it?.amount)} → ${ITEM_STATUS_LABELS[p.status]}`;
    });
    await sendAdminMyChat(chatInfo('⚠ 総合振込で振り込めなかった明細があります', [head, ...lines, '口座情報を本人に確認し、手動振込か再依頼で対応してください。']));
  }
  if (batch.status === 'completed' && prevStatus !== 'completed') {
    const okCount = items.filter(it => it.status === 'completed').length;
    await sendAdminMyChat(chatInfo('✅ 総合振込が完了しました', [head, `完了 ${okCount}件 ／ 振込管理を自動で消し込み、本人へ振込完了メッセージを送りました。`]));
  }
}

// ---------- 台帳スナップショット（§5 追補） ----------
/** 同月の提出済/承認済メンバー請求書から ledger_snapshot を組み立てる（手動消し込みと API 完了で共用） */
async function loadLedgerSnapshotForRecord(rec, amount) {
  if (!rec || !rec.user_id) return plan.buildLedgerSnapshot({ amount, invoices: [] });
  const { data: invoices, error } = await supabase
    .from('invoices').select(INVOICE_COLUMNS)
    .eq('issuer_id', rec.user_id).eq('year', rec.year).eq('month', rec.month)
    .is('invoice_type', null).in('status', plan.BILLED_INVOICE_STATUSES);
  if (error) throw new Error(`invoices 取得失敗: ${error.message}`);
  return plan.buildLedgerSnapshot({ amount, invoices: invoices || [] });
}

// ---------- 依頼の送信（§3-2: DB に書いてから銀行へ・同じ idempotency_key で再送） ----------
/**
 * requesting の batch を銀行へ送り、応答を DB に反映する。request ルート・retry ルート・ワーカで共用。
 * @returns {Promise<{ outcome: 'accepted'|'pending'|'failed', batch: object, resultCode: string|null, error: Error|null }>}
 *   accepted … 受付（apply_no あり・status は result_code 1→approved / 2→awaiting_approval）
 *   pending  … 応答が消えた（timeout / 接続断 / 5xx）。requesting のまま last_error を記録
 *   failed   … 銀行が確定的に拒否（4xx）。status=failed
 */
async function sendBatchRequest(batch, items, conn, { actorUserId = null, req = null, attempt = 1 } = {}) {
  if (!batch.idempotency_key) throw new Error('idempotency_key がありません');
  const nowIso = new Date().toISOString();
  const onRefreshed = (c) => audit({ actorUserId, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });
  const body = plan.buildBulkTransferBody({
    accountId: conn.account_id,
    transferDesignatedDate: batch.transfer_designated_date,
    transferDataName: batch.transfer_data_name,
    items: items.map(it => ({ ...it, amount: Number(it.amount) })),
  });
  let result;
  try {
    result = await aozora.bulkTransferRequest(conn, body, batch.idempotency_key, { onRefreshed });
  } catch (e) {
    const detail = e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message };
    if (aozora.isLostResponse(e) || !(e instanceof aozora.AozoraApiError)) {
      // 受け付けられている可能性がある → requesting のまま残し、同じキーで再送できるようにする
      const updated = await updateBatch(batch.id, {
        status: 'requesting',
        last_error: `銀行の応答が返りませんでした（${e.message}）。同じ冪等キーで再送するか、状況照会で確認します`,
        request_summary: { ...(batch.request_summary || {}), send_attempts: (batch.request_summary?.send_attempts || 0) + 1, last_attempt_at: nowIso },
      });
      await audit({ actorUserId, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'request', outcome: 'pending', attempt, ...detail }, req });
      console.warn(`[bank-transfer] 依頼の応答が消えました batch=${batch.id} attempt=${attempt}: ${e.message}`);
      return { outcome: 'pending', batch: updated, resultCode: null, error: e };
    }
    const failed = await updateBatch(batch.id, { status: 'failed', completed_at: nowIso, last_error: `依頼に失敗: ${e.message}` });
    await failPendingItems(batch.id, 'request_rejected', items); // 明細を failed に落として再依頼できるようにする
    await audit({ actorUserId, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'request', outcome: 'failed', attempt, ...detail }, req });
    await sendAdminMyChat(chatInfo('❌ 総合振込の依頼が銀行に受け付けられませんでした', [
      `対象: ${batch.year}年${batch.month}月分（${batch.total_count}件・${yen(batch.total_amount)}）`,
      `理由: ${e.message}`,
      '依頼は登録されていません。内容を直してからもう一度依頼してください。',
    ]));
    return { outcome: 'failed', batch: failed, resultCode: null, error: e };
  }
  // 2xx でも受付番号や結果コードが揃っていなければ「応答消失」扱い（requesting のまま・同じキーで再送。レビュー #4）
  const cls = plan.classifyRequestResponse(result);
  if (cls.outcome !== 'accepted') {
    const updated = await updateBatch(batch.id, {
      status: 'requesting',
      last_error: `銀行の応答が不完全でした（${cls.reason}）。同じ冪等キーで再送するか、状況照会で確認します`,
      request_summary: { ...(batch.request_summary || {}), send_attempts: (batch.request_summary?.send_attempts || 0) + 1, last_attempt_at: nowIso },
    });
    await audit({ actorUserId, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'request', outcome: 'pending', attempt, reason: cls.reason, result_code: result?.resultCode ?? null }, req });
    console.warn(`[bank-transfer] 依頼の応答が不完全 batch=${batch.id} attempt=${attempt}: ${cls.reason}`);
    return { outcome: 'pending', batch: updated, resultCode: null, error: new aozora.AozoraApiError({ status: null, errorCode: 'incomplete_response', errorMessage: cls.reason }) };
  }
  const resultCode = cls.resultCode;
  const updated = await updateBatch(batch.id, {
    apply_no: cls.applyNo,
    result_code: resultCode,
    status: cls.status,
    approved_at: resultCode === '1' ? (cls.approvedAt || nowIso) : null,
    last_polled_at: nowIso,
    last_error: null,
    request_summary: { ...(batch.request_summary || {}), send_attempts: (batch.request_summary?.send_attempts || 0) + 1, accepted_at: nowIso },
  });
  await audit({ actorUserId, action: 'request', connectionId: conn.id, batchId: batch.id, detail: { apply_no: updated.apply_no, result_code: resultCode, count: updated.total_count, total_amount: updated.total_amount, idempotency_key: batch.idempotency_key, attempt }, req });
  console.log(`[bank-transfer] 総合振込を依頼しました batch=${batch.id} apply_no=${updated.apply_no} result=${resultCode} count=${updated.total_count} attempt=${attempt}`);
  const summaryItems = (updated.request_summary && updated.request_summary.items) || plan.summarizeItems(items);
  await sendAdminMyChat(buildRequestSummaryText({ batch: updated, items: summaryItems, envName: conn.environment }));
  return { outcome: 'accepted', batch: updated, resultCode, error: null };
}

/**
 * 応答が消えた requesting の batch が、実は銀行に受け付けられていないかを一括照会で確かめる。
 * 同じ振込データ名＋件数＋合計の受付があれば apply_no を取り込んで awaiting_approval（または状況に応じた status）にする。
 * @returns {Promise<{ found: boolean, batch: object }>}
 */
async function reconcileRequestingBatch(batch, conn, { actorUserId = null, req = null } = {}) {
  const onRefreshed = (c) => audit({ actorUserId, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });
  const dateFrom = todayJst(new Date(batch.requested_at || batch.created_at));
  const dateTo = todayJst();
  let nextItemKey = null;
  for (let page = 0; page < 5; page++) {
    const res = await aozora.bulkTransferStatusByDate(conn, { accountId: conn.account_id, dateFrom, dateTo, nextItemKey }, { onRefreshed });
    const hit = plan.matchPendingAcceptance(res, batch);
    if (hit) {
      const mapped = plan.mapTransferStatus(hit.transferStatus) || 'awaiting_approval';
      const nowIso = new Date().toISOString();
      const updated = await updateBatch(batch.id, {
        apply_no: hit.applyNo,
        status: mapped,
        result_code: mapped === 'awaiting_approval' ? '2' : (mapped === 'expired' ? '8' : '1'),
        last_polled_at: nowIso,
        last_error: null,
        request_summary: { ...(batch.request_summary || {}), reconciled_at: nowIso },
      });
      await audit({ actorUserId, action: 'poll', connectionId: conn.id, batchId: batch.id, detail: { step: 'reconcile', apply_no: hit.applyNo, transfer_status: hit.transferStatus, status_after: updated.status }, req });
      console.log(`[bank-transfer] 応答待ちの依頼が受付済みでした batch=${batch.id} apply_no=${hit.applyNo}`);
      const summaryItems = (updated.request_summary && updated.request_summary.items) || [];
      await sendAdminMyChat(buildRequestSummaryText({ batch: updated, items: summaryItems, envName: conn.environment }));
      return { found: true, batch: updated };
    }
    if (!res?.hasNext || !res.nextItemKey) break;
    nextItemKey = res.nextItemKey;
  }
  return { found: false, batch };
}

/**
 * requesting の batch を「照会 → 無ければ同じキーで再送」する（retry ルートとワーカで共用）。
 * @param {{ auto?: boolean }} opts auto=true はワーカからの自動再送（上限 REQUESTING_MAX_AUTO_RETRIES 回・超えたら failed）
 */
async function retryRequestingBatch(batch, conn, { actorUserId = null, req = null, auto = false } = {}) {
  if (batch.status !== 'requesting') throw new Error(`requesting ではありません（${batch.status}）`);
  const rec = await reconcileRequestingBatch(batch, conn, { actorUserId, req });
  if (rec.found) return { outcome: 'accepted', reconciled: true, batch: rec.batch, resultCode: rec.batch.result_code };
  const autoRetries = Number(batch.request_summary?.auto_retries || 0);
  if (auto && autoRetries >= REQUESTING_MAX_AUTO_RETRIES) {
    const nowIso = new Date().toISOString();
    const failed = await updateBatch(batch.id, { status: 'failed', completed_at: nowIso, last_error: '銀行の応答が無いまま再送しても確認できませんでした。銀行画面で依頼が残っていないか確認してください' });
    await failPendingItems(batch.id, 'request_unconfirmed');
    await audit({ actorUserId, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'retry', outcome: 'gave_up', auto_retries: autoRetries } });
    await sendAdminMyChat(chatInfo('⚠ 総合振込の依頼が確認できないまま止まりました', [
      `対象: ${batch.year}年${batch.month}月分（${batch.total_count}件・${yen(batch.total_amount)}）`,
      '銀行画面で同じ依頼（振込データ名 ' + (batch.transfer_data_name || '-') + '）が残っていないか確認してください。残っていなければ、振込管理からもう一度依頼できます。',
    ]));
    return { outcome: 'failed', reconciled: false, batch: failed, resultCode: null };
  }
  const items = await loadItems(batch.id);
  const marked = auto
    ? await updateBatch(batch.id, { request_summary: { ...(batch.request_summary || {}), auto_retries: autoRetries + 1 } })
    : batch;
  const attempt = Number(marked.request_summary?.send_attempts || 0) + 1;
  const r = await sendBatchRequest(marked, items, conn, { actorUserId, req, attempt });
  return { ...r, reconciled: false };
}

// ---------- 口座変更の通知（§1-4） ----------
const BANK_COLS = ['bank_name', 'bank_code', 'branch_name', 'branch_code', 'account_type', 'account_number', 'account_holder_kana'];

function bankInfoChanged(before, after) {
  return BANK_COLS.some(c => String(before?.[c] ?? '') !== String(after?.[c] ?? ''));
}

/**
 * users の口座列が変わったとき、本人（privateOnly）と管理者マイチャットへ知らせる。
 * 呼び出し側は await しなくてよい（失敗してもメンバー更新は成功扱い）。
 */
async function notifyBankInfoChanged({ user, before, after, actor }) {
  if (!bankInfoChanged(before, after)) return { ok: false, reason: 'unchanged' };
  const from = maskAccountNumber(before?.account_number) || '（未設定）';
  const to = maskAccountNumber(after?.account_number) || '（未設定）';
  const changedCols = BANK_COLS.filter(c => String(before?.[c] ?? '') !== String(after?.[c] ?? ''));
  const when = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const actorName = actor ? (actor.nickname || actor.full_name || '') : '';
  const selfChange = actor && user && String(actor.id) === String(user.id);
  const memberText = [
    '口座情報が変更されました。',
    `口座番号: ${from} → ${to}`,
    `変更日時: ${when}${selfChange ? '' : `（変更した人: ${actorName || '管理者'}）`}`,
    '心当たりがなければ、すぐに髙橋まで連絡してください。',
    '※ 安全のため、変更から 7 日間は自動振込の対象になりません。',
  ].join('\n');
  const results = {};
  try {
    results.member = await notifyMember(user, { chatwork: memberText, slack: memberText }, { privateOnly: true });
  } catch (e) { results.member = { ok: false, reason: e.message }; }
  try {
    results.admin = await sendAdminMyChat(chatInfo('🏦 メンバーの口座情報が変更されました', [
      `メンバー: ${plan.displayNameOf(user)}`,
      `口座番号: ${from} → ${to}`,
      `変更した項目: ${changedCols.join(', ')}`,
      `変更した人: ${selfChange ? '本人' : (actorName || '不明')} ／ ${when}`,
      '本人に心当たりがあるか確認してください。7 日間は総合振込の対象外になります。',
    ]));
  } catch (e) { results.admin = { ok: false, reason: e.message }; }
  return { ok: true, results };
}

module.exports = {
  PREVIEW_TOKEN_TTL_MS,
  REAUTH_TTL_MS,
  REQUESTING_RETRY_AFTER_MS,
  REQUESTING_MAX_AUTO_RETRIES,
  reauthStatus,
  reauthRedirect,
  upsertItemPatches,
  failPendingItems,
  fetchAllTransferInfos,
  loadLedgerSnapshotForRecord,
  sendBatchRequest,
  reconcileRequestingBatch,
  retryRequestingBatch,
  USER_COLUMNS,
  BATCH_COLUMNS,
  ITEM_COLUMNS,
  BATCH_STATUS_LABELS,
  ITEM_STATUS_LABELS,
  BANK_COLS,
  todayJst,
  yen,
  audit,
  sendAdminMyChat,
  chatInfo,
  signPreviewToken,
  verifyPreviewToken,
  loadPlanInputs,
  loadBlockedUserIds,
  buildPlan,
  batchToJson,
  itemToJson,
  loadBatch,
  loadItems,
  loadUsersMap,
  updateBatch,
  buildRequestSummaryText,
  parseStatusResponse,
  pollBatch,
  settleCompletedItems,
  notifyBatchOutcome,
  bankInfoChanged,
  notifyBankInfoChanged,
};

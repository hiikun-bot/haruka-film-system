// routes/bank-transfer.js
// =============================================================
// 🏦 GMOあおぞらネット銀行 API による総合振込（ADR 054 Stage B）
//
// mount: server.js で app.use('/api/haruka/admin', require('./routes/bank-transfer'))
//        を app.use('/api/haruka', harukaRouter) より前に置く。
//        ここに無いパスは next() で routes/haruka.js の /admin/payouts* 等へ流れる。
//
// ルート（すべて requireAuth + requirePermission('payout.transfer') + requireSuperAdmin。
//         ENABLE_AOZORA_TRANSFER が true でなければ 404）:
//   GET  /bank/connection                      接続状態（トークンは返さない）
//   GET  /bank/connect?next=                   認可 URL へリダイレクト
//   GET  /bank/callback                        code → token → 口座 ID → 暗号化保存
//   POST /bank/disconnect                      revoked_at を立ててトークン列を NULL に
//   POST /payouts/transfer/preview             明細の組み立て＋手数料事前照会 → preview_token
//   POST /payouts/transfer/request             再認証チェック → 依頼 → batches/items 保存 → マイチャット要約
//   GET  /payouts/transfer/batches?year&month  一覧
//   GET  /payouts/transfer/batches/:id         詳細（口座は下4桁のみ）
//   POST /payouts/transfer/batches/:id/poll    依頼結果照会 → 状況照会を手動実行
//   POST /payouts/transfer/batches/:id/cancel  総合振込取消依頼
//
// 権限（ADR 015）: VIEW AS で昇格できない。requireSuperAdmin は実ユーザー（req.user）のメールで判定し、
//   requirePermission('payout.transfer') は実効ロール集合で判定する（両方必要）。
// ログに口座番号・受取人名・トークンを出さない。
// =============================================================

const express = require('express');
const crypto = require('crypto');

const supabase = require('../supabase');
const { requireAuth, requirePermission, requireSuperAdmin } = require('../auth');
const aozora = require('../utils/aozora-api');
const bt = require('../utils/bank-transfer');
const plan = require('../utils/bank-transfer-plan');
const googleLogin = require('../utils/google-login');

const router = express.Router();

const PATHS = ['/bank', '/payouts/transfer'];

// 機能フラグ OFF なら 404（ルート自体が無いのと同じ扱い）
router.use(PATHS, (req, res, next) => {
  if (!aozora.isEnabled()) return res.status(404).json({ error: 'この機能は有効になっていません（ENABLE_AOZORA_TRANSFER）' });
  next();
});
router.use(PATHS, requireAuth, requirePermission('payout.transfer'), requireSuperAdmin);

function stateSecret() {
  return process.env.SESSION_SECRET || 'video-ops-dev-secret-change-in-production';
}

function reauthState(req) {
  const at = Number(req.session?.reauth_at || 0);
  const remaining = at ? Math.max(0, bt.REAUTH_TTL_MS - (Date.now() - at)) : 0;
  return { ok: remaining > 0, remaining_sec: Math.floor(remaining / 1000) };
}

/** 戻り先 URL（Google ログインと同じ許可ホスト。AOZORA_CALLBACK_HOST があればそれを優先） */
function resolveBankCallbackUrl(req) {
  const c = aozora.getConfig();
  const reqHost = String(req.get('host') || '').split(',')[0].trim();
  const host = c.callbackHost ? googleLogin.normalizeHost(c.callbackHost) : googleLogin.normalizeHost(reqHost);
  if (!host) return null;
  const allowed = new Set(googleLogin.getAllowedHosts());
  if (c.callbackHost) allowed.add(googleLogin.normalizeHost(c.callbackHost));
  if (!allowed.has(host)) return null;
  const scheme = host.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${host}${aozora.CALLBACK_PATH}`;
}

function redirectBack(res, next, params) {
  const base = googleLogin.safeNext(next);
  const url = new URL(base, 'http://x');
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
  return res.redirect(url.pathname + url.search);
}

function apiErrorResponse(res, e, status = 502) {
  if (e instanceof aozora.AozoraApiError) {
    const code = e.status === 401 || e.phase === 'token' ? 'bank_auth' : 'bank_api';
    return res.status(e.status === 400 ? 422 : status).json({ error: e.message, code, bank_error: e.toJSON() });
  }
  console.error('[bank-transfer]', e);
  return res.status(500).json({ error: e.message || '処理に失敗しました' });
}

function parseYearMonth(body) {
  const year = Number(body?.year), month = Number(body?.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return { error: 'year が不正です' };
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: 'month が不正です' };
  return { year, month };
}

// ==================== 接続 ====================

// GET /api/haruka/admin/bank/connection
router.get('/bank/connection', async (req, res) => {
  try {
    const c = aozora.getConfig();
    const conn = await aozora.loadActiveConnection();
    let connectedByName = null;
    if (conn?.connected_by) {
      const { data: u } = await supabase.from('users').select('id, full_name, nickname').eq('id', conn.connected_by).maybeSingle();
      if (u) connectedByName = plan.displayNameOf(u);
    }
    res.json({
      enabled: true,
      environment: c.environment,
      configured: aozora.configProblems().length === 0,
      config_problems: aozora.configProblems(),
      scopes_requested: aozora.getScopes(),
      callback_url: resolveBankCallbackUrl(req),
      reauth: reauthState(req),
      google_reauth_available: googleLogin.isEnabled(),
      connection: conn ? {
        id: conn.id,
        provider: conn.provider,
        environment: conn.environment,
        account_id_last4: aozora.last4(conn.account_id),
        account_label: conn.account_label,
        scopes: conn.scopes,
        access_token_expires_at: conn.access_token_expires_at,
        has_refresh_token: !!conn.refresh_token_enc,
        connected_by: conn.connected_by,
        connected_by_name: connectedByName,
        connected_at: conn.connected_at,
        last_used_at: conn.last_used_at,
      } : null,
    });
  } catch (e) {
    console.error('[bank-transfer][GET connection]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/haruka/admin/bank/connect?next=/haruka.html?page=payout
router.get('/bank/connect', (req, res) => {
  const problems = aozora.configProblems();
  if (problems.length) return redirectBack(res, req.query.next, { bank_error: 'not_configured', bank_error_detail: problems.join(' / ') });
  const redirectUri = resolveBankCallbackUrl(req);
  if (!redirectUri) return redirectBack(res, req.query.next, { bank_error: 'host' });
  const { nonce, state } = googleLogin.newState({ secret: stateSecret(), next: req.query.next });
  const oidcNonce = crypto.randomBytes(16).toString('base64url');
  req.session.aozoraConnectNonce = nonce;
  req.session.aozoraOidcNonce = oidcNonce;
  const url = aozora.buildAuthorizeUrl({ state, redirectUri, nonce: oidcNonce });
  req.session.save(() => res.redirect(url));
});

// GET /api/haruka/admin/bank/callback?code&state
router.get('/bank/callback', async (req, res) => {
  const payload = googleLogin.verifyState(String(req.query.state || ''), stateSecret());
  const expectedNonce = req.session?.aozoraConnectNonce;
  const oidcNonce = req.session?.aozoraOidcNonce;
  if (req.session) { delete req.session.aozoraConnectNonce; delete req.session.aozoraOidcNonce; }
  const next = payload?.next;
  if (req.query.error) return redirectBack(res, next, { bank_error: req.query.error === 'access_denied' ? 'cancelled' : 'bank_failed', bank_error_detail: req.query.error_description || req.query.error });
  if (!payload || !expectedNonce || payload.nonce !== expectedNonce) return redirectBack(res, next, { bank_error: 'state' });
  if (!req.query.code) return redirectBack(res, next, { bank_error: 'bank_failed' });
  const redirectUri = resolveBankCallbackUrl(req);
  if (!redirectUri) return redirectBack(res, next, { bank_error: 'host' });

  try {
    const tokens = await aozora.exchangeCode({ code: String(req.query.code), redirectUri });
    if (tokens.id_token) {
      const v = aozora.verifyIdToken(tokens.id_token, { nonce: oidcNonce });
      if (!v.ok) {
        console.warn(`[bank-transfer] ID トークン検証に失敗: ${v.reason}`);
        return redirectBack(res, next, { bank_error: 'id_token', bank_error_detail: v.reason });
      }
    }
    const c = aozora.getConfig();
    let accountId = c.fixedAccountId;
    let accountLabel = null;
    if (accountId) {
      accountLabel = `口座ID ${aozora.last4(accountId)}（env 指定）`;
    } else {
      const list = await aozora.listAccountsWithToken(tokens.access_token);
      const acct = aozora.pickTransferAccount(list?.accounts);
      if (!acct) return redirectBack(res, next, { bank_error: 'no_account' });
      accountId = acct.accountId;
      accountLabel = aozora.accountLabelOf(acct);
    }
    const conn = await aozora.saveConnection({ tokens, accountId, accountLabel, connectedBy: req.user.id });
    await bt.audit({ actorUserId: req.user.id, action: 'connect', connectionId: conn.id, detail: { environment: conn.environment, scopes: conn.scopes, account_label: accountLabel, expires_at: conn.access_token_expires_at }, req });
    console.log(`[bank-transfer] 銀行 API に接続しました env=${conn.environment} connection=${conn.id}`);
    return redirectBack(res, next, { bank: 'connected' });
  } catch (e) {
    console.warn('[bank-transfer] callback 失敗:', e.message);
    await bt.audit({ actorUserId: req.user.id, action: 'error', detail: { step: 'callback', ...(e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message }) }, req });
    return redirectBack(res, next, { bank_error: 'bank_failed', bank_error_detail: e.message });
  }
});

// POST /api/haruka/admin/bank/disconnect
router.post('/bank/disconnect', async (req, res) => {
  try {
    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(404).json({ error: '接続がありません' });
    await aozora.revokeConnection(conn.id);
    await bt.audit({ actorUserId: req.user.id, action: 'disconnect', connectionId: conn.id, detail: { environment: conn.environment }, req });
    res.json({ ok: true });
  } catch (e) {
    console.error('[bank-transfer][POST disconnect]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 総合振込 ====================

// POST /api/haruka/admin/payouts/transfer/preview
// body { year, month, payout_record_ids: [], transfer_designated_date: 'YYYY-MM-DD' }
router.post('/payouts/transfer/preview', async (req, res) => {
  try {
    const ym = parseYearMonth(req.body);
    if (ym.error) return res.status(400).json({ error: ym.error });
    const ids = Array.isArray(req.body?.payout_record_ids) ? req.body.payout_record_ids.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'payout_record_ids を 1 件以上指定してください' });
    if (ids.length > 9999) return res.status(400).json({ error: '1 回の依頼は 9,999 件までです' });
    const date = plan.validateDesignatedDate(req.body?.transfer_designated_date, bt.todayJst());
    if (!date.ok) return res.status(400).json({ error: date.error });

    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });

    const planned = await bt.buildPlan({ year: ym.year, month: ym.month, payoutRecordIds: ids });
    if (!planned.items.length) {
      return res.status(422).json({ error: '依頼できる明細がありません', code: 'no_items', items: [], excluded: planned.excluded, warnings: planned.warnings, total_count: 0, total_amount: 0 });
    }

    const body = plan.buildBulkTransferBody({
      accountId: conn.account_id,
      transferDesignatedDate: date.value,
      transferDataName: plan.transferDataNameFor(ym.year, ym.month),
      items: planned.items,
    });
    const onRefreshed = (c) => bt.audit({ actorUserId: req.user.id, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });
    let feeRes;
    try {
      feeRes = await aozora.bulkTransferFeePrecheck(conn, body, { onRefreshed });
    } catch (e) {
      await bt.audit({ actorUserId: req.user.id, action: 'error', connectionId: conn.id, detail: { step: 'precheck', ...(e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message }) }, req });
      if (e instanceof aozora.AozoraApiError && e.transferErrorDetails.length) {
        // 明細ごとのエラーを該当メンバーに紐付けて返す
        const byItem = new Map(e.transferErrorDetails.map(t => [String(t.itemId), t]));
        const itemErrors = planned.items.filter(it => byItem.has(String(it.item_id))).map(it => ({
          item_id: it.item_id, payout_record_id: it.payout_record_id, user_id: it.user_id, display_name: it.display_name,
          errors: (byItem.get(String(it.item_id)).errorDetails || []).map(d => ({ code: d.errorDetailsCode || null, message: d.errorDetailsMessage || null })),
        }));
        return res.status(422).json({ error: e.message, code: 'precheck_failed', bank_error: e.toJSON(), item_errors: itemErrors, items: plan.summarizeItems(planned.items), excluded: planned.excluded });
      }
      return apiErrorResponse(res, e);
    }
    const feeDetails = Array.isArray(feeRes?.transferFeeDetails) ? feeRes.transferFeeDetails : [];
    const feeByItem = new Map(feeDetails.map(f => [String(f.itemId), Number(f.transferFee)]));
    const totalFee = feeRes?.totalFee != null ? Number(feeRes.totalFee) : feeDetails.reduce((s, f) => s + (Number(f.transferFee) || 0), 0);
    const items = plan.summarizeItems(planned.items).map(it => ({ ...it, fee: feeByItem.has(String(it.item_id)) ? feeByItem.get(String(it.item_id)) : null }));
    const hash = plan.planHash(planned.items, date.value);
    const previewToken = bt.signPreviewToken({
      year: ym.year, month: ym.month, payoutRecordIds: ids, transferDesignatedDate: date.value, hash,
      requesterId: req.user.id, connectionId: conn.id, totalCount: planned.total_count, totalAmount: planned.total_amount, totalFee,
    });
    await bt.audit({ actorUserId: req.user.id, action: 'precheck', connectionId: conn.id, detail: { year: ym.year, month: ym.month, count: planned.total_count, total_amount: planned.total_amount, total_fee: totalFee, excluded: planned.excluded.length }, req });

    res.json({
      preview_token: previewToken,
      expires_in_sec: Math.floor(bt.PREVIEW_TOKEN_TTL_MS / 1000),
      year: ym.year, month: ym.month,
      transfer_designated_date: date.value,
      transfer_data_name: body.transferDataName,
      items,
      excluded: planned.excluded,
      warnings: planned.warnings,
      total_count: planned.total_count,
      total_amount: planned.total_amount,
      fee: { total_fee: totalFee, base_date: feeRes?.baseDate || null, base_time: feeRes?.baseTime || null },
      reauth: reauthState(req),
      environment: conn.environment,
      account_label: conn.account_label,
    });
  } catch (e) {
    return apiErrorResponse(res, e);
  }
});

// POST /api/haruka/admin/payouts/transfer/request  body { preview_token }
router.post('/payouts/transfer/request', async (req, res) => {
  const re = reauthState(req);
  if (!re.ok) return res.status(401).json({ error: '依頼の前に本人確認（再認証）が必要です', code: 'reauth_required', google_reauth_available: googleLogin.isEnabled() });
  try {
    const tok = bt.verifyPreviewToken(req.body?.preview_token);
    if (!tok) return res.status(400).json({ error: '確認内容の有効期限が切れました。もう一度「依頼内容を確認」からやり直してください', code: 'preview_expired' });
    if (String(tok.u) !== String(req.user.id)) return res.status(403).json({ error: '確認した本人だけが依頼できます', code: 'preview_owner' });

    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });
    if (String(conn.id) !== String(tok.c)) return res.status(409).json({ error: '銀行の接続が変わりました。もう一度確認からやり直してください', code: 'preview_stale' });

    // 同じ明細を組み立て直してハッシュ一致を確認（確認後に口座・金額・状態が変わっていたら止める）
    const planned = await bt.buildPlan({ year: tok.y, month: tok.m, payoutRecordIds: tok.ids });
    const hash = plan.planHash(planned.items, tok.d);
    if (hash !== tok.h || planned.total_count !== tok.n || planned.total_amount !== tok.t) {
      return res.status(409).json({ error: '確認した時点から明細（口座・金額・対象）が変わっています。もう一度確認からやり直してください', code: 'preview_stale', items: plan.summarizeItems(planned.items), excluded: planned.excluded });
    }

    const transferDataName = plan.transferDataNameFor(tok.y, tok.m);
    const idempotencyKey = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const { data: batch, error: bErr } = await supabase.from('payout_transfer_batches').insert({
      connection_id: conn.id,
      year: tok.y, month: tok.m,
      idempotency_key: idempotencyKey,
      transfer_designated_date: tok.d,
      transfer_data_name: transferDataName,
      total_count: planned.total_count,
      total_amount: planned.total_amount,
      fee_precheck: { total_fee: tok.f, prechecked_at: nowIso },
      request_summary: { items: plan.summarizeItems(planned.items) },
      status: 'requested',
      requested_by: req.user.id,
      requested_at: nowIso,
    }).select(bt.BATCH_COLUMNS).single();
    if (bErr) throw new Error(`payout_transfer_batches 保存失敗: ${bErr.message}`);

    const { data: items, error: iErr } = await supabase.from('payout_transfer_items').insert(planned.items.map(it => ({
      batch_id: batch.id,
      payout_record_id: it.payout_record_id,
      user_id: it.user_id,
      item_id: it.item_id,
      bank_code: it.bank_code,
      branch_code: it.branch_code,
      account_type_code: it.account_type_code,
      account_number: it.account_number,
      beneficiary_name: it.beneficiary_name,
      amount: it.amount,
      invoice_id: it.invoice_id || null,
      amount_source: it.amount_source,
      gross_amount: it.gross_amount,
      tax_amount: it.tax_amount,
      withholding_amount: it.withholding_amount,
      status: 'pending',
    }))).select(bt.ITEM_COLUMNS);
    if (iErr) {
      await bt.updateBatch(batch.id, { status: 'failed', last_error: `明細の保存に失敗: ${iErr.message}` });
      throw new Error(`payout_transfer_items 保存失敗: ${iErr.message}`);
    }

    const body = plan.buildBulkTransferBody({ accountId: conn.account_id, transferDesignatedDate: tok.d, transferDataName, items: planned.items });
    const onRefreshed = (c) => bt.audit({ actorUserId: req.user.id, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });
    let result;
    try {
      result = await aozora.bulkTransferRequest(conn, body, idempotencyKey, { onRefreshed });
    } catch (e) {
      const detail = e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message };
      const failed = await bt.updateBatch(batch.id, { status: 'failed', last_error: `依頼に失敗: ${e.message}` });
      await bt.audit({ actorUserId: req.user.id, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'request', ...detail }, req });
      await bt.sendAdminMyChat(bt.chatInfo('❌ 総合振込の依頼が銀行に受け付けられませんでした', [
        `対象: ${tok.y}年${tok.m}月分（${planned.total_count}件・${bt.yen(planned.total_amount)}）`,
        `理由: ${e.message}`,
        '依頼は登録されていません。内容を直してからもう一度依頼してください。',
      ]));
      if (e instanceof aozora.AozoraApiError) {
        return res.status(e.status === 400 ? 422 : 502).json({ error: e.message, code: 'request_failed', bank_error: e.toJSON(), batch: bt.batchToJson(failed) });
      }
      throw e;
    }

    const resultCode = result?.resultCode != null ? String(result.resultCode) : null;
    const status = resultCode === '1' ? 'approved' : 'awaiting_approval';
    const updated = await bt.updateBatch(batch.id, {
      apply_no: result?.applyNo || null,
      result_code: ['1', '2', '8'].includes(resultCode) ? resultCode : null,
      status,
      approved_at: resultCode === '1' ? (result?.applyEndDatetime || nowIso) : null,
      last_polled_at: nowIso,
    });
    await bt.audit({ actorUserId: req.user.id, action: 'request', connectionId: conn.id, batchId: batch.id, detail: { apply_no: updated.apply_no, result_code: resultCode, count: updated.total_count, total_amount: updated.total_amount, idempotency_key: idempotencyKey }, req });
    console.log(`[bank-transfer] 総合振込を依頼しました batch=${batch.id} apply_no=${updated.apply_no} result=${resultCode} count=${updated.total_count}`);

    const summary = plan.summarizeItems(planned.items);
    const chat = await bt.sendAdminMyChat(bt.buildRequestSummaryText({ batch: updated, items: summary, envName: conn.environment }));

    res.status(201).json({
      ok: true,
      batch_id: updated.id,
      apply_no: updated.apply_no,
      result_code: resultCode,
      status: updated.status,
      status_label: bt.BATCH_STATUS_LABELS[updated.status],
      needs_bank_approval: resultCode !== '1',
      summary_sent: !!chat.ok,
      batch: bt.batchToJson(updated, items || []),
    });
  } catch (e) {
    return apiErrorResponse(res, e);
  }
});

// GET /api/haruka/admin/payouts/transfer/batches?year&month
router.get('/payouts/transfer/batches', async (req, res) => {
  try {
    let q = supabase.from('payout_transfer_batches').select(bt.BATCH_COLUMNS).order('requested_at', { ascending: false }).limit(100);
    if (req.query.year) q = q.eq('year', Number(req.query.year));
    if (req.query.month) q = q.eq('month', Number(req.query.month));
    if (req.query.status) q = q.eq('status', String(req.query.status));
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ batches: (data || []).map(b => bt.batchToJson(b)), reauth: reauthState(req) });
  } catch (e) {
    console.error('[bank-transfer][GET batches]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/haruka/admin/payouts/transfer/batches/:id
router.get('/payouts/transfer/batches/:id', async (req, res) => {
  try {
    const batch = await bt.loadBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: '依頼が見つかりません' });
    const items = await bt.loadItems(batch.id);
    const users = await bt.loadUsersMap(items.map(it => it.user_id));
    const json = bt.batchToJson(batch);
    json.items = items.map(it => bt.itemToJson(it, users.get(it.user_id)));
    res.json({ batch: json });
  } catch (e) {
    console.error('[bank-transfer][GET batch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/haruka/admin/payouts/transfer/batches/:id/poll
router.post('/payouts/transfer/batches/:id/poll', async (req, res) => {
  try {
    const batch = await bt.loadBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: '依頼が見つかりません' });
    if (['completed', 'expired', 'cancelled', 'failed'].includes(batch.status)) {
      const items = await bt.loadItems(batch.id);
      return res.json({ ok: true, changed: false, batch: bt.batchToJson(batch, items) });
    }
    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });
    const r = await bt.pollBatch(batch, conn, { actorUserId: req.user.id, req });
    const users = await bt.loadUsersMap(r.items.map(it => it.user_id));
    const json = bt.batchToJson(r.batch);
    json.items = r.items.map(it => bt.itemToJson(it, users.get(it.user_id)));
    res.json({ ok: true, changed: r.changed, result_code: r.resultCode, transfer_status: r.transferStatus, batch: json });
  } catch (e) {
    return apiErrorResponse(res, e);
  }
});

// POST /api/haruka/admin/payouts/transfer/batches/:id/cancel
router.post('/payouts/transfer/batches/:id/cancel', async (req, res) => {
  try {
    const batch = await bt.loadBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: '依頼が見つかりません' });
    if (!batch.apply_no || !['awaiting_approval', 'approved'].includes(batch.status)) {
      return res.status(409).json({ error: `この状態（${bt.BATCH_STATUS_LABELS[batch.status] || batch.status}）では取消依頼できません`, code: 'not_cancellable' });
    }
    if (batch.request_summary && batch.request_summary.cancel_requested_at) {
      return res.status(409).json({ error: 'すでに取消依頼を出しています（銀行側の承認待ち）', code: 'cancel_pending' });
    }
    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });
    const onRefreshed = (c) => bt.audit({ actorUserId: req.user.id, action: 'token_refresh', connectionId: c.id, detail: { expires_at: c.access_token_expires_at } });
    let result;
    try {
      result = await aozora.bulkTransferCancel(conn, { accountId: conn.account_id, applyNo: batch.apply_no, cancelTargetKeyClass: req.body?.cancel_target_key_class }, { onRefreshed });
    } catch (e) {
      await bt.audit({ actorUserId: req.user.id, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'cancel', ...(e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message }) }, req });
      return apiErrorResponse(res, e);
    }
    const resultCode = result?.resultCode != null ? String(result.resultCode) : null;
    const nowIso = new Date().toISOString();
    const patch = { last_polled_at: nowIso };
    if (resultCode === '1') {
      patch.status = 'cancelled';
      patch.completed_at = nowIso;
    } else {
      patch.request_summary = { ...(batch.request_summary || {}), cancel_requested_at: nowIso, cancel_result_code: resultCode };
      patch.last_error = '取消依頼を出しました。銀行画面で取消の承認が必要です';
    }
    const updated = await bt.updateBatch(batch.id, patch);
    await bt.audit({ actorUserId: req.user.id, action: 'cancel', connectionId: conn.id, batchId: batch.id, detail: { apply_no: batch.apply_no, result_code: resultCode }, req });
    await bt.sendAdminMyChat(bt.chatInfo(resultCode === '1' ? '🚫 総合振込の依頼を取り消しました' : '🚫 総合振込の取消依頼を出しました（承認が必要）', [
      `受付番号 ${batch.apply_no} ／ ${batch.year}年${batch.month}月分 ${batch.total_count}件・${bt.yen(batch.total_amount)}`,
      resultCode === '1' ? null : '銀行アプリ／ブックマークから入って取消を承認してください。',
    ]));
    const items = await bt.loadItems(batch.id);
    res.json({ ok: true, result_code: resultCode, needs_bank_approval: resultCode !== '1', batch: bt.batchToJson(updated, items) });
  } catch (e) {
    return apiErrorResponse(res, e);
  }
});

module.exports = router;

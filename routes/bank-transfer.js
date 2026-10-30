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

// HMAC 鍵・再認証の判定・戻り先の組み立ては utils 側と 1 本化（レビュー #11 / #12）
const stateSecret = () => googleLogin.getStateSecret();
const reauthState = bt.reauthStatus;

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

const redirectBack = bt.reauthRedirect;

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
    // token には「plan に含めた record ids」だけを入れる（除外済みを残すと request の再 plan で毎回 already_requested になる。レビュー #1）
    const previewToken = bt.signPreviewToken({
      year: ym.year, month: ym.month, payoutRecordIds: planned.items.map(it => it.payout_record_id), transferDesignatedDate: date.value, hash,
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

// POST /api/haruka/admin/payouts/transfer/request  body { preview_token, transfer_designated_date }
// 順序（ADR 054 §3-2）: 再認証 → token 検証 → 日付の突き合わせ → 明細を再構築してハッシュ一致 → 同月の未確定明細を再評価
//   → batches を status='requesting'（idempotency_key 確定）＋ items を INSERT → そのキーで銀行へ依頼 → 応答を UPDATE。
//   応答が消えたら requesting のまま `{pending:true}` を返し、POST .../batches/:id/retry（または 15 分後のワーカ）が同じキーで再送する
router.post('/payouts/transfer/request', async (req, res) => {
  const re = reauthState(req);
  if (!re.ok) return res.status(401).json({ error: '依頼の前に本人確認（再認証）が必要です', code: 'reauth_required', google_reauth_available: googleLogin.isEnabled() });
  try {
    const tok = bt.verifyPreviewToken(req.body?.preview_token);
    if (!tok) return res.status(400).json({ error: '確認内容の有効期限が切れました。もう一度「依頼内容を確認」からやり直してください', code: 'preview_expired' });
    if (String(tok.u) !== String(req.user.id)) return res.status(403).json({ error: '確認した本人だけが依頼できます', code: 'preview_owner' });
    const dateCheck = plan.checkDesignatedDateMatch(tok.d, req.body?.transfer_designated_date);
    if (!dateCheck.ok) return res.status(dateCheck.code === 'date_required' ? 400 : 409).json({ error: dateCheck.error, code: dateCheck.code, token_date: tok.d });

    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });
    if (String(conn.id) !== String(tok.c)) return res.status(409).json({ error: '銀行の接続が変わりました。もう一度確認からやり直してください', code: 'preview_stale' });

    // 使い捨て判定（レビュー #2b・補助）: 同じ preview_token（jti）で作られた batch があれば 409
    const { data: usedRows, error: usedErr } = await supabase
      .from('payout_transfer_batches').select('id, status').eq('request_summary->>preview_jti', String(tok.jti)).limit(1);
    if (usedErr) throw new Error(`payout_transfer_batches 取得失敗: ${usedErr.message}`);
    if (usedRows && usedRows.length) {
      return res.status(409).json({ error: 'この確認内容はすでに依頼に使われています。依頼履歴を確認してください', code: 'preview_used', batch_id: usedRows[0].id, batch_status: usedRows[0].status });
    }

    // 同じ明細を組み立て直す。token の ids は preview で含めた人だけなので、ここで duplicate_in_month になった人＝
    // preview 後に別の依頼が入った人（レビュー #1）。1 人でもいれば 409 already_requested
    const planned = await bt.buildPlan({ year: tok.y, month: tok.m, payoutRecordIds: tok.ids });
    const conflicts = plan.requestConflicts(planned);
    if (conflicts.length) {
      return res.status(409).json({ error: 'この月はすでに総合振込を依頼済みのメンバーがいます。依頼履歴を確認してください', code: 'already_requested', user_ids: conflicts, excluded: planned.excluded });
    }
    // ハッシュ一致を確認（確認後に口座・金額・対象が変わっていたら止める）
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
      request_summary: { items: plan.summarizeItems(planned.items), send_attempts: 0, preview_jti: String(tok.jti) },
      status: 'requesting',
      requested_by: req.user.id,
      requested_at: nowIso,
    }).select(bt.BATCH_COLUMNS).single();
    if (bErr) throw new Error(`payout_transfer_batches 保存失敗: ${bErr.message}（status='requesting' を許す migration 2026-10-30_aozora_transfer_followup.sql が未適用の可能性）`);

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
      // 部分ユニークインデックス（uq_payout_transfer_items_active_record）違反＝同じ振込レコードに有効な明細がすでにある
      // （ダブルクリックで同時に走ったもう一方が先に INSERT した。レビュー #2a）。この batch は失敗にして 409
      const isUnique = iErr.code === '23505' || /uq_payout_transfer_items_active_record|duplicate key/i.test(iErr.message || '');
      await bt.updateBatch(batch.id, { status: 'failed', completed_at: new Date().toISOString(), last_error: isUnique ? '同じ振込レコードの明細が別の依頼にすでにあります（二重依頼を止めました）' : `明細の保存に失敗: ${iErr.message}` });
      await supabase.from('payout_transfer_items').delete().eq('batch_id', batch.id); // 部分挿入があれば片付ける（通常は 0 件）
      if (isUnique) {
        const blocked = await bt.loadBlockedUserIds({ year: tok.y, month: tok.m, userIds: planned.items.map(it => it.user_id) });
        await bt.audit({ actorUserId: req.user.id, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'items_insert', outcome: 'unique_violation' }, req });
        return res.status(409).json({ error: 'この月はすでに総合振込を依頼済みのメンバーがいます（同時に 2 回依頼された可能性があります）。依頼履歴を確認してください', code: 'already_requested', user_ids: plan.alreadyRequestedUserIds(planned.items, blocked), batch_id: batch.id });
      }
      throw new Error(`payout_transfer_items 保存失敗: ${iErr.message}`);
    }

    // DB に書けたので、この batch の idempotency_key で銀行へ送る（応答が消えても同じキーで再送できる）
    const r = await bt.sendBatchRequest(batch, items, conn, { actorUserId: req.user.id, req, attempt: 1 });
    return respondSendOutcome(res, r, items);
  } catch (e) {
    return apiErrorResponse(res, e);
  }
});

/** sendBatchRequest / retryRequestingBatch の結果を HTTP に写す（request と retry で同じ形） */
function respondSendOutcome(res, r, items) {
  const b = r.batch;
  if (r.outcome === 'accepted') {
    return res.status(201).json({
      ok: true,
      pending: false,
      reconciled: !!r.reconciled,
      batch_id: b.id,
      apply_no: b.apply_no,
      result_code: r.resultCode,
      status: b.status,
      status_label: bt.BATCH_STATUS_LABELS[b.status],
      needs_bank_approval: r.resultCode !== '1',
      batch: bt.batchToJson(b, items || []),
    });
  }
  if (r.outcome === 'pending') {
    // 銀行の応答が消えた。受付済みかもしれないので失敗にはせず、「送信結果を確認中」として retry を案内
    return res.status(202).json({
      ok: false,
      pending: true,
      batch_id: b.id,
      status: 'requesting',
      status_label: bt.BATCH_STATUS_LABELS.requesting,
      error: '銀行からの応答が返りませんでした。依頼は受け付けられている可能性があるため、数分おいて「送信結果を確認」（retry）を押してください。15 分たっても確認できなければ自動で 1 回だけ再送します',
      code: 'request_pending',
      bank_error: r.error instanceof aozora.AozoraApiError ? r.error.toJSON() : { message: r.error?.message || null },
      batch: bt.batchToJson(b, items || []),
    });
  }
  const e = r.error;
  return res.status(e instanceof aozora.AozoraApiError && e.status === 400 ? 422 : 502).json({
    ok: false,
    pending: false,
    error: e?.message || '依頼に失敗しました',
    code: 'request_failed',
    bank_error: e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e?.message || null },
    batch: bt.batchToJson(b, items || []),
  });
}

// POST /api/haruka/admin/payouts/transfer/batches/:id/retry
// requesting（応答待ち）の batch を、状況照会で受付済みか確かめてから同じ idempotency_key で再送する
router.post('/payouts/transfer/batches/:id/retry', async (req, res) => {
  try {
    const batch = await bt.loadBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: '依頼が見つかりません' });
    if (batch.status !== 'requesting') {
      return res.status(409).json({ error: `再送できるのは「${bt.BATCH_STATUS_LABELS.requesting}」の依頼だけです（現在: ${bt.BATCH_STATUS_LABELS[batch.status] || batch.status}）`, code: 'not_retryable', batch: bt.batchToJson(batch) });
    }
    const conn = await aozora.loadActiveConnection();
    if (!conn) return res.status(409).json({ error: '銀行 API に接続されていません', code: 'bank_not_connected' });
    if (String(conn.id) !== String(batch.connection_id)) return res.status(409).json({ error: '依頼したときと銀行の接続が違います', code: 'connection_changed' });
    const r = await bt.retryRequestingBatch(batch, conn, { actorUserId: req.user.id, req, auto: false });
    const items = await bt.loadItems(batch.id);
    return respondSendOutcome(res, r, items);
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
    const nowIso = new Date().toISOString();
    try {
      // 取消依頼は Idempotency-Key が無いので 1 回だけ送る（utils/aozora-api.js 側で maxAttempts=1・レビュー #8）
      result = await aozora.bulkTransferCancel(conn, { accountId: conn.account_id, applyNo: batch.apply_no, cancelTargetKeyClass: req.body?.cancel_target_key_class }, { onRefreshed });
    } catch (e) {
      const detail = e instanceof aozora.AozoraApiError ? e.toJSON() : { message: e.message };
      await bt.audit({ actorUserId: req.user.id, action: 'error', connectionId: conn.id, batchId: batch.id, detail: { step: 'cancel', ...detail }, req });
      if (aozora.isLostResponse(e)) {
        // 応答消失: 取消が通ったかもしれない。再送せず cancel_attempted_at を残し、次の poll（依頼結果照会）で状態を見る
        const updated = await bt.updateBatch(batch.id, {
          request_summary: { ...(batch.request_summary || {}), cancel_attempted_at: nowIso },
          last_error: `取消依頼の応答が返りませんでした（${e.message}）。次回の照会で状態を確認します`,
        });
        return res.status(202).json({ ok: false, pending: true, code: 'cancel_pending_confirmation', error: '取消依頼の応答が返りませんでした。数分おいて「最新の状態を取得」で確認してください', bank_error: detail, batch: bt.batchToJson(updated) });
      }
      return apiErrorResponse(res, e);
    }
    const resultCode = result?.resultCode != null ? String(result.resultCode) : null;
    const patch = { last_polled_at: nowIso };
    if (resultCode === '1') {
      patch.status = 'cancelled';
      patch.completed_at = nowIso;
      const { cancel_requested_at, cancel_attempted_at, ...rest } = batch.request_summary || {};
      patch.request_summary = rest;
      await bt.failPendingItems(batch.id, 'batch_cancelled'); // pending の明細を failed に落として再依頼できるようにする
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

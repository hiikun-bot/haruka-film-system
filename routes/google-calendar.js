// routes/google-calendar.js — Google Calendar OAuth フロー & 動作確認 API（ADR 017 Phase 0）
//
// エンドポイント:
//   GET  /api/auth/google-calendar/start       認可 URL へリダイレクト
//   GET  /api/auth/google-calendar/callback    認可コード交換 -> refresh_token を暗号化保存
//   POST /api/auth/google-calendar/disconnect  本人の接続を切断
//   GET  /api/availability/preview-events      本人の予定を JSON で返す（動作確認用）
//
// セキュリティ:
//   - state は HMAC-SHA256 で署名し、userId + nonce + 有効期限を埋め込む
//   - 本人以外の操作は不可（disconnect / preview-events）
//   - refresh_token は AES-256-GCM で暗号化して保管（utils/crypto-aes.js）
//
// 設計判断:
//   - Phase 0 は本人のみ。VIEW AS（ADR 015）対応は Phase 1 で集約ページを作る時に判定ロジックを足す
//   - GCal トークン失効時は gcal_last_error にエラー文字列を残し、UI 側に再接続を促せるようにする

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const supabase = require('../supabase');
const { requireAuth } = require('../auth');
const cryptoAes = require('../utils/crypto-aes');
const gcal = require('../lib/google-calendar');

// state 署名鍵: SESSION_SECRET を流用（既に env で必須化されている）
function getStateSecret() {
  return process.env.SESSION_SECRET || 'dev-fallback-state-secret-do-not-use-in-prod';
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 分

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [body, sig] = state.split('.', 2);
  const expected = crypto.createHmac('sha256', getStateSecret()).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// ============================================================
// GET /api/auth/google-calendar/start
// ============================================================
router.get('/start', requireAuth, (req, res) => {
  try {
    if (!cryptoAes.isConfigured()) {
      return res.status(500).send('GCAL_TOKEN_ENCRYPTION_KEY が未設定です。サーバー管理者に連絡してください。');
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = signState({
      uid: req.user.id,
      nonce,
      exp: Date.now() + STATE_TTL_MS,
    });
    const authUrl = gcal.buildAuthUrl({ state });
    return res.redirect(authUrl);
  } catch (e) {
    console.error('[gcal/start] failed:', e.message);
    return res.status(500).send(`Google Calendar 認可開始に失敗しました: ${e.message}`);
  }
});

// ============================================================
// GET /api/auth/google-calendar/callback
// ============================================================
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Google 認可がキャンセル/失敗しました: ${error}`);
  }
  if (!code || !state) {
    return res.status(400).send('code または state が欠けています');
  }
  const payload = verifyState(String(state));
  if (!payload) {
    return res.status(400).send('state の検証に失敗しました（期限切れ / 署名不一致）');
  }
  // 別ユーザーがコールバックURLを踏んだ場合は本人に紐付け直さないこと
  if (payload.uid !== req.user.id) {
    return res.status(403).send('認可フローを開始したユーザーと現在ログイン中のユーザーが一致しません。再度お試しください。');
  }

  try {
    const tokens = await gcal.exchangeCodeForTokens(String(code));
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      // 同じ Google アカウントで以前許諾済みかつ revoke せずに再接続した場合、
      // refresh_token が返らないことがある。prompt=consent で原則回避しているが念のため明示エラー。
      return res.status(400).send('refresh_token が取得できませんでした。Google アカウント側で当アプリのアクセス権を一度解除してから再接続してください。');
    }

    // 接続中アカウントの email を取得
    let accountEmail = null;
    try {
      accountEmail = await gcal.fetchAccountEmail(refreshToken);
    } catch (e) {
      console.warn('[gcal/callback] fetchAccountEmail failed (continuing):', e.message);
    }

    const enc = cryptoAes.encrypt(refreshToken);

    // upsert: 既存行があれば update、無ければ insert
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .from('member_working_hours_profile')
      .upsert({
        user_id: req.user.id,
        gcal_connected: true,
        gcal_account_email: accountEmail,
        gcal_calendar_id: 'primary',
        gcal_refresh_token_encrypted: enc.ciphertext,
        gcal_token_iv: enc.iv,
        gcal_token_auth_tag: enc.authTag,
        gcal_last_synced_at: nowIso,
        gcal_last_error: null,
        updated_at: nowIso,
      }, { onConflict: 'user_id' });
    if (upsertErr) {
      console.error('[gcal/callback] upsert failed:', upsertErr.message);
      return res.status(500).send(`接続情報の保存に失敗しました: ${upsertErr.message}`);
    }

    // 動作確認ページに戻る
    return res.redirect('/availability-setup.html?connected=1');
  } catch (e) {
    console.error('[gcal/callback] failed:', e.message);
    return res.status(500).send(`Google Calendar 接続に失敗しました: ${e.message}`);
  }
});

// ============================================================
// POST /api/auth/google-calendar/disconnect
// ============================================================
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .from('member_working_hours_profile')
      .upsert({
        user_id: req.user.id,
        gcal_connected: false,
        gcal_account_email: null,
        gcal_refresh_token_encrypted: null,
        gcal_token_iv: null,
        gcal_token_auth_tag: null,
        gcal_last_error: null,
        updated_at: nowIso,
      }, { onConflict: 'user_id' });
    if (upErr) {
      return res.status(500).json({ error: upErr.message });
    }
    // Phase 0: Google 側の revoke はベストエフォート未実装。失効ボタンを押した時点で
    //         DB から消えるので、当アプリからは GCal にアクセスできなくなる。
    return res.json({ ok: true });
  } catch (e) {
    console.error('[gcal/disconnect] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/availability/preview-events
//   クエリ: ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   省略時: 今日 00:00 〜 +7 日 23:59
// ============================================================
router.get('/preview-events', requireAuth, async (req, res) => {
  try {
    const { data: profile, error: pErr } = await supabase
      .from('member_working_hours_profile')
      .select('gcal_connected, gcal_account_email, gcal_calendar_id, gcal_refresh_token_encrypted, gcal_token_iv, gcal_token_auth_tag')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!profile || !profile.gcal_connected || !profile.gcal_refresh_token_encrypted) {
      return res.status(400).json({ error: 'Google Calendar が未接続です' });
    }

    let refreshToken;
    try {
      refreshToken = cryptoAes.decrypt({
        ciphertext: profile.gcal_refresh_token_encrypted,
        iv: profile.gcal_token_iv,
        authTag: profile.gcal_token_auth_tag,
      });
    } catch (e) {
      return res.status(500).json({ error: 'トークン復号に失敗しました（暗号鍵が変わった可能性）: ' + e.message });
    }

    // 日付パース
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromStr = String(req.query.from || '').trim();
    const toStr = String(req.query.to || '').trim();
    const from = fromStr ? new Date(fromStr + 'T00:00:00') : today;
    const toBase = toStr ? new Date(toStr + 'T00:00:00') : new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    // to は当日 23:59:59 まで含めたい
    const to = new Date(toBase.getTime() + 24 * 60 * 60 * 1000 - 1000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: 'from / to の日付が不正です（YYYY-MM-DD 形式）' });
    }

    try {
      const events = await gcal.fetchEventsForRange({
        refreshToken,
        calendarId: profile.gcal_calendar_id || 'primary',
        from,
        to,
      });
      // 成功時は last_synced_at を更新（best effort）
      supabase.from('member_working_hours_profile')
        .update({ gcal_last_synced_at: new Date().toISOString(), gcal_last_error: null })
        .eq('user_id', req.user.id)
        .then(() => {});
      return res.json({
        account_email: profile.gcal_account_email,
        calendar_id: profile.gcal_calendar_id || 'primary',
        from: from.toISOString(),
        to: to.toISOString(),
        event_count: events.length,
        events,
      });
    } catch (e) {
      // 失効・レート制限・その他 — gcal_last_error にメモして UI に返す
      supabase.from('member_working_hours_profile')
        .update({ gcal_last_error: `${e.name || 'Error'}: ${e.message}` })
        .eq('user_id', req.user.id)
        .then(() => {});
      if (e.name === 'GCalAuthError') {
        return res.status(401).json({ error: e.message, code: 'gcal_auth_error' });
      }
      if (e.name === 'GCalRateLimitError') {
        return res.status(429).json({ error: e.message, code: 'gcal_rate_limit' });
      }
      return res.status(500).json({ error: e.message });
    }
  } catch (e) {
    console.error('[gcal/preview-events] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/availability/connection-status
//   フロント用に「自分が接続済みか」だけ軽量に返す
// ============================================================
router.get('/connection-status', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('member_working_hours_profile')
      .select('gcal_connected, gcal_account_email, gcal_last_synced_at, gcal_last_error')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      connected: !!(data && data.gcal_connected),
      account_email: data?.gcal_account_email || null,
      last_synced_at: data?.gcal_last_synced_at || null,
      last_error: data?.gcal_last_error || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

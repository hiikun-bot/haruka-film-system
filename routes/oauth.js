// routes/oauth.js — ユーザーOAuth（Google）の同意フロー
//
// 役割:
//   - GET  /oauth/google/start     → Google 同意画面へリダイレクト
//   - GET  /oauth/google/callback  → code をトークンに交換して保存し、元の画面へ戻す
//   - GET  /oauth/google/status    → 連携状態と必要スコープを JSON で返す（フロント判定用）
//   - POST /oauth/google/disconnect → 連携解除（refresh_token をDBから消す）
//
// すべて requireAuth（haruka セッション必須）。drive.file スコープ前提。

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requireAuth } = require('../auth');
const oauthLib = require('../lib/google-oauth');

router.use(requireAuth);

// ==================== 開始: 同意画面にリダイレクト ====================
// クエリ:
//   next: 連携完了後に戻したい URL（オプション。/haruka.html 等に制限）
router.get('/google/start', (req, res) => {
  if (!oauthLib.isConfigured()) {
    return res.status(503).send(
      'Google OAuth が未設定です。Railway 環境変数 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI を設定してください。docs/oauth-setup-resumable-upload.md を参照。'
    );
  }
  const next = String(req.query.next || '/haruka.html');
  // オープンリダイレクト防止: /haruka.html 以下しか許可しない
  const safeNext = /^\/haruka\.html(\?|$)/.test(next) ? next : '/haruka.html';

  // CSRF 対策の state: ランダム値をセッションに保存し、callback で照合
  const stateNonce = crypto.randomBytes(16).toString('hex');
  req.session = req.session || {};
  req.session.googleOAuthState = stateNonce;
  req.session.googleOAuthNext = safeNext;

  const url = oauthLib.buildConsentUrl({
    state: stateNonce,
    scopes: oauthLib.getConfiguredScopes(),
  });
  res.redirect(url);
});

// ==================== コールバック ====================
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query || {};
    if (oauthError) {
      return res.status(400).send(`OAuth エラー: ${String(oauthError)}`);
    }
    if (!code) return res.status(400).send('code がありません');

    const expected = req.session?.googleOAuthState;
    if (!expected || String(state) !== String(expected)) {
      return res.status(400).send('state が一致しません（CSRF 検査失敗）');
    }
    const next = req.session?.googleOAuthNext || '/haruka.html';

    const tokens = await oauthLib.exchangeCode(String(code));
    await oauthLib.saveTokens({
      userId: req.user.id,
      tokens,
      scopeKey: 'drive.file',
    });

    // セッションから一度限りの state を捨てる
    try {
      delete req.session.googleOAuthState;
      delete req.session.googleOAuthNext;
    } catch (_) {}

    // 戻り先に「連携成功」フラグ付きでリダイレクト
    const sep = next.includes('?') ? '&' : '?';
    res.redirect(next + sep + 'drive_oauth=connected');
  } catch (e) {
    console.error('[oauth/google/callback] error:', e);
    res.status(500).send('OAuth 連携に失敗しました: ' + (e?.message || String(e)));
  }
});

// ==================== 連携状態 ====================
router.get('/google/status', async (req, res) => {
  try {
    if (!oauthLib.isConfigured()) {
      return res.json({
        configured: false,
        connected: false,
        scopes: oauthLib.getConfiguredScopes(),
        message: 'Google OAuth が未設定です（管理者向け: GOOGLE_OAUTH_CLIENT_ID 等の環境変数を設定してください）',
      });
    }
    const stored = await oauthLib.getStoredTokens({
      userId: req.user.id,
      scopeKey: 'drive.file',
    });
    res.json({
      configured: true,
      connected: !!(stored && stored.refresh_token),
      scopes: oauthLib.getConfiguredScopes(),
      granted_scopes: stored?.granted_scopes || null,
      expires_at: stored?.expires_at || null,
    });
  } catch (e) {
    console.error('[oauth/google/status] error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ==================== 連携解除 ====================
router.post('/google/disconnect', async (req, res) => {
  try {
    await oauthLib.clearStoredTokens({ userId: req.user.id, scopeKey: 'drive.file' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[oauth/google/disconnect] error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;

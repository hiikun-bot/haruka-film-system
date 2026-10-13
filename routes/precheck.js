// routes/precheck.js — 投稿前チェック API（ADR 050）
// マウント: server.js で `app.use('/api/precheck', require('./routes/precheck'))`
//
//   POST /api/precheck/token   … ブラウザでログイン中のメンバーが自分用トークンを発行（セッション認証）
//   GET  /api/precheck/me      … パネルの接続確認（トークン認証）
//   POST /api/precheck/check   … テロップ等を受け取り、判定結果を返す（トークン認証）

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireAuth } = require('../auth');
const { issueToken, verifyToken, MAX_AGE_SEC } = require('../lib/precheck/token');
const { listSets } = require('../lib/precheck/sets');
const { runCheck } = require('../lib/precheck/check');

function secret() {
  return process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'video-ops-dev-secret-change-in-production');
}

// トークン（Authorization: Bearer）か、ブラウザのセッションのどちらかで本人を確定する
async function requirePrecheckUser(req, res, next) {
  try {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (m) {
      const v = verifyToken(m[1], secret());
      if (!v) return res.status(401).json({ error: 'トークンが正しくないか、期限が切れています。HARUKA FILM の「Premiere プラグイン」ページで発行し直してください' });
      const { data: user, error } = await supabase
        .from('users').select('id, full_name, nickname, is_active').eq('id', v.userId).maybeSingle();
      if (error) throw error;
      if (!user || !user.is_active) return res.status(401).json({ error: 'このトークンのメンバーは現在使えません' });
      req.precheckUser = user;
      return next();
    }
    if (req.isAuthenticated?.() && req.user?.id) {
      req.precheckUser = { id: req.user.id, full_name: req.user.full_name, nickname: req.user.nickname };
      return next();
    }
    return res.status(401).json({ error: 'トークンがありません' });
  } catch (e) {
    console.error('[precheck] auth-error', e.message);
    return res.status(500).json({ error: '認証の確認に失敗しました' });
  }
}

// 1 人 10 分に 30 回まで（AI の課金と誤操作の連打を抑える）
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const _hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const list = (_hits.get(userId) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) { _hits.set(userId, list); return true; }
  list.push(now);
  _hits.set(userId, list);
  return false;
}

router.post('/token', requireAuth, (req, res) => {
  if (!secret()) return res.status(500).json({ error: 'サーバーの署名鍵が未設定です' });
  const token = issueToken(req.user.id, secret());
  res.json({ token, expires_in_days: Math.round(MAX_AGE_SEC / 86400) });
});

router.get('/me', requirePrecheckUser, (req, res) => {
  const u = req.precheckUser;
  res.json({ user: { id: u.id, name: u.nickname || u.full_name || '' }, sets: listSets() });
});

router.post('/check', requirePrecheckUser, async (req, res) => {
  const u = req.precheckUser;
  if (rateLimited(u.id)) return res.status(429).json({ error: 'チェックの回数が多すぎます。少し待ってからもう一度押してください' });
  const started = Date.now();
  try {
    const result = await runCheck(req.body || {});
    console.info('[precheck] check', JSON.stringify({
      user_id: u.id, set: result.set.id, code: result.code, telops: result.counts.telops,
      error: result.counts.error, warn: result.counts.warn, ai: result.ai, ai_error: result.ai_error,
      ms: Date.now() - started,
    }));
    res.json(result);
  } catch (e) {
    console.error('[precheck] check-error', e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'チェックに失敗しました。時間をおいてもう一度試してください' });
  }
});

// テロップが読めないとき、パネルが「Premiere がどんな形で値を返したか」を送ってくる（ADR 050 §6）。
// DB には残さずサーバーログにだけ出す。読み取り方を固めるための一時的な窓口。
router.post('/diagnostic', requirePrecheckUser, (req, res) => {
  const u = req.precheckUser;
  if (rateLimited(u.id)) return res.status(429).json({ error: '少し待ってからもう一度押してください' });
  const body = req.body || {};
  const payload = JSON.stringify({
    user_id: u.id,
    plugin_version: String(body.plugin_version || '').slice(0, 20),
    host: body.host || null,
    sequence_name: String(body.sequence_name || '').slice(0, 200),
    telops_found: Number(body.telops_found) || 0,
    clips: Array.isArray(body.clips) ? body.clips.slice(0, 60) : [],
  });
  console.info('[precheck] diagnostic', payload.slice(0, 60000));
  res.json({ ok: true });
});

module.exports = router;
module.exports._internal = { requirePrecheckUser, rateLimited };

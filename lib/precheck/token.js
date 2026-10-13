// lib/precheck/token.js — Premiere パネル用のメンバー別トークン（ADR 050 §4）
//
// 形式: hfpc1.<user_id>.<発行unix秒>.<署名(base64url)>
// 署名鍵は SESSION_SECRET から用途別に派生（同じ鍵をセッションと使い回さない）。
// DB は使わない。検証時に users.is_active を見るのは呼び出し側（routes/precheck.js）。

const crypto = require('crypto');

const PREFIX = 'hfpc1';
const MAX_AGE_SEC = 180 * 24 * 60 * 60;

function signingKey(secret) {
  return crypto.createHmac('sha256', String(secret || '')).update('premiere-precheck-token').digest();
}

function sign(body, secret) {
  return crypto.createHmac('sha256', signingKey(secret)).update(body).digest('base64url');
}

function issueToken(userId, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!userId) throw new Error('userId が必要です');
  if (!secret) throw new Error('署名鍵がありません');
  const body = `${PREFIX}.${userId}.${nowSec}`;
  return `${body}.${sign(body, secret)}`;
}

// 正しければ { userId, issuedAt }、だめなら null
function verifyToken(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX || !secret) return null;
  const [, userId, iatStr, sig] = parts;
  const iat = Number(iatStr);
  if (!userId || !Number.isInteger(iat)) return null;
  const expected = Buffer.from(sign(`${PREFIX}.${userId}.${iat}`, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (iat > nowSec + 300 || nowSec - iat > MAX_AGE_SEC) return null;
  return { userId, issuedAt: iat };
}

module.exports = { issueToken, verifyToken, MAX_AGE_SEC };

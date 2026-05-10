/**
 * NameDisplay — ユーザー名表示の共通ヘルパー（システム標準）
 *
 * 全画面でユーザー名を表示するときは必ずこのヘルパー経由で生成する。
 * 仕様: 基本は「ニックネーム（名前）」。ニックネーム未設定なら名前のみ。
 *
 *   Tier 1 (icon)        アイコンのみ。hover で full() を tooltip 表示
 *   Tier 2 (short)       アイコン＋短縮表記（ニックネーム or 名前）
 *   Tier 3 (full)        アイコン＋ニックネーム（名前）
 *
 * 公開 API（window.NameDisplay）:
 *   full(user)               "たろ（山田太郎）" / "山田太郎"
 *   short(user)              "たろ" / "山田太郎"
 *   tooltip(user)            full() と同じ
 *   formatHtml(user, opts)   { tier:'icon'|'short'|'full', escape:true } を受けて HTML 文字列
 *   escape(s)                安全な HTML エスケープ
 *
 * user は { full_name, nickname } を持つオブジェクトか、null/undefined。
 * nickname と full_name が同一文字列のときは括弧書きを省略する。
 */
(function (global) {
  'use strict';

  const FALLBACK = '(名前未設定)';

  function pick(user) {
    if (!user || typeof user !== 'object') return { nick: '', full: '' };
    const nick = String(user.nickname || '').trim();
    const full = String(user.full_name || user.fullName || user.name || '').trim();
    return { nick, full };
  }

  function full(user) {
    const { nick, full: fn } = pick(user);
    if (nick && fn && nick !== fn) return `${nick}（${fn}）`;
    return nick || fn || FALLBACK;
  }

  function short(user) {
    const { nick, full: fn } = pick(user);
    return nick || fn || FALLBACK;
  }

  function tooltip(user) {
    return full(user);
  }

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatHtml(user, opts) {
    const tier = (opts && opts.tier) || 'full';
    const text = tier === 'short' ? short(user) : full(user);
    return escape(text);
  }

  const NameDisplay = { full, short, tooltip, formatHtml, escape };
  global.NameDisplay = NameDisplay;
  if (typeof module !== 'undefined' && module.exports) module.exports = NameDisplay;
})(typeof window !== 'undefined' ? window : globalThis);

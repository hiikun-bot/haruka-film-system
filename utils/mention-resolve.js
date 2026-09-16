// utils/mention-resolve.js
// つぶやき・コメント本文の「@メンション」をユーザー名簿に解決する純関数群。
//
// 背景（バグ報告 c565250d）:
//   旧実装は `@([\p{L}\p{N}_]+)` で切り出した文字列と nickname / full_name の
//   **完全一致** で解決していた。日本語は名前の直後に空白を置かないことが多く
//   （「@たごんお疲れ様です」）、切り出し結果が「たごんお疲れ様です」になって誰にも
//   一致せず、メンション通知が一切飛ばなかった。full_name に空白を含む「川崎 かおり」も
//   構造的に一致不能だった。
//
// 新実装:
//   ユーザー名簿から照合キー（nickname / full_name / 姓のみ）を正規化して作り、
//   「@」直後の文字列に対して **前方一致・最長一致** で解決する。
//     ・「@たごんお疲れ様です」          → たごん
//     ・「@川崎かおり」「@川崎 かおり」  → 川崎 かおり（名前中の空白は読み飛ばす）
//     ・「@川崎さん」                    → 川崎（姓のみキー）
//     ・全角/半角・大文字小文字の違いは NFKC + lower で吸収（「＠」も「@」扱い）
//   同じキーを持つユーザーが複数いれば全員を対象にする（同名対策）。
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes / utils): require('../utils/mention-resolve')
//   - ブラウザ: server.js が /js/mention-resolve.js で配信 → window.MentionResolve
//     （フロントの「@」補完・本文ハイライトとサーバーの通知先解決で同じロジックを共有する）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MentionResolve = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 「@」直後に読む最大文字数（名前は長くてもこの程度。無駄な走査を抑える）
  const MAX_SCAN_CHARS = 64;
  // 姓のみキーを作る最小文字数（1文字の姓は誤爆しやすいので除外）
  const SURNAME_MIN_LEN = 2;

  const AT_CHARS = new Set(['@', '＠']);
  const WS_RE = /\s/u;

  // 照合用の正規化: NFKC（全角/半角統一）→ 空白除去 → 小文字化
  function normalizeMentionText(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/\s+/gu, '')
      .toLowerCase();
  }

  // ユーザー名簿 → 照合辞書 [{ id, keys: [...], user }]
  //   keys: nickname / full_name / 姓（full_name を空白で区切った先頭、2文字以上）
  function buildMentionDirectory(users) {
    const out = [];
    for (const u of users || []) {
      if (!u || !u.id) continue;
      const keys = new Set();
      const nick = normalizeMentionText(u.nickname);
      const full = normalizeMentionText(u.full_name);
      if (nick) keys.add(nick);
      if (full) keys.add(full);
      const parts = String(u.full_name || '').normalize('NFKC').trim().split(/\s+/u).filter(Boolean);
      if (parts.length >= 2) {
        const surname = normalizeMentionText(parts[0]);
        if (surname.length >= SURNAME_MIN_LEN) keys.add(surname);
      }
      if (keys.size === 0) continue;
      out.push({ id: u.id, keys: Array.from(keys), user: u });
    }
    return out;
  }

  // 本文中のメンション区間を解決する。
  //   users: [{ id, full_name, nickname }] または buildMentionDirectory() の戻り値
  //   戻り値: [{ start, end, text, userIds, users }]  ※ start/end は UTF-16 オフセット（slice 用）
  function resolveMentions(body, users) {
    if (!body || typeof body !== 'string') return [];
    const dir = (Array.isArray(users) && users.length && Array.isArray(users[0] && users[0].keys))
      ? users
      : buildMentionDirectory(users);
    if (dir.length === 0) return [];

    let maxKeyLen = 0;
    const keyMap = new Map(); // 正規化キー → [{ id, user }]
    for (const d of dir) {
      for (const k of d.keys) {
        if (k.length > maxKeyLen) maxKeyLen = k.length;
        if (!keyMap.has(k)) keyMap.set(k, []);
        keyMap.get(k).push(d);
      }
    }

    // コードポイント単位で走査（絵文字・サロゲートペアを壊さない）。offsets は UTF-16 位置。
    const chars = Array.from(body);
    const offsets = new Array(chars.length + 1);
    let off = 0;
    for (let i = 0; i < chars.length; i++) { offsets[i] = off; off += chars[i].length; }
    offsets[chars.length] = off;

    const results = [];
    for (let i = 0; i < chars.length; i++) {
      if (!AT_CHARS.has(chars[i])) continue;
      let acc = '';
      let best = null; // { hits, endIdx }
      const limit = Math.min(chars.length, i + 1 + MAX_SCAN_CHARS);
      for (let j = i + 1; j < limit; j++) {
        const c = chars[j];
        if (AT_CHARS.has(c)) break;
        if (WS_RE.test(c)) {
          if (!acc) break;          // 「@ 名前」（@ 直後が空白）は対象外
          continue;                 // 名前中の空白（川崎 かおり）は読み飛ばす
        }
        acc += normalizeMentionText(c);
        if (acc.length > maxKeyLen) break;
        const hits = keyMap.get(acc);
        if (hits && hits.length) best = { hits, endIdx: j + 1 };
      }
      if (best) {
        const seen = new Set();
        const matched = [];
        for (const h of best.hits) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          matched.push(h);
        }
        results.push({
          start: offsets[i],
          end: offsets[best.endIdx],
          text: body.slice(offsets[i], offsets[best.endIdx]),
          userIds: matched.map(h => h.id),
          users: matched.map(h => h.user),
        });
        i = best.endIdx - 1; // 解決済み区間は読み飛ばす
      }
    }
    return results;
  }

  // 本文からメンション対象 user_id の一意な配列を返す（サーバーの通知先解決用）
  function extractMentionIds(body, users) {
    const ids = new Set();
    for (const m of resolveMentions(body, users)) {
      for (const id of m.userIds) ids.add(id);
    }
    return Array.from(ids);
  }

  // 「@」補完の候補絞り込み（フロント用）。query が空なら全員、
  // それ以外は nickname / full_name の部分一致。前方一致を優先して並べる。
  function filterMentionCandidates(users, query, limit) {
    const q = normalizeMentionText(query);
    const max = limit || 8;
    const scored = [];
    for (const u of users || []) {
      if (!u || !u.id) continue;
      const nick = normalizeMentionText(u.nickname);
      const full = normalizeMentionText(u.full_name);
      if (!nick && !full) continue;
      if (!q) { scored.push({ u, score: 0 }); continue; }
      let score = -1;
      if (nick.startsWith(q) || full.startsWith(q)) score = 0;
      else if (nick.includes(q) || full.includes(q)) score = 1;
      if (score >= 0) scored.push({ u, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, max).map(s => s.u);
  }

  return {
    normalizeMentionText,
    buildMentionDirectory,
    resolveMentions,
    extractMentionIds,
    filterMentionCandidates,
  };
});

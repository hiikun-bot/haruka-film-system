// utils/hashtags.js
// つぶやき本文の「#ハッシュタグ」を切り出す純関数群。
//
// ルール（X/Twitter に寄せつつ日本語向けに調整）:
//   ・「#」または全角「＃」に続く 文字（Unicode の文字・数字）/ _ / ー / 々 の連なりをタグとする
//   ・直前が 行頭 / 空白 / 開き括弧類 / 句読点 のときだけタグ扱い
//       → URL のフラグメント（example.com/#top）や「&#123;」「PR#1218」は拾わない
//   ・数字だけ（#1 / #2026）はタグにしない（番号・順位の表記と区別がつかないため）
//   ・長さ上限 50 文字（超えたらタグ扱いしない）
//   ・検索キーは NFKC + 小文字（「＃ＨＦＳ」「#hfs」「#HFS」は同じタグ）
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/hashtags')
//   - ブラウザ: server.js が /js/hashtags.js で配信 → window.Hashtags
//     （本文のタグリンク化と、サーバー側の `?tag=` 絞り込みで同じ切り出しを使う）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Hashtags = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TAG_LEN = 50;
  // 直前に許す文字: 行頭 / 空白(全角含む) / 開き括弧・引用符類 / 句読点（「#完了、#次へ」のように続けて書く用）
  const BOUNDARY_BEFORE = /[\s\u3000(（[［{｛「『【〈《"'“‘、。，．・,.;:!?！？]/;
  // タグ本体に許す文字
  const TAG_CHAR = /[\p{L}\p{N}_ー々〆]/u;
  const ALL_DIGITS = /^[\p{Nd}]+$/u;

  function normalizeHashtag(tag) {
    return String(tag ?? '').normalize('NFKC').replace(/^[#＃]/, '').toLowerCase();
  }

  // 本文中のタグ位置を返す: [{ tag, key, start, end }] （start は「#」の位置、end は排他）
  function extractHashtags(text) {
    const s = String(text ?? '');
    const out = [];
    const chars = Array.from(s); // サロゲートペア安全に走査（絵文字の直後の # など）
    let idx = 0;                 // UTF-16 オフセット
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if ((ch === '#' || ch === '＃') && (i === 0 || BOUNDARY_BEFORE.test(chars[i - 1]))) {
        let j = i + 1;
        let body = '';
        while (j < chars.length && TAG_CHAR.test(chars[j])) { body += chars[j]; j++; }
        if (body && !ALL_DIGITS.test(body) && Array.from(body).length <= MAX_TAG_LEN) {
          const raw = ch + body;
          out.push({ tag: body, key: normalizeHashtag(body), start: idx, end: idx + raw.length });
          idx += raw.length;
          i = j - 1;
          continue;
        }
      }
      idx += ch.length;
    }
    return out;
  }

  // 本文に含まれるタグの検索キー（重複なし・出現順）
  function uniqueHashtagKeys(text) {
    const seen = new Set();
    const keys = [];
    for (const h of extractHashtags(text)) {
      if (seen.has(h.key)) continue;
      seen.add(h.key);
      keys.push(h.key);
    }
    return keys;
  }

  function hasHashtag(text, tag) {
    const key = normalizeHashtag(tag);
    if (!key) return false;
    return uniqueHashtagKeys(text).includes(key);
  }

  // 複数本文からタグの出現数を集計 → [{ tag, key, count }]（count 降順・同数は表示名順）
  // 表示名 tag は最初に出てきた表記（「#勝ちクリエイティブ」の大文字小文字などをそのまま残す）
  function countHashtags(bodies) {
    const map = new Map();
    for (const body of bodies || []) {
      for (const key of uniqueHashtagKeys(body)) {
        if (!map.has(key)) {
          const first = extractHashtags(body).find(h => h.key === key);
          map.set(key, { tag: first ? first.tag : key, key, count: 0 });
        }
        map.get(key).count += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, 'ja'));
  }

  // PostgREST の ilike パターン用に % _ \ をエスケープ
  function escapeLikePattern(s) {
    return String(s ?? '').replace(/[\\%_]/g, m => '\\' + m);
  }

  return {
    MAX_TAG_LEN,
    normalizeHashtag,
    extractHashtags,
    uniqueHashtagKeys,
    hasHashtag,
    countHashtags,
    escapeLikePattern,
  };
}));

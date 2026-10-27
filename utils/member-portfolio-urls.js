// utils/member-portfolio-urls.js
// メンバーのポートフォリオ（実績）URL（users.portfolio_urls）を扱う純関数群。
//
// 保存形: JSONB 配列 [{ url: 'https://…', title: '任意の見出し' | null }, …]
// 入力形: メンバー編集モーダルのテキストエリア。1 行 1 件で「見出し URL」または「URL」だけ。
//   例) ブランドムービー https://youtu.be/xxxx
//       https://drive.google.com/file/d/…
//       https://example.com/lp  採用LP
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/member-portfolio-urls')
//   - ブラウザ: server.js が /js/member-portfolio-urls.js で配信 → window.MemberPortfolioUrls
//     （モーダルの入力解析・一覧の表示とサーバーの保存時検証で同じロジックを共有する）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MemberPortfolioUrls = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ITEMS = 20;
  const MAX_URL_LEN = 2000;
  const MAX_TITLE_LEN = 80;

  // 「www.」始まりのスキーム省略だけ https を補う。それ以外のスキーム（javascript: 等）は弾く。
  function normalizeUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^www\./i.test(s)) s = 'https://' + s;
    if (!/^https?:\/\//i.test(s)) return null;
    if (s.length > MAX_URL_LEN) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!u.hostname || !u.hostname.includes('.')) return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function normalizeTitle(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/\s+/g, ' ')
      .replace(/^[\s|｜:：\-–—・]+|[\s|｜:：\-–—・]+$/g, '')
      .trim();
    if (!s) return null;
    return s.length > MAX_TITLE_LEN ? s.slice(0, MAX_TITLE_LEN) : s;
  }

  // テキストエリア → { items, errors }。errors は「N 行目: 理由」の配列（空なら保存 OK）。
  function parsePortfolioText(text) {
    const items = [];
    const errors = [];
    const seen = new Set();
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    // 「見出しの行 → 次の行に URL」というチャット由来の貼り方も受け付ける。
    // URL の無い行は直後の URL 行の見出し候補として持ち、使われずに残ったらエラーにする。
    let pending = null; // { lineNo, text }
    const flushPending = () => {
      if (pending) errors.push(`${pending.lineNo} 行目: URL がありません（https:// から貼ってください）`);
      pending = null;
    };
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const m = trimmed.match(/(?:https?:\/\/|www\.)[^\s<>"'「」（）()]+/i);
      if (!m) {
        flushPending();
        pending = { lineNo: i + 1, text: trimmed };
        return;
      }
      const prevTitle = pending ? pending.text : null;
      pending = null;
      const url = normalizeUrl(m[0]);
      if (!url) {
        errors.push(`${i + 1} 行目: URL の形が正しくありません`);
        return;
      }
      if (seen.has(url)) return; // 同じ URL の重複は黙ってまとめる
      seen.add(url);
      const inlineTitle = normalizeTitle(trimmed.slice(0, m.index) + ' ' + trimmed.slice(m.index + m[0].length));
      items.push({ url, title: inlineTitle || normalizeTitle(prevTitle) });
    });
    flushPending();
    if (items.length > MAX_ITEMS) {
      errors.push(`登録できるのは ${MAX_ITEMS} 件までです（いま ${items.length} 件）`);
    }
    return { items, errors };
  }

  // 保存済みの配列 → テキストエリアの初期値
  function formatPortfolioText(items) {
    return (Array.isArray(items) ? items : [])
      .filter(it => it && it.url)
      .map(it => (it.title ? `${it.title} ${it.url}` : it.url))
      .join('\n');
  }

  // サーバー側の保存時検証。配列 or テキストを受け付ける。
  // 戻り値: { items } または { error }
  function normalizePortfolioUrls(input) {
    if (input == null || input === '') return { items: [] };
    if (typeof input === 'string') {
      const { items, errors } = parsePortfolioText(input);
      return errors.length ? { error: errors[0] } : { items };
    }
    if (!Array.isArray(input)) return { error: 'ポートフォリオURLの形式が正しくありません' };
    const items = [];
    const seen = new Set();
    for (const raw of input) {
      const rawUrl = typeof raw === 'string' ? raw : raw && raw.url;
      const url = normalizeUrl(rawUrl);
      if (!url) return { error: `ポートフォリオURLが正しくありません: ${String(rawUrl || '').slice(0, 80)}` };
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({ url, title: normalizeTitle(raw && typeof raw === 'object' ? raw.title : null) });
    }
    if (items.length > MAX_ITEMS) return { error: `ポートフォリオURLは ${MAX_ITEMS} 件までです` };
    return { items };
  }

  // 表示用: リンクの種類（アイコン）と、見出しが無いときに出すラベル
  function portfolioLinkKind(url) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) {}
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return { icon: '▶', kind: 'YouTube', host };
    if (/(^|\.)vimeo\.com$/.test(host)) return { icon: '▶', kind: 'Vimeo', host };
    if (/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/.test(host)) return { icon: '📂', kind: 'Google ドライブ', host };
    if (/(^|\.)instagram\.com$/.test(host)) return { icon: '📷', kind: 'Instagram', host };
    if (/(^|\.)tiktok\.com$/.test(host)) return { icon: '🎵', kind: 'TikTok', host };
    if (/(^|\.)(x|twitter)\.com$/.test(host)) return { icon: '𝕏', kind: 'X', host };
    return { icon: '🔗', kind: 'リンク', host };
  }

  function portfolioLinkLabel(item) {
    if (!item) return '';
    if (item.title) return item.title;
    const k = portfolioLinkKind(item.url);
    return k.kind === 'リンク' ? (k.host || item.url) : k.kind;
  }

  // DB から来た値（JSONB 配列・文字列化された JSON・null）を配列にそろえる
  function toPortfolioArray(value) {
    let v = value;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_) { return []; }
    }
    return Array.isArray(v) ? v.filter(it => it && typeof it.url === 'string' && it.url) : [];
  }

  return {
    MAX_ITEMS,
    normalizeUrl,
    parsePortfolioText,
    formatPortfolioText,
    normalizePortfolioUrls,
    portfolioLinkKind,
    portfolioLinkLabel,
    toPortfolioArray,
  };
});

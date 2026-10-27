// utils/member-portfolio-urls.js
// メンバーのポートフォリオ（実績）URL（users.portfolio_urls）を扱う純関数群。
//
// 保存形: JSONB 配列 [{ url, title, page_label?, industry?, purpose?, role?, tools?, company_ok?, scope?, note? }, …]
//   url / title 以外の詳細項目（DETAIL_FIELDS）は入っているものだけ持つ。
// 入力形: メンバー編集モーダルの「項目名｜URL」行＋詳細欄。チャットの文面を貼ると parsePortfolioText で行に分ける。
//   受け付ける文面の例)
//     ブランドムービー https://youtu.be/xxxx          … 1 行に見出し＋URL
//     会社ホームページ                                 … 見出しの次の行に URL
//     https://arclarejp.com/
//     ◾️ Promasys（EDC）の製品ページ                    … 見出し＋「- ラベル：値」の箇条書き
//     - 見せられるURL：https://site.tedama.co.jp/?page_id=79212
//     - 業種：臨床研究・治験向けのシステム
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
  const MAX_FIELD_LEN = 400;

  // 詳細項目。match は箇条書き「- ラベル：値」のラベル判定（上から順に評価。「担当範囲」を「制作範囲」より先に拾う）
  const DETAIL_FIELDS = [
    { key: 'page_label', label: 'ページ上の表記', placeholder: '例：Promasys｜研究を最速で叶えるEDC', match: /表記|ページ名/ },
    { key: 'industry',   label: '業種',           placeholder: '例：美容・エステ（サロン運営者向け）', match: /業種|業界|ジャンル/ },
    { key: 'purpose',    label: '目的',           placeholder: '例：無料勉強会の参加案内', match: /目的|狙い/, multiline: true },
    { key: 'role',       label: '担当範囲',       placeholder: '例：ヒアリング、構成、ワイヤー、デザイン、実装', match: /担当|役割/, multiline: true },
    { key: 'tools',      label: '使ったツール',   placeholder: '例：Figma、Illustrator、WordPress', match: /ツール|使用ソフト/ },
    { key: 'company_ok', label: '社名の掲載',     placeholder: '可 ／ 不可', match: /社名|クライアント名|掲載可/ },
    { key: 'scope',      label: '制作した部分',   placeholder: '例：ページ全体 ／ 一部（FV のみ）', match: /制作した部分|制作部分|制作範囲/ },
    { key: 'note',       label: 'メモ',           placeholder: '補足があれば', match: /メモ|備考|補足/, multiline: true },
  ];
  const URL_LABEL = /URL|ＵＲＬ|リンク/i;

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

  // 見出し: 行頭の飾り記号（◾️ ■ ◆ ● 【】など）と前後の区切り記号を落とす
  function normalizeTitle(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/\s+/g, ' ')
      .replace(/^[\s|｜:：\-–—・◾◼■□◆◇●○▪▫★☆※►▶#️]+/u, '')
      .replace(/[\s|｜:：\-–—・]+$/g, '')
      .trim();
    if (!s) return null;
    return s.length > MAX_TITLE_LEN ? s.slice(0, MAX_TITLE_LEN) : s;
  }

  function normalizeFieldValue(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
      .trim();
    if (!s) return null;
    return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s;
  }

  // 詳細項目だけを取り出して正規化（空は持たない）
  function pickDetailFields(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    DETAIL_FIELDS.forEach(f => {
      const v = normalizeFieldValue(raw[f.key]);
      if (v) out[f.key] = v;
    });
    return out;
  }

  function fieldKeyForLabel(label) {
    if (URL_LABEL.test(label)) return 'url';
    const f = DETAIL_FIELDS.find(d => d.match.test(label));
    return f ? f.key : null;
  }

  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'「」（）()]+/i;
  const BULLET_RE = /^[-・*•‐－]\s*/;

  // チャットの文面 → { items, errors }。errors は「N 行目…: 理由」の配列（空なら保存 OK）。
  function parsePortfolioText(text) {
    const items = [];
    const errors = [];
    const seen = new Set();
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let cur = null; // 組み立て中の 1 件 { lineNo, title, url, ...詳細 }

    const appendField = (key, value) => {
      const v = normalizeFieldValue(value);
      if (!v) return;
      cur[key] = cur[key] ? `${cur[key]}\n${v}` : v;
    };
    const finish = () => {
      if (!cur) return;
      const c = cur;
      cur = null;
      if (!c.url) {
        errors.push(`${c.lineNo} 行目${c.title ? `「${c.title}」` : ''}: URL がありません（https:// から貼ってください）`);
        return;
      }
      if (seen.has(c.url)) return; // 同じ URL の重複は黙ってまとめる
      seen.add(c.url);
      items.push(Object.assign({ url: c.url, title: c.title || null }, pickDetailFields(c)));
    };

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const lineNo = i + 1;

      // 箇条書き「- ラベル：値」→ 組み立て中の 1 件の詳細に入れる
      if (BULLET_RE.test(trimmed)) {
        const body = trimmed.replace(BULLET_RE, '');
        // 「- https://…」のようにラベル無しで URL だけ書いた箇条書きも URL として扱う
        const bareUrl = /^(?:https?:\/\/|www\.)/i.test(body);
        const fm = bareUrl ? null : body.match(/^([^：:]{1,30}?)\s*[：:]\s*(.*)$/);
        const key = bareUrl ? 'url' : (fm ? fieldKeyForLabel(fm[1]) : null);
        if (key === 'url') {
          const um = (bareUrl ? body : fm[2]).match(URL_RE);
          const url = um ? normalizeUrl(um[0]) : null;
          if (!url) { errors.push(`${lineNo} 行目: URL の形が正しくありません`); return; }
          if (cur && cur.url) finish();
          if (!cur) cur = { lineNo, title: null };
          cur.url = url;
          return;
        }
        if (!cur) cur = { lineNo, title: null };
        if (key) appendField(key, fm[2]);
        else appendField('note', body);
        return;
      }

      const m = trimmed.match(URL_RE);
      if (!m) {
        // URL の無い行 = 次の 1 件の見出し
        finish();
        cur = { lineNo, title: normalizeTitle(trimmed) };
        return;
      }
      const url = normalizeUrl(m[0]);
      if (!url) { errors.push(`${lineNo} 行目: URL の形が正しくありません`); return; }
      const inlineTitle = normalizeTitle(trimmed.slice(0, m.index) + ' ' + trimmed.slice(m.index + m[0].length));
      if (cur && !cur.url) {
        // 見出し（や詳細）の後に来た URL 行 → その 1 件の URL。同じ行の見出しがあれば優先
        cur.url = url;
        if (inlineTitle) cur.title = inlineTitle;
      } else {
        finish();
        cur = { lineNo, title: inlineTitle, url };
      }
    });
    finish();

    if (items.length > MAX_ITEMS) {
      errors.push(`登録できるのは ${MAX_ITEMS} 件までです（いま ${items.length} 件）`);
    }
    return { items, errors };
  }

  // 編集モーダルの行入力（{title, url, ...詳細}）→ { items, errors }。
  // 何も入っていない行は無視。URL が無い・不正な行は「N 件目: 理由」でエラー。
  function collectPortfolioRows(rows) {
    const items = [];
    const errors = [];
    const seen = new Set();
    let n = 0;
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const rawTitle = row && row.title != null ? String(row.title).trim() : '';
      const rawUrl = row && row.url != null ? String(row.url).trim() : '';
      const details = pickDetailFields(row);
      if (!rawTitle && !rawUrl && !Object.keys(details).length) return;
      n++;
      if (!rawUrl) { errors.push(`${n} 件目${rawTitle ? `「${rawTitle}」` : ''}: URL を入れてください`); return; }
      const url = normalizeUrl(rawUrl);
      if (!url) { errors.push(`${n} 件目: URL の形が正しくありません（https:// から入れてください）`); return; }
      if (seen.has(url)) return;
      seen.add(url);
      items.push(Object.assign({ url, title: normalizeTitle(rawTitle) }, details));
    });
    if (items.length > MAX_ITEMS) {
      errors.push(`登録できるのは ${MAX_ITEMS} 件までです（いま ${items.length} 件）`);
    }
    return { items, errors };
  }

  // 1 つの欄に複数行・複数 URL が貼られたか（行に分けて取り込むかの判定）
  function looksLikeBulkPaste(text) {
    const s = String(text == null ? '' : text);
    const urls = s.match(/(?:https?:\/\/|www\.)\S+/gi) || [];
    return urls.length >= 2 || (urls.length >= 1 && /\n\s*\S/.test(s.trim()));
  }

  // 保存済みの配列 → 共有用テキスト（「まとめてコピー」）。詳細があれば箇条書きで出し、parsePortfolioText で読み戻せる形にする
  function formatPortfolioText(items) {
    return toPortfolioArray(items).map(it => {
      const details = DETAIL_FIELDS.filter(f => it[f.key]);
      if (!details.length) return it.title ? `${it.title} ${it.url}` : it.url;
      const lines = [`◾️ ${it.title || portfolioLinkLabel(it)}`, `- URL：${it.url}`];
      details.forEach(f => lines.push(`- ${f.label}：${String(it[f.key]).replace(/\n/g, ' ／ ')}`));
      return lines.join('\n');
    }).join('\n\n');
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
      const obj = raw && typeof raw === 'object' ? raw : {};
      items.push(Object.assign({ url, title: normalizeTitle(obj.title) }, pickDetailFields(obj)));
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

  // 一覧モーダルに出す詳細の [{label, value}]（入っている項目だけ・定義順）
  function portfolioDetailRows(item) {
    if (!item) return [];
    return DETAIL_FIELDS.filter(f => item[f.key]).map(f => ({ key: f.key, label: f.label, value: String(item[f.key]) }));
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
    DETAIL_FIELDS,
    normalizeUrl,
    parsePortfolioText,
    collectPortfolioRows,
    looksLikeBulkPaste,
    formatPortfolioText,
    normalizePortfolioUrls,
    portfolioLinkKind,
    portfolioLinkLabel,
    portfolioDetailRows,
    toPortfolioArray,
  };
});

// utils/portfolio-external.js
// =====================================================
// 🌐 みんなのポートフォリオ（外部作品）の純関数（ADR 045）。
//
// 作品ページに「HFS の案件外で作った作品」を URL 貼り付け／ファイルアップロードで
// 追加するときの、入力の判定・正規化・AI 提案の検証をここに集める。
// I/O（Drive / YouTube oEmbed / Gemini）は routes/haruka.js と lib/portfolio-external-ai.js。
//
// 判定の優先順位（detectExternalSource）:
//   1. YouTube（watch / shorts / embed / live / youtu.be）→ youtube
//   2. Google ドライブのファイル共有 URL（/file/d/<id> / open?id= / uc?id=）→ drive
//      フォルダ URL（/drive/folders/）は登録できないので drive_folder として弾く
//   3. それ以外の http(s) → link（OGP からタイトル・画像を拾う）
//
// routes/haruka.js から使う。純関数なのでテスト対象（tests/utils/portfolio-external.test.js）。
// =====================================================

const EXTERNAL_TITLE_MAX = 200;
const EXTERNAL_DESC_MAX = 500;
const EXTERNAL_CLIENT_MAX = 100;
const EXTERNAL_SOURCE_TYPES = ['youtube', 'drive', 'upload', 'link'];
const EXTERNAL_MEDIA_KINDS = ['video', 'image', 'web'];

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

function safeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch (_) {
    return null;
  }
}

/** URL から YouTube の videoId（11 文字）を取り出す。取れなければ null */
function extractYouTubeIdFromUrl(url) {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0] || null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/);
      if (m) id = m[1];
    }
  }
  return (id && YT_ID_RE.test(id)) ? id : null;
}

/** Google ドライブの共有 URL からファイル ID を取り出す。取れなければ null */
function extractDriveFileIdFromUrl(url) {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.replace(/^www\./, '');
  if (!/(^|\.)google\.com$/.test(host) && host !== 'googleusercontent.com') return null;
  // フォルダは対象外（呼び出し側で drive_folder として案内する）
  if (/\/folders\//.test(u.pathname)) return null;
  let id = null;
  const m = u.pathname.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]+)/);
  if (m) id = m[1];
  if (!id) id = u.searchParams.get('id');
  return (id && DRIVE_ID_RE.test(id)) ? id : null;
}

/**
 * 貼り付けられた URL の種類を判定する。
 * @returns {{ type: 'youtube'|'drive'|'drive_folder'|'link'|null, youtube_id?:string, drive_file_id?:string, url:string|null }}
 */
function detectExternalSource(input) {
  const u = safeUrl(input);
  if (!u) return { type: null, url: null };
  const url = u.toString();
  const yt = extractYouTubeIdFromUrl(url);
  if (yt) return { type: 'youtube', youtube_id: yt, url };
  const host = u.hostname.replace(/^www\./, '');
  if (/(^|\.)google\.com$/.test(host) && /\/folders\//.test(u.pathname)) {
    return { type: 'drive_folder', url };
  }
  const drive = extractDriveFileIdFromUrl(url);
  if (drive) return { type: 'drive', drive_file_id: drive, url };
  return { type: 'link', url };
}

/**
 * YouTube の向きのヒント。Shorts の URL なら縦、oEmbed の width/height が縦長なら縦。
 * 判定できなければ 'landscape'（YouTube の大半は横）。
 */
function youtubeOrientationHint(url, oembed) {
  const u = safeUrl(url);
  if (u && /^\/shorts\//.test(u.pathname)) return 'portrait';
  const w = Number(oembed?.width), h = Number(oembed?.height);
  if (w > 0 && h > 0) {
    const r = w / h;
    if (r <= 0.9) return 'portrait';
    if (r < 1.15) return 'square';
  }
  return 'landscape';
}

/** MIME から media_kind を決める（video/* → video、image/* → image、それ以外 → null） */
function mediaKindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  return null;
}

/**
 * 作品ページの表現軸（utils/portfolio-genre.js の derivePortfolioStyle）に流し込むための
 * 擬似 creative_type。外部作品は creatives ではないので、種別だけ揃えた値を使う。
 *   video → 'video_external'（向きで 縦型ショート / 正方形 / 横型 に分かれる）
 *   image → 'design_external'（→ その他の静止画）
 *   web   → 'lp'（→ LP・Webサイト）
 */
function externalCreativeType(mediaKind) {
  if (mediaKind === 'video') return 'video_external';
  if (mediaKind === 'web') return 'lp';
  return 'design_external';
}

/** 幅・高さから向き（portfolioOrientation と同じしきい値） */
function orientationOf(w, h) {
  const a = Number(w), b = Number(h);
  if (!(a > 0 && b > 0)) return null;
  const r = a / b;
  if (r <= 0.9) return 'portrait';
  if (r < 1.15) return 'square';
  return 'landscape';
}

function clampText(v, max) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * AI（Gemini）が返した提案 JSON を、許可された値だけに正規化する。
 * 未知の code は落とす（DB に勝手な値を入れない）。返り値は「提案として画面に出す」用。
 */
function sanitizeAiSuggestion(raw, { genreCodes = [], styleCodes = [] } = {}) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const genreSet = new Set(genreCodes);
  const styleSet = new Set(styleCodes);
  const genre = String(r.genre_code || '').trim();
  const style = String(r.style_code || '').trim();
  const kind = String(r.media_kind || '').trim().toLowerCase();
  const tags = Array.isArray(r.tags) ? r.tags.map(t => clampText(t, 30)).filter(Boolean).slice(0, 8) : [];
  return {
    title:       clampText(r.title, EXTERNAL_TITLE_MAX) || null,
    description: clampText(r.description, EXTERNAL_DESC_MAX) || null,
    client_name: clampText(r.client_name, EXTERNAL_CLIENT_MAX) || null,
    genre_code:  genreSet.has(genre) ? genre : null,
    style_code:  styleSet.has(style) ? style : null,
    media_kind:  EXTERNAL_MEDIA_KINDS.includes(kind) ? kind : null,
    tags,
    confidence:  (typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1) ? r.confidence : null,
  };
}

/**
 * 登録／更新 API の body を検証して、DB に入れる形に整える。
 * @returns {{ ok:true, data:object } | { ok:false, error:string }}
 */
function normalizeExternalWorkInput(body, { partial = false } = {}) {
  const b = (body && typeof body === 'object') ? body : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has('title')) {
    const title = clampText(b.title, EXTERNAL_TITLE_MAX);
    if (!title) return { ok: false, error: 'タイトルを入力してください' };
    out.title = title;
  }
  if (!partial || has('description')) out.description = clampText(b.description, EXTERNAL_DESC_MAX) || null;
  if (!partial || has('client_name')) out.client_name = clampText(b.client_name, EXTERNAL_CLIENT_MAX) || null;
  if (!partial || has('media_kind')) {
    const kind = String(b.media_kind || 'video').trim().toLowerCase();
    if (!EXTERNAL_MEDIA_KINDS.includes(kind)) return { ok: false, error: '種別（動画／静止画／Web）が不正です' };
    out.media_kind = kind;
  }
  if (!partial || has('genre_code')) out.portfolio_genre_code = clampText(b.genre_code, 64) || null;
  if (!partial || has('style_code')) out.portfolio_style_code = clampText(b.style_code, 64) || null;
  if (!partial || has('produced_at')) {
    const raw = String(b.produced_at || '').trim();
    if (raw) {
      const d = toDateOnly(raw);
      if (!d) return { ok: false, error: '制作時期の日付が不正です' };
      out.produced_at = d;
    } else {
      out.produced_at = null;
    }
  }
  if (has('aspect_w') || has('aspect_h')) {
    const w = Number(b.aspect_w), h = Number(b.aspect_h);
    if (w > 0 && h > 0 && w < 100000 && h < 100000) { out.aspect_w = Math.round(w); out.aspect_h = Math.round(h); }
  }
  return { ok: true, data: out };
}

/**
 * 外部作品を編集／削除できるか。本人（持ち主）か admin。
 * 本人判定はロールに依らない（VIEW AS の影響を受けない・ADR 015）。
 */
function canEditExternalWork({ roleCodes = [], userId, work }) {
  if (!work) return false;
  if (userId && work.owner_user_id === userId) return true;
  return roleCodes.includes('admin');
}

/** YouTube の埋め込み URL */
function youtubeEmbedUrl(id) {
  return YT_ID_RE.test(String(id || '')) ? `https://www.youtube.com/embed/${id}` : null;
}
/** YouTube のサムネ URL（hqdefault は全動画に必ずある） */
function youtubeThumbUrl(id) {
  return YT_ID_RE.test(String(id || '')) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
/** YouTube の視聴 URL（Shorts は shorts のまま返したいので元 URL があればそれを優先） */
function youtubeWatchUrl(id, originalUrl) {
  const u = safeUrl(originalUrl);
  if (u && /^\/shorts\//.test(u.pathname)) return `https://www.youtube.com/shorts/${id}`;
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * OGP / <title> を HTML から拾う（外部リンク用）。
 * HTML パーサは入れず、meta タグの正規表現だけで拾う（サーバー負荷を増やさない）。
 */
function parseOpenGraph(html) {
  const s = String(html || '').slice(0, 512 * 1024);
  const pick = (names) => {
    for (const name of names) {
      // 値の中のもう一方の引用符（"Tom's Coffee"）で切れないよう、閉じ引用符は開きと同じものに合わせる
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=(["'])([^>]*?)\\1`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=(["'])([^>]*?)\\1[^>]*(?:property|name)=["']${name}["']`, 'i');
      const m = s.match(re) || s.match(re2);
      if (m && m[2]) return decodeEntities(m[2].trim());
    }
    return null;
  };
  const titleTag = (s.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  return {
    title:       pick(['og:title', 'twitter:title']) || (titleTag ? decodeEntities(titleTag.trim()) : null),
    description: pick(['og:description', 'twitter:description', 'description']),
    image:       pick(['og:image', 'og:image:url', 'twitter:image']),
    site_name:   pick(['og:site_name']),
  };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (m, hex, dec) => {
      const cp = hex ? parseInt(hex, 16) : Number(dec);
      // 範囲外のコードポイントは fromCodePoint が RangeError を投げるので、そのまま残す
      return (Number.isInteger(cp) && cp > 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : m;
    });
}

/**
 * 「同じ作品の URL か」を比べるための形（メンバー欄の URL がもう外部作品になっているかの判定用）。
 *   YouTube → yt:<動画ID>（watch / shorts / youtu.be の違いを吸収）
 *   Drive   → drive:<ファイルID>
 *   その他  → ホスト（www. を外して小文字）＋パス（末尾の / を外す）＋クエリ。# 以降は無視
 */
function comparableUrl(input) {
  const det = detectExternalSource(input);
  if (!det.type) return null;
  if (det.type === 'youtube') return `yt:${det.youtube_id}`;
  if (det.type === 'drive') return `drive:${det.drive_file_id}`;
  const u = safeUrl(det.url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}${u.search}`;
}

/**
 * Drive 共有 URL で貼られたファイルが「HFS 自身の Drive のファイル」か（ADR 045 追補 2026-11-24）。
 * HFS の作品は 🏆 作品ページに納品作品として出るので外部作品にはしない。社内ファイル（請求書・契約書など）を
 * 全員に見せてしまう事故も防ぐ。
 *   - HFS の共有ドライブ（ルートフォルダと同じ driveId）に入っている
 *   - サービスアカウントが持ち主（ownedByMe）＝ HFS がマイドライブで運用しているファイル
 *   - 共有ドライブに入っている（HFS のルートと別の共有ドライブでも。サービスアカウントが入っている共有ドライブ＝
 *     素材広場など HFS が管理する置き場なので、外の人が「共有してくれた」ファイルではない）
 *   - 持ち主が申請者以外の HFS メンバー（メンバーのマイドライブからサービスアカウントに共有されている請求書フォルダなど）
 * @param {{ driveId?:string|null, ownedByMe?:boolean }} meta files.get の結果
 * @param {string|null} hfsDriveId ルートフォルダの driveId（マイドライブ運用なら null）
 * @param {{ ownerIsOtherMember?:boolean }} [opt]
 */
function isHfsInternalDriveFile(meta, hfsDriveId, { ownerIsOtherMember = false } = {}) {
  if (!meta) return false;
  if (meta.ownedByMe === true) return true;
  if (meta.driveId) return true;
  if (ownerIsOtherMember) return true;
  // hfsDriveId は「共有ドライブなら一律で弾く」に含まれる（互換のため引数は残す）
  void hfsDriveId;
  return false;
}

/**
 * 直送アップロードのファイルが「本人がこの機能で上げたファイル」か。
 *   - 本人の置き場（🌐 みんなのポートフォリオ/<メンバー名>）に入っている
 *   - アップロードのセッション発行時にサーバーが付けた印 appProperties.hfs_owner_id が本人
 * drive_file_id を差し替えて HFS の Drive の別ファイル（請求書・契約書など）を公開・登録させないための確認。
 * 同じニックネームの人が置き場を共有してしまっても、印で他人のファイルは弾ける。
 * @param {{ parents?:string[], appProperties?:object }} meta
 * 置き場は名前で引き直すので、ニックネーム変更・同名フォルダの二重作成があると別 ID になりうる。
 * そのため folderIds に「置き場として認める ID の候補」を複数渡せる（ルートの 🌐 フォルダ直下のフォルダ）。
 * @param {{ parents?:string[], appProperties?:object }} meta
 * @param {{ folderId?:string|null, folderIds?:string[], userId:string }} who
 */
function isOwnPortfolioUpload(meta, { folderId, folderIds, userId } = {}) {
  const allowed = new Set([folderId, ...(Array.isArray(folderIds) ? folderIds : [])].filter(Boolean));
  if (!meta || !allowed.size || !userId) return false;
  const parents = Array.isArray(meta.parents) ? meta.parents : [];
  if (!parents.some(p => allowed.has(p))) return false;
  const props = (meta.appProperties && typeof meta.appProperties === 'object') ? meta.appProperties : {};
  return props.hfs_kind === 'portfolio_external' && String(props.hfs_owner_id || '') === String(userId);
}

/**
 * inspect（読み取り）の結果をサーバーが短時間だけ覚えておく入れ物（ADR 045 追補 2026-11-24）。
 * 登録（POST）はクライアントが送ってきた source・AI の費用を信じず、ここに覚えた値を使う。
 *   put(userId, value) → token（推測できない 32 桁の英数字）
 *   get(token, userId) → value | null（他人の token・期限切れは null）
 *   remove(token)
 * プロセス内の Map なので再起動で消える（そのときは「もう一度読み取ってください」）。
 */
function createInspectTokenStore({ ttlMs = 2 * 60 * 60 * 1000, max = 2000, now = () => Date.now(), randomToken } = {}) {
  const map = new Map();
  const gen = randomToken || (() => require('crypto').randomBytes(16).toString('hex'));
  function sweep() {
    const t = now();
    for (const [k, v] of map) { if (v.expiresAt <= t) map.delete(k); }
    while (map.size >= max) map.delete(map.keys().next().value);   // 古い順に捨てる
  }
  return {
    put(userId, value) {
      sweep();
      const token = gen();
      map.set(token, { userId: String(userId || ''), value, expiresAt: now() + ttlMs });
      return token;
    },
    get(token, userId) {
      const e = map.get(String(token || ''));
      if (!e) return null;
      if (e.expiresAt <= now()) { map.delete(String(token)); return null; }
      if (!userId || e.userId !== String(userId)) return null;
      return e.value;
    },
    remove(token) { map.delete(String(token || '')); },
    size() { return map.size; },
  };
}

module.exports = {
  EXTERNAL_TITLE_MAX,
  EXTERNAL_DESC_MAX,
  EXTERNAL_CLIENT_MAX,
  EXTERNAL_SOURCE_TYPES,
  EXTERNAL_MEDIA_KINDS,
  extractYouTubeIdFromUrl,
  extractDriveFileIdFromUrl,
  detectExternalSource,
  youtubeOrientationHint,
  mediaKindFromMime,
  externalCreativeType,
  orientationOf,
  sanitizeAiSuggestion,
  normalizeExternalWorkInput,
  canEditExternalWork,
  youtubeEmbedUrl,
  youtubeThumbUrl,
  youtubeWatchUrl,
  parseOpenGraph,
  comparableUrl,
  isHfsInternalDriveFile,
  isOwnPortfolioUpload,
  createInspectTokenStore,
};

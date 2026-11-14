// utils/sales.js — 🤝 営業・名刺管理（ADR 056）の純関数
// DB・外部 API に触らない判定と整形だけを置く（jest: tests/sales.test.js）。

const crypto = require('crypto');

// 営業の進み具合。並びは画面の列順
const STAGES = [
  { code: 'met',         label: '出会い',       emoji: '🤝' },
  { code: 'approach',    label: 'アプローチ中', emoji: '✉' },
  { code: 'negotiating', label: '商談中',       emoji: '💬' },
  { code: 'proposal',    label: '提案・見積',   emoji: '📄' },
  { code: 'won',         label: '受注',         emoji: '🎉' },
  { code: 'hold',        label: '保留',         emoji: '⏸' },
  { code: 'lost',        label: '失注',         emoji: '✖' },
];
const STAGE_CODES = STAGES.map((s) => s.code);
const isValidStage = (code) => STAGE_CODES.includes(String(code));

// 差出人ごとの 1 日の送信上限（JST の日付で数える）
const DAILY_SEND_LIMIT = 50;

// ----- 文字列の整え -----
const trimOrNull = (v, max = 2000) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};

// メールアドレス 1 件だけを受け付ける（カンマ・空白・改行を含むものは不可＝複数宛先やヘッダ混入を防ぐ）
function normalizeEmail(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(s)) return null;
  if (s.length > 254) return null;
  return s;
}
const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const isDateString = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

// 連絡先の入力を DB 列に整える。partial=true（更新）のときは渡された項目だけ返す
const CONTACT_TEXT_FIELDS = {
  name: 200, name_kana: 200, company: 200, department: 200, job_title: 200,
  phone: 60, postal_code: 20, address: 500, website: 500,
  business_summary: 2000, met_place: 200, met_event: 200,
  shared_note: 5000, next_action: 500,
};
function sanitizeContactInput(body, { partial = false } = {}) {
  const src = body || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  for (const [k, max] of Object.entries(CONTACT_TEXT_FIELDS)) {
    if (partial && !has(k)) continue;
    out[k] = trimOrNull(src[k], max);
  }
  if (!partial || has('email')) {
    const raw = trimOrNull(src.email, 254);
    if (raw && !normalizeEmail(raw)) return { error: 'メールアドレスの形式が正しくありません（1 件だけ入力してください）' };
    out.email = raw ? normalizeEmail(raw) : null;
  }
  for (const k of ['met_on', 'next_action_on']) {
    if (partial && !has(k)) continue;
    const raw = trimOrNull(src[k], 10);
    if (raw && !isDateString(raw)) return { error: '日付の形式が正しくありません' };
    out[k] = raw;
  }
  if (!partial || has('expected_amount')) {
    const raw = src.expected_amount;
    if (raw === undefined || raw === null || raw === '') out.expected_amount = null;
    else {
      const n = Number(String(raw).replace(/[,，\s円¥]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 2000000000) return { error: '見込み金額は 0 以上の数字で入力してください' };
      out.expected_amount = Math.round(n);
    }
  }
  if (!partial || has('do_not_email')) out.do_not_email = src.do_not_email === true || src.do_not_email === 'true';
  if (has('client_id')) out.client_id = src.client_id ? String(src.client_id) : null;
  if ((!partial || has('name')) && !out.name) return { error: '氏名を入力してください' };
  if (out.website && !/^https?:\/\//i.test(out.website)) out.website = `https://${out.website}`;
  return { values: out };
}

// 名刺画像の data URL を検査する（JPEG / PNG / WebP・上限 6MB）
const CARD_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
function parseImageDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > CARD_IMAGE_MAX_BYTES) return null;
  return { mimeType: m[1], buffer };
}

// ----- 権限 -----
// 連絡先を直せるのは担当と管理者（実効ロール）
const canEditContact = ({ contact, userId, isAdmin }) =>
  !!contact && (isAdmin === true || String(contact.owner_user_id) === String(userId));

// actor が sender の名前（Gmail）でメールを作れる・送れるか。
//   本人、または sender が代理に認めた人だけ。管理者でも他人の名前では送れない。
//   delegateOwnerIds = actor に代理を認めている人（sales_mail_delegates.owner_user_id）の一覧
function canActAsSender({ actorId, senderId, delegateOwnerIds }) {
  if (!actorId || !senderId) return false;
  if (String(actorId) === String(senderId)) return true;
  return (delegateOwnerIds || []).map(String).includes(String(senderId));
}

// 送信してよいかの最終判定。ok でなければ { status, code, error } を返す
function checkSendable({ mail, contact, actorId, delegateOwnerIds, viewAs, confirmToEmail, sentToday, dailyLimit = DAILY_SEND_LIMIT }) {
  const ng = (status, code, error) => ({ ok: false, status, code, error });
  if (!mail || !contact) return ng(404, 'not_found', 'メールが見つかりません');
  if (viewAs) return ng(403, 'view_as', 'VIEW AS 中は送信できません');
  if (!canActAsSender({ actorId, senderId: mail.sender_user_id, delegateOwnerIds })) {
    return ng(403, 'not_allowed', 'このメールを送れるのは差出人本人か、差出人が代理に認めた人だけです');
  }
  if (mail.status === 'sent' || mail.status === 'sending') return ng(409, 'already_sent', 'このメールは送信済み（または送信中）です');
  if (contact.archived_at) return ng(400, 'archived', 'アーカイブした相手には送れません');
  if (contact.do_not_email) return ng(400, 'do_not_email', 'この方は「今後メールを送らない」になっています');
  const to = normalizeEmail(mail.to_email);
  if (!to) return ng(400, 'invalid_to', '宛先のメールアドレスが正しくありません');
  if (!sameEmail(to, confirmToEmail)) return ng(400, 'recipient_mismatch', '確認した宛先と下書きの宛先が違います。画面を開き直してください');
  if (!String(mail.subject || '').trim()) return ng(400, 'empty_subject', '件名を入力してください');
  if (!String(mail.body || '').trim()) return ng(400, 'empty_body', '本文を入力してください');
  if (Number(sentToday) >= dailyLimit) return ng(429, 'daily_limit', `1 日に送れるのは ${dailyLimit} 通までです`);
  return { ok: true, to };
}

// ----- プロモ動画 -----
// YouTube / Vimeo の URL から埋め込み用 ID を取り出す。それ以外は 'link'
function parseVideoUrl(input) {
  const raw = String(input || '').trim();
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const idOk = (s) => /^[A-Za-z0-9_-]{6,20}$/.test(s || '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1];
    if (idOk(id)) return { url: raw, provider: 'youtube', embed_id: id };
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (idOk(v)) return { url: raw, provider: 'youtube', embed_id: v };
    const m = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname);
    if (m && idOk(m[1])) return { url: raw, provider: 'youtube', embed_id: m[1] };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /\/(\d{5,12})(?:\/([0-9a-f]{6,20}))?(?:$|[/?#])/.exec(u.pathname);
    // 限定公開の Vimeo は /<id>/<hash>。hash は埋め込み URL の h= に渡す
    if (m) return { url: raw, provider: 'vimeo', embed_id: m[2] ? `${m[1]}?h=${m[2]}` : m[1] };
  }
  return { url: raw, provider: 'link', embed_id: null };
}
function videoThumbnailUrl(video) {
  if (video?.provider === 'youtube' && video.embed_id) return `https://i.ytimg.com/vi/${video.embed_id}/hqdefault.jpg`;
  return null;
}
function videoEmbedUrl(video) {
  if (!video?.embed_id) return null;
  if (video.provider === 'youtube') return `https://www.youtube-nocookie.com/embed/${video.embed_id}?rel=0`;
  if (video.provider === 'vimeo') return `https://player.vimeo.com/video/${video.embed_id}`;
  return null;
}

// 紹介ページ URL の token（推測できない 22 文字）
const generatePageToken = () => crypto.randomBytes(16).toString('base64url');
const isValidPageToken = (t) => /^[A-Za-z0-9_-]{16,64}$/.test(String(t || ''));

// ----- メール本文 -----
// 本文末尾に必ず付ける署名（特定電子メール法: 送信者の表示と、不要の連絡方法）
function buildMailFooter({ senderName, senderEmail, company = 'HARUKA FILM' }) {
  return [
    '――――――――――――――――',
    `${company}　${senderName || ''}`.trim(),
    senderEmail ? `Mail: ${senderEmail}` : null,
    '',
    '※ 名刺を交換させていただいた方へお送りしています。',
    '　今後のご案内が不要な場合は、お手数ですがこのメールにご返信ください。',
  ].filter((l) => l !== null).join('\n');
}

// 実際に送る本文 = 本文 ＋（本文に URL が無ければ）紹介ページ ＋ 署名
function buildFinalBody({ body, promoUrl, footer }) {
  const parts = [String(body || '').replace(/\r\n/g, '\n').trimEnd()];
  if (promoUrl && !parts[0].includes(promoUrl)) {
    parts.push(`▼ 作品のご紹介（動画をご覧いただけます）\n${promoUrl}`);
  }
  if (footer) parts.push(footer);
  return parts.join('\n\n');
}

// ヘッダに入れる値から改行を除く（ヘッダ混入対策）
const headerSafe = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
// 日本語を含むヘッダ値は RFC 2047 の B エンコードで 1 語ずつ（75 文字以内）に分ける
function encodeHeaderWord(v) {
  const s = headerSafe(v);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const chunks = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 39) { chunks.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

// Gmail API（users.messages.send）へ渡す raw（base64url の RFC 5322 メッセージ）を作る
function buildRawMessage({ fromName, fromEmail, to, subject, body }) {
  const toAddr = normalizeEmail(to);
  const fromAddr = normalizeEmail(fromEmail);
  if (!toAddr) throw new Error('宛先のメールアドレスが正しくありません');
  if (!fromAddr) throw new Error('差出人のメールアドレスが取得できません');
  const name = headerSafe(fromName).replace(/["\\]/g, '');
  const from = name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeHeaderWord(name)} <${fromAddr}>` : fromAddr;
  const bodyB64 = Buffer.from(String(body || '').replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64').replace(/(.{76})/g, '$1\r\n');
  const message = [
    `From: ${from}`,
    `To: ${toAddr}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

// ----- 表示・日付 -----
// 「ニックネーム（名前）」（NameDisplay と同じ並び）
function displayName(user) {
  const nick = String(user?.nickname || '').trim();
  const full = String(user?.full_name || '').trim();
  if (nick && full && nick !== full) return `${nick}（${full}）`;
  return nick || full || '';
}
// メールの差出人名・署名に出すのは本名
const senderRealName = (user) => String(user?.full_name || user?.nickname || '').trim();

// JST の「今日 0:00」を UTC ISO で返す
function jstDayStartIso(now = new Date()) {
  const [y, m, d] = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 9 * 60 * 60 * 1000).toISOString();
}
function jstMonthStartIso(now = new Date()) {
  const [y, m] = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - 9 * 60 * 60 * 1000).toISOString();
}

// 紹介ページを数に入れない閲覧（リンクのプレビューを作るロボット等）
const isBotUserAgent = (ua) =>
  !ua || /bot|crawl|spider|preview|facebookexternalhit|slack|line-poker|whatsapp|discord|telegram|skype|curl|wget|python|headless|monitor/i.test(String(ua));

module.exports = {
  STAGES, STAGE_CODES, isValidStage, DAILY_SEND_LIMIT,
  trimOrNull, normalizeEmail, sameEmail, isDateString,
  sanitizeContactInput, parseImageDataUrl, CARD_IMAGE_MAX_BYTES,
  canEditContact, canActAsSender, checkSendable,
  parseVideoUrl, videoThumbnailUrl, videoEmbedUrl,
  generatePageToken, isValidPageToken,
  buildMailFooter, buildFinalBody, buildRawMessage, encodeHeaderWord, headerSafe,
  displayName, senderRealName, jstDayStartIso, jstMonthStartIso, isBotUserAgent,
};

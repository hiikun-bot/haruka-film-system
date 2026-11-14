// routes/sales.js
// =============================================================
// 🤝 営業・名刺管理 API（ADR 056）
//
// mount: server.js で app.use('/api/haruka/sales', require('./routes/sales'))
//        を app.use('/api/haruka', harukaRouter) より前に置く。
//
// 権限:
//   - 見る                … ログイン中の全員
//   - 連絡先を直す        … 担当（owner_user_id）と管理者（実効ロール）
//   - 個人用メモ          … 書いた本人だけ（req.user.id。管理者・VIEW AS でも他人の分は見えない）
//   - メールを作る・送る  … 差出人本人か、差出人が代理に認めた人だけ（req.user.id）。
//                           管理者でも他人の名前では送れない。VIEW AS 中は送信不可
//
// 公開の紹介ページ（/pv/<token>）は routes/promo-public.js。
// =============================================================

const express = require('express');

const supabase = require('../supabase');
const { requireAuth, getEffectiveRoleCodes } = require('../auth');
const { roleCodesMatchAny } = require('../utils/roles');
const oauthLib = require('../lib/google-oauth');
const gmailSend = require('../lib/gmail-send');
const salesAi = require('../lib/sales-ai');
const S = require('../utils/sales');

const router = express.Router();
router.use(requireAuth);

// 一覧に返す列（名刺画像は別テーブル。base64 を一覧に載せない）
const CONTACT_COLUMNS = 'id, owner_user_id, name, name_kana, company, department, job_title, email, phone, postal_code, address, website, business_summary, met_on, met_place, met_event, stage, stage_changed_at, shared_note, next_action, next_action_on, expected_amount, client_id, do_not_email, has_card_image, archived_at, created_at, updated_at';
const MAIL_COLUMNS = 'id, contact_id, sender_user_id, created_by, to_email, subject, body, promo_page_id, ai_generated, status, sent_by, sent_at, gmail_message_id, error_message, created_at, updated_at';
const PAGE_COLUMNS = 'id, token, contact_id, created_by, title, greeting, video_ids, view_count, first_viewed_at, last_viewed_at, revoked_at, created_at';
const VIDEO_COLUMNS = 'id, title, url, provider, embed_id, description, sort_order, is_active, created_by, created_at';

// ----- 共通 -----
const httpError = (status, error, code) => Object.assign(new Error(error), { status, code });
function sendError(res, e, where) {
  const status = e.status || 500;
  if (status >= 500) console.error(`[sales] ${where}:`, e);
  res.status(status).json({ error: status >= 500 && !e.code ? '処理に失敗しました。少し待ってもう一度お試しください' : e.message, code: e.code || undefined });
}
const wrap = (where, fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { sendError(res, e, where); }
};
const ok = (result, where) => {
  if (result.error) throw Object.assign(new Error(result.error.message), { cause: result.error, where });
  return result.data;
};

async function isAdmin(req) {
  try { return roleCodesMatchAny(await getEffectiveRoleCodes(req), ['admin']); } catch (_) { return false; }
}
// VIEW AS（他ロールでの表示確認）中か。送信・代理の設定など「本人としての操作」は止める
const isViewAs = (req) => !!String((req.headers && req.headers['x-view-as']) || '').trim();

function baseUrl(req) {
  const explicit = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (railway) return `https://${railway}`;
  return `${req.protocol}://${req.get('host')}`;
}
const pageUrl = (req, token) => `${baseUrl(req)}/pv/${token}`;

async function usersByIds(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const rows = ok(await supabase.from('users').select('id, nickname, full_name, email').in('id', uniq), 'users');
  return new Map((rows || []).map((u) => [String(u.id), u]));
}
const nameOf = (map, id) => S.displayName(map.get(String(id))) || '（退会したメンバー）';

// 自分に代理を認めている人（＝自分が差出人として選べる相手）の ID
async function delegateOwnerIdsOf(actorId) {
  const rows = ok(await supabase.from('sales_mail_delegates').select('owner_user_id').eq('delegate_user_id', actorId), 'delegates');
  return (rows || []).map((r) => String(r.owner_user_id));
}

async function delegatesPayload(actorId) {
  const [iAllow, allowedBy] = await Promise.all([
    supabase.from('sales_mail_delegates').select('delegate_user_id').eq('owner_user_id', actorId),
    supabase.from('sales_mail_delegates').select('owner_user_id').eq('delegate_user_id', actorId),
  ]);
  const allowIds = (ok(iAllow, 'delegates') || []).map((r) => r.delegate_user_id);
  const byIds = (ok(allowedBy, 'delegates') || []).map((r) => r.owner_user_id);
  const users = await usersByIds([...allowIds, ...byIds]);
  const gmail = await Promise.all(byIds.map((id) => gmailSend.isConnected(id).catch(() => false)));
  return {
    i_allow: allowIds.map((id) => ({ user_id: id, name: nameOf(users, id) })),
    allowed_by: byIds.map((id, i) => ({ user_id: id, name: nameOf(users, id), gmail_connected: gmail[i] })),
  };
}

async function getContactOr404(id) {
  const row = ok(await supabase.from('sales_contacts').select(CONTACT_COLUMNS).eq('id', id).maybeSingle(), 'contact');
  if (!row) throw httpError(404, '連絡先が見つかりません', 'not_found');
  return row;
}
async function assertCanEdit(req, contact) {
  if (!S.canEditContact({ contact, userId: req.user.id, isAdmin: await isAdmin(req) })) {
    throw httpError(403, '直せるのは担当の人と管理者だけです', 'not_allowed');
  }
}

// ==================== 初期情報 ====================
router.get('/bootstrap', wrap('bootstrap', async (req, res) => {
  const actorId = req.user.id;
  const [admin, ai, connected, delegates, membersRes, meRes] = await Promise.all([
    isAdmin(req),
    salesAi.getStatus(),
    gmailSend.isConnected(actorId).catch(() => false),
    delegatesPayload(actorId),
    supabase.from('users').select('id, nickname, full_name, is_external').eq('is_active', true),
    supabase.from('users').select('id, nickname, full_name, email').eq('id', actorId).maybeSingle(),
  ]);
  const me = ok(meRes, 'me') || {};
  const members = (ok(membersRes, 'members') || [])
    .filter((u) => !u.is_external)
    .map((u) => ({ id: u.id, name: S.displayName(u) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  res.json({
    me: { id: actorId, name: S.displayName(me), email: me.email || null },
    is_admin: admin,
    view_as: isViewAs(req),
    stages: S.STAGES,
    ai,
    gmail: { configured: oauthLib.isConfigured(), connected },
    mail_footer: S.buildMailFooter({ senderName: S.senderRealName(me), senderEmail: null }),
    daily_send_limit: S.DAILY_SEND_LIMIT,
    members,
    delegates,
  });
}));

// ==================== 連絡先 ====================
router.get('/contacts', wrap('contacts.list', async (req, res) => {
  const archived = String(req.query.archived || '0') === '1';
  let q = supabase.from('sales_contacts').select(CONTACT_COLUMNS).order('updated_at', { ascending: false }).limit(3000);
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  if (req.query.owner) q = q.eq('owner_user_id', String(req.query.owner));
  let rows = ok(await q, 'contacts') || [];

  const needle = String(req.query.q || '').trim().toLowerCase();
  if (needle) {
    rows = rows.filter((c) => [c.name, c.name_kana, c.company, c.department, c.email, c.met_place, c.met_event, c.business_summary]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  const ids = rows.map((c) => c.id);
  const [admin, users, mailsRes, pagesRes] = await Promise.all([
    isAdmin(req),
    usersByIds(rows.map((c) => c.owner_user_id)),
    ids.length ? supabase.from('sales_mails').select('contact_id, sent_at').eq('status', 'sent').limit(10000) : { data: [] },
    ids.length ? supabase.from('sales_promo_pages').select('contact_id').gt('view_count', 0).limit(10000) : { data: [] },
  ]);
  const sent = new Map();
  for (const m of ok(mailsRes, 'mails') || []) {
    const cur = sent.get(m.contact_id) || { count: 0, last: null };
    cur.count += 1;
    if (!cur.last || String(m.sent_at) > String(cur.last)) cur.last = m.sent_at;
    sent.set(m.contact_id, cur);
  }
  const viewed = new Set((ok(pagesRes, 'pages') || []).map((p) => p.contact_id));
  res.json({
    contacts: rows.map((c) => ({
      ...c,
      owner_name: nameOf(users, c.owner_user_id),
      mail_sent_count: sent.get(c.id)?.count || 0,
      last_mail_sent_at: sent.get(c.id)?.last || null,
      promo_viewed: viewed.has(c.id),
      can_edit: S.canEditContact({ contact: c, userId: req.user.id, isAdmin: admin }),
    })),
  });
}));

async function saveCardImage(contactId, cardImage, aiResult) {
  const parsed = S.parseImageDataUrl(cardImage);
  if (!parsed) throw httpError(400, '名刺画像は JPEG / PNG / WebP・6MB までです', 'invalid_image');
  ok(await supabase.from('sales_contact_cards').upsert({
    contact_id: contactId,
    image_data: String(cardImage),
    ai_result: aiResult && typeof aiResult === 'object' ? aiResult : null,
  }, { onConflict: 'contact_id' }), 'card');
  ok(await supabase.from('sales_contacts').update({ has_card_image: true }).eq('id', contactId), 'card.flag');
}

async function savePrivateNote(contactId, userId, body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').slice(0, 10000);
  ok(await supabase.from('sales_contact_private_notes').upsert({
    contact_id: contactId, user_id: userId, body: text, updated_at: new Date().toISOString(),
  }, { onConflict: 'contact_id,user_id' }), 'private-note');
}

router.post('/contacts', wrap('contacts.create', async (req, res) => {
  const { values, error } = S.sanitizeContactInput(req.body);
  if (error) throw httpError(400, error, 'invalid');
  if (req.body?.card_image && !S.parseImageDataUrl(req.body.card_image)) {
    throw httpError(400, '名刺画像は JPEG / PNG / WebP・6MB までです', 'invalid_image');
  }
  const stage = S.isValidStage(req.body?.stage) ? req.body.stage : 'met';
  const contact = ok(await supabase.from('sales_contacts')
    .insert({ ...values, stage, owner_user_id: req.user.id }).select(CONTACT_COLUMNS).single(), 'contact.insert');
  if (req.body?.card_image) {
    await saveCardImage(contact.id, req.body.card_image, req.body.ai_result);
    contact.has_card_image = true;
  }
  if (String(req.body?.private_note || '').trim()) await savePrivateNote(contact.id, req.user.id, req.body.private_note);
  res.status(201).json({ contact: { ...contact, can_edit: true } });
}));

router.get('/contacts/:id', wrap('contacts.get', async (req, res) => {
  const actorId = req.user.id;
  const contact = await getContactOr404(req.params.id);
  const [admin, noteRes, mailsRes, pagesRes, ownerIds] = await Promise.all([
    isAdmin(req),
    supabase.from('sales_contact_private_notes').select('body').eq('contact_id', contact.id).eq('user_id', actorId).maybeSingle(),
    supabase.from('sales_mails').select(MAIL_COLUMNS).eq('contact_id', contact.id).order('created_at', { ascending: false }),
    supabase.from('sales_promo_pages').select(PAGE_COLUMNS).eq('contact_id', contact.id).order('created_at', { ascending: false }),
    delegateOwnerIdsOf(actorId),
  ]);
  const mails = ok(mailsRes, 'mails') || [];
  const pages = ok(pagesRes, 'pages') || [];
  const users = await usersByIds([contact.owner_user_id, ...mails.flatMap((m) => [m.sender_user_id, m.created_by, m.sent_by])]);
  let clientName = null;
  if (contact.client_id) {
    const c = await supabase.from('clients').select('name').eq('id', contact.client_id).maybeSingle();
    clientName = c.data?.name || null;
  }
  const viewAs = isViewAs(req);
  res.json({
    contact: {
      ...contact,
      owner_name: nameOf(users, contact.owner_user_id),
      client_name: clientName,
      can_edit: S.canEditContact({ contact, userId: actorId, isAdmin: admin }),
    },
    private_note: ok(noteRes, 'note')?.body || '',
    mails: mails.map((m) => {
      const mine = S.canActAsSender({ actorId, senderId: m.sender_user_id, delegateOwnerIds: ownerIds });
      const editable = mine && (m.status === 'draft' || m.status === 'failed');
      return {
        ...m,
        sender_name: nameOf(users, m.sender_user_id),
        sent_by_name: m.sent_by ? nameOf(users, m.sent_by) : null,
        can_edit: editable,
        can_send: editable && !viewAs,
      };
    }),
    promo_pages: pages.map((p) => ({
      id: p.id, url: pageUrl(req, p.token), title: p.title, video_ids: p.video_ids,
      view_count: p.view_count, first_viewed_at: p.first_viewed_at, last_viewed_at: p.last_viewed_at,
      revoked_at: p.revoked_at, created_at: p.created_at,
      can_revoke: !p.revoked_at && (admin || String(p.created_by) === String(actorId)),
    })),
  });
}));

router.patch('/contacts/:id', wrap('contacts.update', async (req, res) => {
  const contact = await getContactOr404(req.params.id);
  await assertCanEdit(req, contact);
  const { values, error } = S.sanitizeContactInput(req.body, { partial: true });
  if (error) throw httpError(400, error, 'invalid');
  const patch = { ...values, updated_at: new Date().toISOString() };
  if (req.body?.stage !== undefined) {
    if (!S.isValidStage(req.body.stage)) throw httpError(400, '進み具合の値が正しくありません', 'invalid');
    if (req.body.stage !== contact.stage) { patch.stage = req.body.stage; patch.stage_changed_at = patch.updated_at; }
  }
  const updated = ok(await supabase.from('sales_contacts').update(patch).eq('id', contact.id).select(CONTACT_COLUMNS).single(), 'contact.update');
  if (req.body?.card_image) await saveCardImage(contact.id, req.body.card_image, req.body.ai_result);
  res.json({ contact: { ...updated, has_card_image: updated.has_card_image || !!req.body?.card_image, can_edit: true } });
}));

router.post('/contacts/:id/stage', wrap('contacts.stage', async (req, res) => {
  const contact = await getContactOr404(req.params.id);
  await assertCanEdit(req, contact);
  const stage = String(req.body?.stage || '');
  if (!S.isValidStage(stage)) throw httpError(400, '進み具合の値が正しくありません', 'invalid');
  const now = new Date().toISOString();
  const updated = ok(await supabase.from('sales_contacts')
    .update({ stage, stage_changed_at: now, updated_at: now }).eq('id', contact.id).select(CONTACT_COLUMNS).single(), 'contact.stage');
  res.json({ contact: { ...updated, can_edit: true } });
}));

// アーカイブ（消さない。一覧から外すだけ）
router.delete('/contacts/:id', wrap('contacts.archive', async (req, res) => {
  const contact = await getContactOr404(req.params.id);
  await assertCanEdit(req, contact);
  const now = new Date().toISOString();
  ok(await supabase.from('sales_contacts').update({ archived_at: now, updated_at: now }).eq('id', contact.id), 'contact.archive');
  res.json({ ok: true });
}));
router.post('/contacts/:id/restore', wrap('contacts.restore', async (req, res) => {
  const contact = await getContactOr404(req.params.id);
  await assertCanEdit(req, contact);
  ok(await supabase.from('sales_contacts').update({ archived_at: null, updated_at: new Date().toISOString() }).eq('id', contact.id), 'contact.restore');
  res.json({ ok: true });
}));

router.get('/contacts/:id/card', wrap('contacts.card', async (req, res) => {
  const row = ok(await supabase.from('sales_contact_cards').select('image_data').eq('contact_id', req.params.id).maybeSingle(), 'card');
  if (!row) throw httpError(404, '名刺画像がありません', 'not_found');
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ image_data: row.image_data });
}));

// 個人用メモ（本人だけ。req.user.id で読む・書く）
router.put('/contacts/:id/private-note', wrap('contacts.private-note', async (req, res) => {
  const contact = await getContactOr404(req.params.id);
  await savePrivateNote(contact.id, req.user.id, req.body?.body);
  res.json({ ok: true });
}));

// ==================== 名刺の AI 読み取り ====================
router.post('/cards/scan', wrap('cards.scan', async (req, res) => {
  const parsed = S.parseImageDataUrl(req.body?.image);
  if (!parsed) throw httpError(400, '名刺画像は JPEG / PNG / WebP・6MB までです', 'invalid_image');
  const { fields, raw } = await salesAi.scanCard({ buffer: parsed.buffer, mimeType: parsed.mimeType, userId: req.user.id });

  // 同じ相手が登録済みか（メール一致 → 氏名＋会社一致）
  let dup = [];
  const email = S.normalizeEmail(fields.email);
  if (email) {
    dup = ok(await supabase.from('sales_contacts').select('id, name, company, owner_user_id').ilike('email', email.replace(/[%_\\]/g, '\\$&')).limit(5), 'dup') || [];
  }
  if (!dup.length && fields.name) {
    let q = supabase.from('sales_contacts').select('id, name, company, owner_user_id').eq('name', fields.name).limit(5);
    if (fields.company) q = q.eq('company', fields.company);
    dup = ok(await q, 'dup') || [];
  }
  const users = await usersByIds(dup.map((d) => d.owner_user_id));
  res.json({
    fields,
    ai_result: raw,
    duplicates: dup.map((d) => ({ id: d.id, name: d.name, company: d.company, owner_name: nameOf(users, d.owner_user_id) })),
  });
}));

// ==================== プロモ動画ライブラリ ====================
const videoOut = (v) => ({ ...v, thumbnail_url: S.videoThumbnailUrl(v) });

router.get('/videos', wrap('videos.list', async (req, res) => {
  let q = supabase.from('sales_promo_videos').select(VIDEO_COLUMNS).order('sort_order').order('created_at');
  if (String(req.query.all || '') !== '1') q = q.eq('is_active', true);
  res.json({ videos: (ok(await q, 'videos') || []).map(videoOut) });
}));

function videoInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body?.title !== undefined) {
    out.title = S.trimOrNull(body?.title, 200);
    if (!out.title) throw httpError(400, 'タイトルを入力してください', 'invalid');
  }
  if (!partial || body?.url !== undefined) {
    const parsed = S.parseVideoUrl(body?.url);
    if (!parsed) throw httpError(400, '動画の URL（https://…）を入力してください', 'invalid');
    Object.assign(out, parsed);
  }
  if (!partial || body?.description !== undefined) out.description = S.trimOrNull(body?.description, 1000);
  if (body?.sort_order !== undefined && Number.isFinite(Number(body.sort_order))) out.sort_order = Math.round(Number(body.sort_order));
  if (body?.is_active !== undefined) out.is_active = body.is_active === true || body.is_active === 'true';
  return out;
}

router.post('/videos', wrap('videos.create', async (req, res) => {
  const row = videoInput(req.body);
  const video = ok(await supabase.from('sales_promo_videos').insert({ ...row, created_by: req.user.id }).select(VIDEO_COLUMNS).single(), 'video.insert');
  res.status(201).json({ video: videoOut(video) });
}));
router.patch('/videos/:id', wrap('videos.update', async (req, res) => {
  const row = videoInput(req.body, { partial: true });
  const video = ok(await supabase.from('sales_promo_videos')
    .update({ ...row, updated_at: new Date().toISOString() }).eq('id', req.params.id).select(VIDEO_COLUMNS).maybeSingle(), 'video.update');
  if (!video) throw httpError(404, '動画が見つかりません', 'not_found');
  res.json({ video: videoOut(video) });
}));
// 非表示にする（発行済みの紹介ページから消えないよう、行は残す）
router.delete('/videos/:id', wrap('videos.hide', async (req, res) => {
  ok(await supabase.from('sales_promo_videos').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.id), 'video.hide');
  res.json({ ok: true });
}));

// ==================== 紹介ページ ====================
router.post('/promo-pages', wrap('promo-pages.create', async (req, res) => {
  const videoIds = [...new Set((Array.isArray(req.body?.video_ids) ? req.body.video_ids : []).map(String))].slice(0, 12);
  if (!videoIds.length) throw httpError(400, '動画を 1 本以上選んでください', 'invalid');
  const found = ok(await supabase.from('sales_promo_videos').select('id').in('id', videoIds).eq('is_active', true), 'videos') || [];
  if (found.length !== videoIds.length) throw httpError(400, '選んだ動画の中に、使えなくなったものがあります。選び直してください', 'invalid');
  let contactId = null;
  if (req.body?.contact_id) contactId = (await getContactOr404(req.body.contact_id)).id;
  const page = ok(await supabase.from('sales_promo_pages').insert({
    token: S.generatePageToken(),
    contact_id: contactId,
    created_by: req.user.id,
    title: S.trimOrNull(req.body?.title, 120) || 'HARUKA FILM 作品のご紹介',
    greeting: S.trimOrNull(req.body?.greeting, 1000),
    video_ids: videoIds,
  }).select(PAGE_COLUMNS).single(), 'page.insert');
  res.status(201).json({ page: { id: page.id, token: page.token, url: pageUrl(req, page.token), title: page.title, video_ids: page.video_ids } });
}));

router.post('/promo-pages/:id/revoke', wrap('promo-pages.revoke', async (req, res) => {
  const page = ok(await supabase.from('sales_promo_pages').select('id, created_by, revoked_at').eq('id', req.params.id).maybeSingle(), 'page');
  if (!page) throw httpError(404, '紹介ページが見つかりません', 'not_found');
  if (String(page.created_by) !== String(req.user.id) && !(await isAdmin(req))) {
    throw httpError(403, '公開を止められるのは発行した本人と管理者だけです', 'not_allowed');
  }
  if (!page.revoked_at) ok(await supabase.from('sales_promo_pages').update({ revoked_at: new Date().toISOString() }).eq('id', page.id), 'page.revoke');
  res.json({ ok: true });
}));

// ==================== メール ====================
// 差出人として actor が動けるか（本人 or 代理）。動けなければ 403
async function assertCanActAs(actorId, senderId) {
  const ownerIds = String(actorId) === String(senderId) ? [] : await delegateOwnerIdsOf(actorId);
  if (!S.canActAsSender({ actorId, senderId, delegateOwnerIds: ownerIds })) {
    throw httpError(403, 'この差出人でメールを作れるのは、本人か、本人が代理に認めた人だけです', 'not_allowed');
  }
  return ownerIds;
}

async function getMailOr404(id) {
  const mail = ok(await supabase.from('sales_mails').select(MAIL_COLUMNS).eq('id', id).maybeSingle(), 'mail');
  if (!mail) throw httpError(404, 'メールが見つかりません', 'not_found');
  return mail;
}

async function resolvePromoPageId(pageId, contactId) {
  if (!pageId) return null;
  const page = ok(await supabase.from('sales_promo_pages').select('id, contact_id, revoked_at').eq('id', pageId).maybeSingle(), 'page');
  if (!page || page.revoked_at) throw httpError(400, '紹介ページが見つからないか、公開を止めてあります', 'invalid');
  if (page.contact_id && String(page.contact_id) !== String(contactId)) throw httpError(400, '別の相手向けの紹介ページです', 'invalid');
  return page.id;
}

function mailFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body?.to_email !== undefined) {
    out.to_email = S.normalizeEmail(body?.to_email);
    if (!out.to_email) throw httpError(400, '宛先のメールアドレスを 1 件だけ、正しい形式で入力してください', 'invalid_to');
  }
  if (!partial || body?.subject !== undefined) out.subject = S.headerSafe(body?.subject).slice(0, 200);
  if (!partial || body?.body !== undefined) out.body = String(body?.body ?? '').replace(/\r\n/g, '\n').slice(0, 20000);
  return out;
}

const mailOut = (m, users, actorCan, viewAs) => {
  const editable = actorCan && (m.status === 'draft' || m.status === 'failed');
  return {
    ...m,
    sender_name: users ? nameOf(users, m.sender_user_id) : undefined,
    can_edit: editable,
    can_send: editable && !viewAs,
  };
};

router.post('/mails/ai-draft', wrap('mails.ai-draft', async (req, res) => {
  const contact = await getContactOr404(req.body?.contact_id);
  const senderId = String(req.body?.sender_user_id || req.user.id);
  await assertCanActAs(req.user.id, senderId);
  const users = await usersByIds([senderId]);
  const videoIds = (Array.isArray(req.body?.video_ids) ? req.body.video_ids : []).map(String).slice(0, 12);
  const videos = videoIds.length
    ? (ok(await supabase.from('sales_promo_videos').select('id, title').in('id', videoIds), 'videos') || [])
    : [];
  const draft = await salesAi.draftMail({
    contact,
    senderName: S.senderRealName(users.get(senderId)),
    videos,
    instructions: req.body?.instructions,
    userId: req.user.id,
  });
  res.json(draft);
}));

router.post('/mails', wrap('mails.create', async (req, res) => {
  const contact = await getContactOr404(req.body?.contact_id);
  const senderId = String(req.body?.sender_user_id || req.user.id);
  await assertCanActAs(req.user.id, senderId);
  const fields = mailFields(req.body);
  const promoPageId = await resolvePromoPageId(req.body?.promo_page_id, contact.id);
  const mail = ok(await supabase.from('sales_mails').insert({
    ...fields,
    contact_id: contact.id,
    sender_user_id: senderId,
    created_by: req.user.id,
    promo_page_id: promoPageId,
    ai_generated: req.body?.ai_generated === true,
  }).select(MAIL_COLUMNS).single(), 'mail.insert');
  res.status(201).json({ mail: mailOut(mail, await usersByIds([senderId]), true, isViewAs(req)) });
}));

router.patch('/mails/:id', wrap('mails.update', async (req, res) => {
  const mail = await getMailOr404(req.params.id);
  await assertCanActAs(req.user.id, mail.sender_user_id);
  if (mail.status !== 'draft' && mail.status !== 'failed') throw httpError(409, '送信済みのメールは直せません', 'already_sent');
  const patch = { ...mailFields(req.body, { partial: true }), updated_at: new Date().toISOString() };
  if (req.body?.sender_user_id !== undefined && String(req.body.sender_user_id) !== String(mail.sender_user_id)) {
    await assertCanActAs(req.user.id, String(req.body.sender_user_id));
    patch.sender_user_id = String(req.body.sender_user_id);
  }
  if (req.body?.promo_page_id !== undefined) patch.promo_page_id = await resolvePromoPageId(req.body.promo_page_id, mail.contact_id);
  if (req.body?.ai_generated !== undefined) patch.ai_generated = req.body.ai_generated === true;
  // 送信が始まった後の上書きを防ぐ（下書き・失敗のときだけ更新できる）
  const rows = ok(await supabase.from('sales_mails').update(patch).eq('id', mail.id).in('status', ['draft', 'failed']).select(MAIL_COLUMNS), 'mail.update') || [];
  if (!rows.length) throw httpError(409, '送信済みのメールは直せません', 'already_sent');
  res.json({ mail: mailOut(rows[0], await usersByIds([rows[0].sender_user_id]), true, isViewAs(req)) });
}));

router.delete('/mails/:id', wrap('mails.delete', async (req, res) => {
  const mail = await getMailOr404(req.params.id);
  await assertCanActAs(req.user.id, mail.sender_user_id);
  const rows = ok(await supabase.from('sales_mails').delete().eq('id', mail.id).in('status', ['draft', 'failed']).select('id'), 'mail.delete') || [];
  if (!rows.length) throw httpError(409, '送信済みのメールは消せません', 'already_sent');
  res.json({ ok: true });
}));

// 実際に送る内容を組み立てる（プレビューと送信で同じものを使う）
async function composeMail(req, mail, { requireGmail }) {
  const users = await usersByIds([mail.sender_user_id]);
  const sender = users.get(String(mail.sender_user_id));
  let fromEmail = null;
  let gmailConnected = true;
  try {
    fromEmail = await gmailSend.getSenderEmail(mail.sender_user_id);
  } catch (e) {
    if (requireGmail || e.code !== 'gmail_not_connected') throw e;
    gmailConnected = false;
  }
  let promoUrl = null;
  if (mail.promo_page_id) {
    const page = ok(await supabase.from('sales_promo_pages').select('token, revoked_at').eq('id', mail.promo_page_id).maybeSingle(), 'page');
    if (!page || page.revoked_at) throw httpError(400, '付けている紹介ページの公開が止まっています。動画を選び直してください', 'promo_revoked');
    promoUrl = pageUrl(req, page.token);
  }
  const fromName = S.senderRealName(sender);
  const finalBody = S.buildFinalBody({
    body: mail.body,
    promoUrl,
    footer: S.buildMailFooter({ senderName: fromName, senderEmail: fromEmail }),
  });
  return { from_name: fromName, from_email: fromEmail, gmail_connected: gmailConnected, to_email: mail.to_email, subject: mail.subject, final_body: finalBody, promo_url: promoUrl };
}

router.get('/mails/:id/preview', wrap('mails.preview', async (req, res) => {
  const mail = await getMailOr404(req.params.id);
  res.json(await composeMail(req, mail, { requireGmail: false }));
}));

// 送信。誤送信を防ぐ関門はここに集める（ADR 056 §3）
router.post('/mails/:id/send', wrap('mails.send', async (req, res) => {
  const actorId = req.user.id;
  const mail = await getMailOr404(req.params.id);
  const [contact, ownerIds, sentTodayRes] = await Promise.all([
    getContactOr404(mail.contact_id),
    delegateOwnerIdsOf(actorId),
    supabase.from('sales_mails').select('id').eq('sender_user_id', mail.sender_user_id).eq('status', 'sent').gte('sent_at', S.jstDayStartIso()),
  ]);
  const verdict = S.checkSendable({
    mail, contact, actorId,
    delegateOwnerIds: ownerIds,
    viewAs: isViewAs(req),
    confirmToEmail: req.body?.confirm_to_email,
    sentToday: (ok(sentTodayRes, 'sent-today') || []).length,
  });
  if (!verdict.ok) throw httpError(verdict.status, verdict.error, verdict.code);

  // Gmail 未連携・紹介ページ停止はここで弾く（まだ何も確定していない）
  const composed = await composeMail(req, mail, { requireGmail: true });
  const raw = S.buildRawMessage({
    fromName: composed.from_name, fromEmail: composed.from_email,
    to: verdict.to, subject: mail.subject, body: composed.final_body,
  });

  // 「下書き → 送信中」にできた 1 回だけが送る（連打・二重タブでも 1 通）
  const claimedAt = new Date().toISOString();
  const claimed = ok(await supabase.from('sales_mails')
    .update({ status: 'sending', sent_by: actorId, error_message: null, updated_at: claimedAt })
    .eq('id', mail.id).in('status', ['draft', 'failed']).eq('updated_at', mail.updated_at)
    .select('id'), 'mail.claim') || [];
  if (!claimed.length) throw httpError(409, 'このメールは送信済みか、別の画面で変更されました。開き直してください', 'already_sent');

  let sent;
  try {
    sent = await gmailSend.sendRaw({ userId: mail.sender_user_id, raw });
  } catch (e) {
    const definite = e.code === 'gmail_error' || e.code === 'gmail_not_connected';
    const message = definite ? e.message : '送信できたか確認できませんでした。差出人の Gmail の「送信済み」を確認してから、必要なら送り直してください';
    await supabase.from('sales_mails')
      .update({ status: 'failed', error_message: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', mail.id);
    if (!definite) console.error('[sales] mails.send: 送信結果が不明', e);
    throw httpError(e.status && definite ? e.status : 502, message, e.code || 'send_unknown');
  }

  const now = new Date().toISOString();
  const rows = ok(await supabase.from('sales_mails').update({
    status: 'sent', sent_at: now, gmail_message_id: sent.id, to_email: verdict.to,
    // 記録には実際に送った本文（紹介ページ URL・署名つき）を残す
    body: composed.final_body, updated_at: now,
  }).eq('id', mail.id).select(MAIL_COLUMNS), 'mail.sent') || [];

  // 最初のメールを送ったら「出会い」→「アプローチ中」へ進める
  if (contact.stage === 'met') {
    await supabase.from('sales_contacts').update({ stage: 'approach', stage_changed_at: now, updated_at: now }).eq('id', contact.id).eq('stage', 'met');
  } else {
    await supabase.from('sales_contacts').update({ updated_at: now }).eq('id', contact.id);
  }
  res.json({ mail: mailOut(rows[0] || { ...mail, status: 'sent', sent_at: now }, await usersByIds([mail.sender_user_id]), true, false) });
}));

// ==================== 代理送信の許可（本人だけが決める） ====================
router.get('/delegates', wrap('delegates.list', async (req, res) => {
  res.json({ delegates: await delegatesPayload(req.user.id) });
}));

router.post('/delegates', wrap('delegates.add', async (req, res) => {
  if (isViewAs(req)) throw httpError(403, 'VIEW AS 中は変更できません', 'view_as');
  const delegateId = String(req.body?.delegate_user_id || '');
  if (!delegateId || delegateId === String(req.user.id)) throw httpError(400, '代理にする人を選んでください', 'invalid');
  const target = ok(await supabase.from('users').select('id, is_active, is_external').eq('id', delegateId).maybeSingle(), 'user');
  if (!target || target.is_active === false || target.is_external) throw httpError(400, 'そのメンバーは選べません', 'invalid');
  ok(await supabase.from('sales_mail_delegates')
    .upsert({ owner_user_id: req.user.id, delegate_user_id: delegateId }, { onConflict: 'owner_user_id,delegate_user_id' }), 'delegate.add');
  res.json({ delegates: await delegatesPayload(req.user.id) });
}));

router.delete('/delegates/:userId', wrap('delegates.remove', async (req, res) => {
  if (isViewAs(req)) throw httpError(403, 'VIEW AS 中は変更できません', 'view_as');
  ok(await supabase.from('sales_mail_delegates').delete().eq('owner_user_id', req.user.id).eq('delegate_user_id', req.params.userId), 'delegate.remove');
  res.json({ delegates: await delegatesPayload(req.user.id) });
}));

// ==================== Gmail 連携の解除（連携開始は /oauth/google/start?purpose=gmail） ====================
router.post('/gmail/disconnect', wrap('gmail.disconnect', async (req, res) => {
  await gmailSend.disconnect(req.user.id);
  res.json({ ok: true });
}));

module.exports = router;

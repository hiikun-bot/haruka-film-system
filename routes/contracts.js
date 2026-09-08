// routes/contracts.js
// =============================================================
// 📝 契約管理 API（ADR 035 Stage 2）
//
// mount: server.js で app.use('/api/haruka/contracts', require('./routes/contracts'))
//        を app.use('/api/haruka', harukaRouter) より前に置く。
//
// テーブル: billing_parties / contract_documents / contract_document_versions /
//           contract_requests / member_contracts / contract_consents / contract_events
//           （migrations/2026-09-07_contracts.sql・未適用時は 503）
//
// 権限（ADR 003 / 015）:
//   本人系   … requireAuth ＋ user_id = req.user.id 固定（admin バイパスなし）
//   contract.page … 管理者操作すべて
//   contract.view … GET 一覧・詳細の限定列（住所・電話・口座・IP・UA・同意記録本文は返さない）
//   contract.bank_reveal … 口座番号の全桁表示（contract_events に記録）
//   ロール判定は getEffectiveRoleCodes ＋ roleCodesHavePermission（req.user.role 直参照禁止）
//
// ログに口座番号・住所・電話・IP を出さない。
// =============================================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { Readable } = require('stream');

const supabase = require('../supabase');
const {
  requireAuth, requirePermission, requireAnyPermission,
  getEffectiveRoleCodes, getEffectiveRole, userHasPermission, invalidateUserCache,
} = require('../auth');
const { roleCodesHavePermission, pickPrimaryRoleCode } = require('../utils/roles');
const { getClientIP, getUserAgent } = require('../utils/client-ip');
const { sha256Hex, buildConsentRecordHash, verifyChain } = require('../utils/contract-hash');
const { maskAccountNumber, maskProfile } = require('../utils/mask');
const state = require('../utils/contract-state');
const messages = require('../utils/contract-messages');
const { notifyMember, notifyAdmins, NOTIFY_USER_COLUMNS } = require('../utils/member-notify');

const router = express.Router();

// PDF アップロード（≤20MB・application/pdf のみ）
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('PDF ファイル（application/pdf）のみアップロードできます'));
  },
});
// multer のエラー（サイズ超過・形式）を 400 に変換する薄いラッパ
function pdfUpload(field) {
  const mw = uploadPdf.single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'PDF は 20MB 以下にしてください' });
    return res.status(400).json({ error: err.message || 'アップロードに失敗しました' });
  });
}

// ---------- 定数 ----------

const MIGRATION_HINT = '契約管理テーブルが未作成です。migrations/2026-09-07_contracts.sql を適用してください';

const CONTRACT_TABLES = 'billing_parties|contract_documents|contract_document_versions|contract_requests|member_contracts|contract_consents|contract_events';
const USER_NEW_COLUMNS = 'business_type|trade_name|representative_name|name_kana|invoice_name|profile_confirmed_at';

// 本人が更新できる users 列（email はログインIDのため読み取り専用）
const PROFILE_EDITABLE = Object.freeze([
  'full_name', 'name_kana', 'phone', 'postal_code', 'address',
  'business_type', 'trade_name', 'representative_name', 'invoice_name', 'invoice_registration_number',
  'bank_name', 'bank_code', 'branch_name', 'branch_code', 'account_type', 'account_number', 'account_holder_kana',
]);
const PROFILE_SELECT = ['id', 'email', 'nickname', 'is_active', 'profile_confirmed_at', ...PROFILE_EDITABLE].join(', ');
const BUSINESS_TYPES = new Set(['individual', 'sole_proprietor', 'corporation']);
const ACCOUNT_TYPES = new Set(['普通', '当座']);
const PII_KEYS = new Set(['phone', 'postal_code', 'address', 'bank_name', 'bank_code', 'branch_name', 'branch_code',
  'account_type', 'account_number', 'account_holder_kana', 'invoice_registration_number', 'email']);

const PARTY_EDITABLE = Object.freeze([
  'legal_name', 'display_name', 'trade_name', 'representative_title', 'representative_name',
  'postal_code', 'address', 'corporate_number', 'invoice_registration_number', 'court_name',
  'contact_email', 'effective_from', 'effective_to', 'is_active', 'sort_order',
]);

const SETTING_KEYS = Object.freeze({
  contract_remind_interval_days: { type: 'int', default: 3 },
  contract_due_notice_days: { type: 'int', default: 3 },
  contract_expiry_notice_days: { type: 'csv_int', default: '60,30' },
  contract_renewal_notice_days: { type: 'int', default: 30 },
  contract_root_folder_id: { type: 'text', default: '' },
  contract_notify_chatwork_room_id: { type: 'digits', default: '' },
  contract_admin_summary_slack_user_ids: { type: 'csv_text', default: '' },
});

const TOKEN_TTL_DAYS = 90;

// ---------- 共通ヘルパ ----------

function isMissingContractTable(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (err.code === 'PGRST205' && new RegExp(`(${CONTRACT_TABLES})`).test(msg)) return true;
  if (new RegExp(`relation .*(${CONTRACT_TABLES}).* does not exist`).test(msg)) return true;
  if (new RegExp(`Could not find the table 'public\\.(${CONTRACT_TABLES})'`).test(msg)) return true;
  if (new RegExp(`column users\\.(${USER_NEW_COLUMNS}) does not exist`).test(msg)) return true;
  if (err.code === 'PGRST204' && new RegExp(`(${USER_NEW_COLUMNS})`).test(msg)) return true;
  return false;
}

function dbError(error, context) {
  const e = new Error(`${context ? context + ': ' : ''}${error.message || String(error)}`);
  e.code = error.code;
  e.status = error.status;
  return e;
}

function sendError(res, e, fallback = '処理に失敗しました') {
  if (isMissingContractTable(e)) return res.status(503).json({ error: MIGRATION_HINT });
  const status = Number.isInteger(e && e.httpStatus) ? e.httpStatus : 500;
  if (status >= 500) console.error('[contracts]', (e && e.message) || e);
  return res.status(status).json({ error: (e && e.message) || fallback });
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function appBaseUrl() {
  const explicit = (process.env.APP_URL || '').replace(/\/$/, '');
  if (explicit) return explicit;
  const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return railwayDomain ? `https://${railwayDomain}` : '';
}
function requestUrl(token) { return `${appBaseUrl()}/haruka.html?contract_req=${token}`; }
function adminListUrl() { return `${appBaseUrl()}/haruka.html?page=contract-admin`; }

function nowIso() { return new Date().toISOString(); }
function trimOrNull(v) { if (v === undefined) return undefined; const s = v === null ? '' : String(v).trim(); return s === '' ? null : s; }
function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return dflt;
}
function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p.filter(Boolean); } catch (_) { /* noop */ }
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [v];
}
function parseJsonField(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}
function displayNameOf(u) { return (u && (u.nickname || u.full_name)) || ''; }

// 実効ロールベースのアクセス判定（ADR 015: 集合判定。codes 空は旧経路フォールバック）
async function getAccess(req) {
  const codes = await getEffectiveRoleCodes(req);
  const has = async (key) => (codes.length > 0
    ? roleCodesHavePermission(codes, key)
    : userHasPermission(getEffectiveRole(req), key));
  const canManage = await has('contract.page');
  const canView = canManage || await has('contract.view');
  const canBankReveal = await has('contract.bank_reveal');
  const roleLabel = (codes.length > 0 ? pickPrimaryRoleCode(codes) : getEffectiveRole(req)) || null;
  return { codes, canManage, canView, canBankReveal, roleLabel };
}

// contract_events へ 1 行 INSERT（失敗しても本処理は止めない）
async function insertEvent(row) {
  const { error } = await supabase.from('contract_events').insert({
    member_contract_id: row.member_contract_id || null,
    request_id: row.request_id || null,
    user_id: row.user_id || null,
    actor_user_id: row.actor_user_id || null,
    actor_name: row.actor_name || null,
    actor_role: row.actor_role || null,
    action: row.action,
    from_status: row.from_status || null,
    to_status: row.to_status || null,
    detail: row.detail || null,
    ip_address: row.ip_address || null,
    user_agent: row.user_agent || null,
  });
  if (error) console.warn('[contracts] contract_events 記録失敗:', row.action, error.message);
}

async function logEvent(req, access, fields) {
  return insertEvent({
    ...fields,
    actor_user_id: req.user && req.user.id,
    actor_name: req.user && req.user.full_name,
    actor_role: access ? access.roleLabel : null,
    ip_address: getClientIP(req),
    user_agent: getUserAgent(req),
  });
}

// ---------- マスタ取得（小さいテーブルは全件） ----------

async function loadParties() {
  const { data, error } = await supabase.from('billing_parties').select('*').order('sort_order');
  if (error) throw dbError(error, 'billing_parties');
  return data || [];
}
async function loadDocuments() {
  const { data, error } = await supabase.from('contract_documents').select('*').order('sort_order');
  if (error) throw dbError(error, 'contract_documents');
  return data || [];
}
async function loadVersions(opts = {}) {
  let q = supabase.from('contract_document_versions').select(opts.withBody ? '*' : VERSION_COLUMNS);
  if (opts.documentId) q = q.eq('document_id', opts.documentId);
  const { data, error } = await q.order('version_no', { ascending: false });
  if (error) throw dbError(error, 'contract_document_versions');
  return data || [];
}
const VERSION_COLUMNS = 'id, document_id, version_no, version_label, status, effective_from, pdf_drive_file_id, pdf_file_name, pdf_size_bytes, pdf_sha256, body_sha256, fill_fields, change_summary, requires_reconsent, published_at, published_by, supersedes_version_id, created_by, created_at, updated_at';

function indexBy(list, key = 'id') {
  const m = new Map();
  for (const r of list || []) m.set(r[key], r);
  return m;
}

async function loadSettings() {
  const keys = Object.keys(SETTING_KEYS);
  const { data, error } = await supabase.from('system_settings').select('key, value').in('key', keys);
  if (error) throw dbError(error, 'system_settings');
  const raw = new Map((data || []).map(r => [r.key, r.value]));
  const out = {};
  for (const k of keys) {
    const spec = SETTING_KEYS[k];
    const v = raw.has(k) && raw.get(k) !== null && raw.get(k) !== '' ? raw.get(k) : spec.default;
    out[k] = spec.type === 'int' ? Number(v) : String(v);
  }
  return out;
}

function validateSettingValue(key, value) {
  const spec = SETTING_KEYS[key];
  if (!spec) return { error: `不明な設定キー: ${key}` };
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (s === '') return { value: '' };
  switch (spec.type) {
    case 'int': {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) return { error: `${key} は 0 以上の整数で指定してください` };
      return { value: String(n) };
    }
    case 'csv_int': {
      const parts = s.split(',').map(x => x.trim()).filter(Boolean);
      if (parts.some(p => !/^\d+$/.test(p))) return { error: `${key} は「60,30」のようにカンマ区切りの整数で指定してください` };
      return { value: parts.join(',') };
    }
    case 'digits':
      if (!/^\d+$/.test(s)) return { error: `${key} は数字のルームIDで指定してください` };
      return { value: s };
    case 'csv_text':
      return { value: s.split(/[,\s]+/).map(x => x.trim()).filter(Boolean).join(',') };
    default:
      return { value: s.slice(0, 500) };
  }
}

// ---------- Drive ----------

function getHaruka() { return require('./haruka'); }

async function getContractRootFolderId(drive) {
  const { data: setting } = await supabase.from('system_settings').select('value').eq('key', 'contract_root_folder_id').maybeSingle();
  if (setting && setting.value) return setting.value;
  const haruka = getHaruka();
  // 「請求書」フォルダと同じ親に「契約書」を作る。請求書が無ければ HARUKAFILM ルート直下
  let parentId = null;
  const { data: inv } = await supabase.from('system_settings').select('value').eq('key', 'invoice_root_folder_id').maybeSingle();
  if (inv && inv.value) {
    try {
      const meta = await drive.files.get({ fileId: inv.value, fields: 'parents', supportsAllDrives: true });
      parentId = (meta.data.parents || [])[0] || null;
    } catch (e) {
      console.warn('[contracts] 請求書フォルダの親取得に失敗:', e.message);
    }
  }
  if (!parentId) parentId = await haruka.getDriveRootFolderId();
  if (!parentId) throw httpError(500, 'Drive のルートフォルダが未設定です（system_settings.drive_root_folder_id）');
  const folderId = await haruka.getOrCreateFolder(drive, parentId, '契約書');
  await supabase.from('system_settings')
    .upsert({ key: 'contract_root_folder_id', value: folderId, updated_at: nowIso() }, { onConflict: 'key' });
  return folderId;
}

function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}

async function uploadPdfToDrive(drive, folderId, name, buffer) {
  const created = await drive.files.create({
    requestBody: { name, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, name, size',
    supportsAllDrives: true,
  });
  return created.data;
}

// ---------- 本人情報 ----------

async function loadUserProfile(userId) {
  const { data, error } = await supabase.from('users').select(PROFILE_SELECT).eq('id', userId).maybeSingle();
  if (error) throw dbError(error, 'users');
  return data || null;
}

// 本人向け: 口座は masked と full の両方
function profileForSelf(u) {
  if (!u) return null;
  return { ...u, account_number_masked: maskAccountNumber(u.account_number), email_readonly: true };
}
// 管理者（contract.page）向け: 口座は ****下4桁、住所は市区町村まで、電話は下4桁
function profileForAdmin(u) {
  if (!u) return null;
  const masked = maskProfile(u);
  return { ...masked, account_number_masked: maskAccountNumber(u.account_number) };
}
// contract.view 向け: 個人情報列なし
function profileForViewer(u) {
  if (!u) return null;
  const out = {};
  for (const k of Object.keys(u)) if (!PII_KEYS.has(k)) out[k] = u[k];
  return out;
}

function normalizeInvoiceRegistrationNumber(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return { error: '登録番号は文字列で指定してください' };
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const m = trimmed.match(/^[Tt](\d{13})$/);
  if (!m) return { error: '登録番号は「T + 半角数字13桁」の形式で入力してください（例: T1234567890123）' };
  return 'T' + m[1];
}

// profile 入力を検証して users 更新用オブジェクトにする。{ update } or { error }
function buildProfileUpdate(profile) {
  if (!profile || typeof profile !== 'object') return { update: {} };
  const update = {};
  for (const key of PROFILE_EDITABLE) {
    if (!(key in profile)) continue;
    let v = profile[key];
    if (key === 'invoice_registration_number') {
      const n = normalizeInvoiceRegistrationNumber(v === null ? null : String(v));
      if (n && typeof n === 'object' && n.error) return { error: n.error };
      update[key] = n === undefined ? null : n;
      continue;
    }
    v = trimOrNull(v);
    if (key === 'full_name' && !v) return { error: '氏名は空にできません' };
    if (key === 'business_type' && v && !BUSINESS_TYPES.has(v)) return { error: '事業者区分は individual / sole_proprietor / corporation のいずれかです' };
    if (key === 'account_type' && v && !ACCOUNT_TYPES.has(v)) return { error: '口座種別は 普通 / 当座 のいずれかです' };
    if ((key === 'bank_code' || key === 'branch_code') && v && !/^\d{1,4}$/.test(v)) return { error: `${key === 'bank_code' ? '銀行コード' : '支店コード'}は数字で入力してください` };
    if (key === 'account_number' && v && !/^\d{1,8}$/.test(v)) return { error: '口座番号は半角数字（8桁以内）で入力してください' };
    if (key === 'postal_code' && v && !/^\d{3}-?\d{4}$/.test(v)) return { error: '郵便番号は 123-4567 の形式で入力してください' };
    if (key === 'phone' && v && !/^[\d\-+() ]{8,20}$/.test(v)) return { error: '電話番号の形式が正しくありません' };
    if (v && v.length > 200) return { error: `${key} が長すぎます` };
    update[key] = v;
  }
  return { update };
}

// ---------- 差し込み値 ----------

function buildFillValues({ party, user, contract, version, request }) {
  const p = party || {};
  const u = user || {};
  const c = contract || {};
  const v = version || {};
  return {
    party_code: p.code || null,
    party_kind: p.party_kind || null,
    party_legal_name: p.legal_name || null,
    party_display_name: p.display_name || null,
    party_trade_name: p.trade_name || null,
    party_representative_title: p.representative_title || null,
    party_representative_name: p.representative_name || null,
    party_postal_code: p.postal_code || null,
    party_address: p.address || null,
    party_corporate_number: p.corporate_number || null,
    party_invoice_registration_number: p.invoice_registration_number || null,
    party_court_name: p.court_name || null,
    member_full_name: u.full_name || null,
    member_name_kana: u.name_kana || null,
    member_postal_code: u.postal_code || null,
    member_address: u.address || null,
    member_business_type: u.business_type || null,
    member_trade_name: u.trade_name || null,
    member_representative_name: u.representative_name || null,
    member_invoice_name: u.invoice_name || u.full_name || null,
    member_invoice_registration_number: u.invoice_registration_number || null,
    contract_date: c.contract_date || null,
    start_date: c.start_date || null,
    end_date: c.end_date || null,
    auto_renew: c.auto_renew !== undefined ? !!c.auto_renew : null,
    renew_notice_days: c.renew_notice_days ?? null,
    version_no: v.version_no ?? null,
    version_label: v.version_label || null,
    effective_from: v.effective_from || null,
    due_date: request ? (request.due_date || null) : null,
  };
}

// 同意記録の INSERT（ハッシュチェーン）。直前レコードは同一 member_contract の最新行。
async function insertConsent({ req, contract, request, user, version, kind, signerTyped, fillSnapshot, consentedAt }) {
  const { data: prevRows, error: pErr } = await supabase
    .from('contract_consents')
    .select('record_hash')
    .eq('member_contract_id', contract.id)
    .order('consented_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (pErr) throw dbError(pErr, 'contract_consents');
  const prevHash = prevRows && prevRows[0] ? prevRows[0].record_hash : null;
  const fields = {
    member_contract_id: contract.id,
    user_id: user.id,
    document_version_id: contract.document_version_id,
    consent_kind: kind,
    signer_name_typed: signerTyped || null,
    consented_at: consentedAt || nowIso(),
    ip_address: getClientIP(req),
    user_agent: getUserAgent(req),
    pdf_sha256: version ? version.pdf_sha256 || null : null,
    body_sha256: version ? version.body_sha256 || null : null,
    fill_snapshot: fillSnapshot || null,
  };
  const record_hash = buildConsentRecordHash(fields, prevHash);
  const row = {
    ...fields,
    request_id: request ? request.id : null,
    user_email: user.email || null,
    signer_name_registered: user.full_name || null,
    party_code: contract.party_code,
    prev_record_hash: prevHash,
    record_hash,
  };
  const { data, error } = await supabase.from('contract_consents').insert(row).select('*').maybeSingle();
  if (error) throw dbError(error, 'contract_consents');
  return data;
}

// ---------- 契約 → 画面用整形 ----------

function contractToJson(c, ctx, opts = {}) {
  const doc = ctx.docById.get(c.document_id) || null;
  const ver = ctx.verById.get(c.document_version_id) || null;
  const party = ctx.partyByCode.get(c.party_code) || null;
  const req = c.request_id ? (ctx.reqById ? ctx.reqById.get(c.request_id) : null) : null;
  const out = {
    id: c.id,
    user_id: c.user_id,
    request_id: c.request_id,
    document_id: c.document_id,
    document_version_id: c.document_version_id,
    party_code: c.party_code,
    party_name: party ? party.display_name : c.party_code,
    document: doc ? { id: doc.id, doc_type: doc.doc_type, title: doc.title, party_code: doc.party_code } : null,
    version: ver ? { id: ver.id, version_no: ver.version_no, version_label: ver.version_label, effective_from: ver.effective_from, status: ver.status, pdf_sha256: ver.pdf_sha256, has_pdf: !!ver.pdf_drive_file_id } : null,
    status: c.status,
    member_status_label: state.memberFacingStatus(c, req),
    execution_method: c.execution_method,
    contract_date: c.contract_date,
    start_date: c.start_date,
    end_date: c.end_date,
    auto_renew: c.auto_renew,
    renew_notice_days: c.renew_notice_days,
    switch_method: c.switch_method,
    switch_date: c.switch_date,
    predecessor_contract_id: c.predecessor_contract_id,
    billing_party_code: c.billing_party_code,
    first_viewed_at: c.first_viewed_at,
    viewed_completed_at: c.viewed_completed_at,
    submitted_at: c.submitted_at,
    signed_at: c.signed_at,
    approved_at: c.approved_at,
    revision_requested_at: c.revision_requested_at,
    revision_reason: c.revision_reason,
    ended_at: c.ended_at,
    end_reason: c.end_reason,
    expiry_notice_stage: c.expiry_notice_stage,
    has_external_pdf: !!c.external_pdf_drive_file_id,
    external_pdf_url: c.external_pdf_url || null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
  if (opts.full) {
    out.fill_snapshot = c.fill_snapshot || null;
    out.storage_note = c.storage_note || null;
    out.note = c.note || null;
    out.external_note = c.external_note || null;
    out.has_existing_projects = c.has_existing_projects;
    out.existing_projects_party = c.existing_projects_party;
    out.approved_by = c.approved_by;
    out.revision_requested_by = c.revision_requested_by;
    out.ended_by = c.ended_by;
    out.created_by = c.created_by;
  }
  return out;
}

function requestToJson(r, opts = {}) {
  const out = {
    id: r.id,
    user_id: r.user_id,
    party_code: r.party_code,
    status: r.status,
    due_date: r.due_date,
    channel: r.channel,
    sent_at: r.sent_at,
    first_viewed_at: r.first_viewed_at,
    submitted_at: r.submitted_at,
    completed_at: r.completed_at,
    cancelled_at: r.cancelled_at,
    last_reminded_at: r.last_reminded_at,
    remind_count: r.remind_count,
    has_draft: !!(r.draft_state && Object.keys(r.draft_state).length),
    onboarding_record_id: r.onboarding_record_id,
    requested_by: r.requested_by,
    requested_at: r.requested_at,
    token_expires_at: r.token_expires_at,
    token_expired: state.isTokenExpired(r.token_expires_at),
  };
  if (opts.self || opts.manage) {
    out.draft_state = r.draft_state || null;
    out.signer_name = r.signer_name || null;
    out.message = r.message || null;
    out.url = requestUrl(r.token);
    out.token = r.token;
    out.send_result = r.send_result || null;
  }
  return out;
}

async function buildContext(extra = {}) {
  const [parties, documents, versions] = await Promise.all([loadParties(), loadDocuments(), loadVersions()]);
  return {
    parties, documents, versions,
    partyByCode: indexBy(parties, 'code'),
    docById: indexBy(documents),
    verById: indexBy(versions),
    ...extra,
  };
}

// 依頼の完了判定（全 member_contracts が open でなくなったら completed）
async function refreshRequestStatus(requestId) {
  if (!requestId) return;
  const { data: rows, error } = await supabase.from('member_contracts').select('status').eq('request_id', requestId);
  if (error || !rows) return;
  const anyOpen = rows.some(r => state.OPEN_CONTRACT_STATUSES.includes(r.status));
  const anyPending = rows.some(r => state.MEMBER_PENDING_STATUSES.includes(r.status));
  const anySubmitted = rows.some(r => r.status === 'submitted');
  let next;
  if (rows.length === 0 || rows.every(r => r.status === 'cancelled')) next = 'cancelled';
  else if (!anyOpen) next = 'completed';
  else if (anyPending) next = 'open';
  else if (anySubmitted) next = 'submitted';
  else next = 'open';
  const patch = { status: next, updated_at: nowIso() };
  if (next === 'completed') patch.completed_at = nowIso();
  if (next === 'cancelled') patch.cancelled_at = nowIso();
  await supabase.from('contract_requests').update(patch).eq('id', requestId);
}

// =============================================================
// 本人（requireAuth・user_id = req.user.id 固定）
// =============================================================

// GET /me — 自分の依頼・契約・手続き状態サマリ
router.get('/me', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [{ data: requests, error: rErr }, { data: contracts, error: cErr }] = await Promise.all([
      supabase.from('contract_requests').select('*').eq('user_id', uid).order('requested_at', { ascending: false }),
      supabase.from('member_contracts').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
    ]);
    if (rErr) throw dbError(rErr, 'contract_requests');
    if (cErr) throw dbError(cErr, 'member_contracts');
    const ctx = await buildContext({ reqById: indexBy(requests || []) });

    const contractsJson = (contracts || []).map(c => contractToJson(c, ctx));
    const openRequests = (requests || []).filter(r => r.status === 'open');
    const pending = (contracts || []).filter(c => state.MEMBER_PENDING_STATUSES.includes(c.status));
    const reconsent = (contracts || []).filter(c => c.status === 'reconsent_required');

    let banner = null;
    const revision = pending.find(c => c.status === 'revision_requested');
    if (revision) banner = { kind: 'revision', request_id: revision.request_id };
    else if (reconsent.length > 0) {
      const openReq = openRequests.find(r => (contracts || []).some(c => c.request_id === r.id && c.status === 'requested'));
      banner = { kind: 'reconsent', request_id: openReq ? openReq.id : null };
    } else if (pending.length > 0) {
      banner = { kind: 'requested', request_id: pending[0].request_id };
    }

    res.json({
      requests: (requests || []).map(r => requestToJson(r, { self: true })),
      contracts: contractsJson,
      pending_count: pending.length + reconsent.length,
      banner,
    });
  } catch (e) { sendError(res, e); }
});

// 依頼をトークンで取得し本人チェック（他人のトークンは 403）
async function loadOwnRequest(req, token) {
  const { data: request, error } = await supabase.from('contract_requests').select('*').eq('token', String(token || '')).maybeSingle();
  if (error) throw dbError(error, 'contract_requests');
  if (!request) throw httpError(404, '依頼が見つかりません');
  if (request.user_id !== req.user.id) throw httpError(403, 'この依頼URLはあなた宛てではありません');
  return request;
}

async function loadRequestContracts(requestId) {
  const { data, error } = await supabase.from('member_contracts').select('*').eq('request_id', requestId).order('created_at');
  if (error) throw dbError(error, 'member_contracts');
  return data || [];
}

// GET /req/:token — 依頼詳細（初回アクセスで first_viewed_at）
router.get('/req/:token', requireAuth, async (req, res) => {
  try {
    const request = await loadOwnRequest(req, req.params.token);
    const [contracts, user] = await Promise.all([loadRequestContracts(request.id), loadUserProfile(req.user.id)]);
    const ctx = await buildContext({ reqById: new Map([[request.id, request]]) });
    const party = ctx.partyByCode.get(request.party_code) || null;
    const versionsWithBody = await loadVersions({ withBody: true });
    const verBodyById = indexBy(versionsWithBody);

    const ts = nowIso();
    if (!request.first_viewed_at) {
      await supabase.from('contract_requests').update({ first_viewed_at: ts, updated_at: ts }).eq('id', request.id);
      request.first_viewed_at = ts;
      const access = await getAccess(req);
      await logEvent(req, access, { request_id: request.id, user_id: req.user.id, action: 'viewed', detail: { scope: 'request' } });
    }
    const unviewedIds = contracts.filter(c => !c.first_viewed_at).map(c => c.id);
    if (unviewedIds.length) {
      await supabase.from('member_contracts').update({ first_viewed_at: ts, updated_at: ts }).in('id', unviewedIds);
      for (const c of contracts) if (unviewedIds.includes(c.id)) c.first_viewed_at = ts;
    }

    const documents = contracts.map(c => {
      const ver = verBodyById.get(c.document_version_id) || null;
      const doc = ctx.docById.get(c.document_id) || null;
      return {
        member_contract_id: c.id,
        status: c.status,
        member_status_label: state.memberFacingStatus(c, request),
        document: doc ? { id: doc.id, doc_type: doc.doc_type, title: doc.title, description: doc.description, party_code: doc.party_code } : null,
        version: ver ? {
          id: ver.id, version_no: ver.version_no, version_label: ver.version_label, effective_from: ver.effective_from,
          pdf_sha256: ver.pdf_sha256, has_pdf: !!ver.pdf_drive_file_id, pdf_file_name: ver.pdf_file_name,
          fill_fields: ver.fill_fields || [], body_html: ver.body_html || null, change_summary: ver.change_summary || null,
        } : null,
        consent_kind: doc ? state.consentKindForDocType(doc.doc_type) : 'agreed',
        first_viewed_at: c.first_viewed_at,
        viewed_completed_at: c.viewed_completed_at,
        revision_reason: c.status === 'revision_requested' ? c.revision_reason : null,
        start_date: c.start_date, end_date: c.end_date, auto_renew: c.auto_renew, renew_notice_days: c.renew_notice_days,
        fill_values: buildFillValues({ party, user, contract: c, version: ver, request }),
      };
    });

    res.json({
      request: requestToJson(request, { self: true }),
      party: party ? { ...party } : null,
      documents,
      profile: profileForSelf(user),
      fill_values: buildFillValues({ party, user, contract: contracts[0] || null, version: null, request }),
    });
  } catch (e) { sendError(res, e); }
});

// PUT /req/:token/draft — 途中保存＋本人情報更新
router.put('/req/:token/draft', requireAuth, async (req, res) => {
  try {
    const request = await loadOwnRequest(req, req.params.token);
    if (request.status !== 'open') return res.status(400).json({ error: '送信済み（または取消済み）の依頼は編集できません' });
    const body = req.body || {};
    const ts = nowIso();
    const access = await getAccess(req);

    let profileUpdated = [];
    if (body.profile && typeof body.profile === 'object') {
      const { update, error } = buildProfileUpdate(body.profile);
      if (error) return res.status(400).json({ error });
      if (Object.keys(update).length > 0) {
        update.profile_confirmed_at = ts;
        const { error: uErr } = await supabase.from('users').update(update).eq('id', req.user.id);
        if (uErr) throw dbError(uErr, 'users');
        invalidateUserCache(req.user.id);
        profileUpdated = Object.keys(update).filter(k => k !== 'profile_confirmed_at');
      }
    }
    const patch = { updated_at: ts };
    if (body.draft_state !== undefined) {
      patch.draft_state = body.draft_state && typeof body.draft_state === 'object' ? body.draft_state : null;
    }
    const { data: updated, error: rErr } = await supabase.from('contract_requests').update(patch).eq('id', request.id).select('*').maybeSingle();
    if (rErr) throw dbError(rErr, 'contract_requests');

    await logEvent(req, access, {
      request_id: request.id, user_id: req.user.id, action: 'draft_saved',
      detail: { profile_updated: profileUpdated, step: patch.draft_state && patch.draft_state.step != null ? patch.draft_state.step : null },
    });
    const user = await loadUserProfile(req.user.id);
    res.json({ ok: true, request: requestToJson(updated || request, { self: true }), profile: profileForSelf(user) });
  } catch (e) { sendError(res, e); }
});

// POST /req/:token/viewed — 閲覧完了
router.post('/req/:token/viewed', requireAuth, async (req, res) => {
  try {
    const request = await loadOwnRequest(req, req.params.token);
    const { member_contract_id, completed } = req.body || {};
    if (!member_contract_id) return res.status(400).json({ error: 'member_contract_id は必須です' });
    const { data: contract, error } = await supabase.from('member_contracts').select('*')
      .eq('id', member_contract_id).eq('request_id', request.id).eq('user_id', req.user.id).maybeSingle();
    if (error) throw dbError(error, 'member_contracts');
    if (!contract) return res.status(404).json({ error: '対象の文書が見つかりません' });
    const ts = nowIso();
    const patch = { updated_at: ts };
    if (!contract.first_viewed_at) patch.first_viewed_at = ts;
    const access = await getAccess(req);
    if (completed === true || completed === 'true') {
      if (!contract.viewed_completed_at) {
        patch.viewed_completed_at = ts;
        const versions = await loadVersions({ documentId: contract.document_id });
        const version = versions.find(v => v.id === contract.document_version_id) || null;
        const user = await loadUserProfile(req.user.id);
        await insertConsent({ req, contract, request, user, version, kind: 'viewed', consentedAt: ts });
        await logEvent(req, access, { member_contract_id: contract.id, request_id: request.id, user_id: req.user.id, action: 'view_completed' });
      }
    } else if (!contract.first_viewed_at) {
      await logEvent(req, access, { member_contract_id: contract.id, request_id: request.id, user_id: req.user.id, action: 'viewed' });
    }
    const { data: updated, error: uErr } = await supabase.from('member_contracts').update(patch).eq('id', contract.id).select('*').maybeSingle();
    if (uErr) throw dbError(uErr, 'member_contracts');
    res.json({ ok: true, member_contract_id: contract.id, first_viewed_at: updated.first_viewed_at, viewed_completed_at: updated.viewed_completed_at });
  } catch (e) { sendError(res, e); }
});

// 控え（receipt）の組み立て
async function buildReceipt({ request, contracts, consents, ctx, user }) {
  const party = ctx.partyByCode.get(request ? request.party_code : (contracts[0] || {}).party_code) || null;
  const byContract = new Map();
  for (const c of consents || []) {
    if (!byContract.has(c.member_contract_id)) byContract.set(c.member_contract_id, []);
    byContract.get(c.member_contract_id).push(c);
  }
  return {
    request_id: request ? request.id : null,
    signer_name: request ? request.signer_name : null,
    submitted_at: request ? request.submitted_at : null,
    member: user ? { id: user.id, full_name: user.full_name, email: user.email, business_type: user.business_type || null, invoice_name: user.invoice_name || null } : null,
    party: party ? { code: party.code, legal_name: party.legal_name, display_name: party.display_name, representative_title: party.representative_title, representative_name: party.representative_name } : null,
    documents: contracts.map(c => {
      const doc = ctx.docById.get(c.document_id) || {};
      const ver = ctx.verById.get(c.document_version_id) || {};
      const list = (byContract.get(c.id) || []).filter(x => x.consent_kind !== 'viewed');
      const chain = verifyChain(byContract.get(c.id) || []);
      return {
        member_contract_id: c.id,
        title: doc.title || null,
        doc_type: doc.doc_type || null,
        version_no: ver.version_no ?? null,
        version_label: ver.version_label || null,
        effective_from: ver.effective_from || null,
        pdf_sha256: ver.pdf_sha256 || null,
        body_sha256: ver.body_sha256 || null,
        status: c.status,
        contract_date: c.contract_date,
        start_date: c.start_date,
        end_date: c.end_date,
        auto_renew: c.auto_renew,
        approved_at: c.approved_at,
        fill_snapshot: c.fill_snapshot || null,
        consents: list.map(x => ({
          id: x.id, consent_kind: x.consent_kind, signer_name_typed: x.signer_name_typed, signer_name_registered: x.signer_name_registered,
          consented_at: x.consented_at, ip_address: x.ip_address, user_agent: x.user_agent,
          pdf_sha256: x.pdf_sha256, body_sha256: x.body_sha256, prev_record_hash: x.prev_record_hash, record_hash: x.record_hash,
        })),
        viewed_at: (byContract.get(c.id) || []).filter(x => x.consent_kind === 'viewed').map(x => x.consented_at),
        chain_ok: chain.ok,
      };
    }),
    generated_at: nowIso(),
  };
}

// POST /req/:token/submit — 署名者名を入力して送信
router.post('/req/:token/submit', requireAuth, async (req, res) => {
  try {
    const request = await loadOwnRequest(req, req.params.token);
    if (request.status !== 'open') return res.status(400).json({ error: 'この依頼はすでに送信済み（または取消済み）です' });
    const body = req.body || {};
    const signerName = trimOrNull(body.signer_name);
    if (!signerName) return res.status(400).json({ error: '署名者名を入力してください' });
    const agreedIds = new Set(toArray(body.agreed_member_contract_ids));

    const all = await loadRequestContracts(request.id);
    const targets = all.filter(c => state.MEMBER_PENDING_STATUSES.includes(c.status));
    if (targets.length === 0) return res.status(400).json({ error: '送信できる文書がありません' });
    const missingAgree = targets.filter(c => !agreedIds.has(c.id));
    if (missingAgree.length > 0) return res.status(400).json({ error: 'すべての文書に同意してください' });
    const notViewed = targets.filter(c => !c.viewed_completed_at);
    if (notViewed.length > 0) return res.status(400).json({ error: '最後まで閲覧していない文書があります。文書を最後までお読みください' });

    const user = await loadUserProfile(req.user.id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (!state.signerNameMatches(signerName, user.full_name)) {
      return res.status(400).json({ error: '登録氏名と同じ表記で入力してください' });
    }

    const ctx = await buildContext({ reqById: new Map([[request.id, request]]) });
    const party = ctx.partyByCode.get(request.party_code) || null;
    const access = await getAccess(req);
    const ts = nowIso();
    const consents = [];

    for (const c of targets) {
      const doc = ctx.docById.get(c.document_id) || {};
      const ver = ctx.verById.get(c.document_version_id) || null;
      const kind = state.consentKindForDocType(doc.doc_type);
      const fillSnapshot = buildFillValues({ party, user, contract: c, version: ver, request });
      const consent = await insertConsent({ req, contract: c, request, user, version: ver, kind, signerTyped: signerName, fillSnapshot, consentedAt: ts });
      consents.push(consent);
      const { error: uErr } = await supabase.from('member_contracts').update({
        status: 'submitted', submitted_at: ts, signed_at: ts, fill_snapshot: fillSnapshot, updated_at: ts,
      }).eq('id', c.id).eq('user_id', req.user.id);
      if (uErr) throw dbError(uErr, 'member_contracts');
      await logEvent(req, access, {
        member_contract_id: c.id, request_id: request.id, user_id: req.user.id, action: 'submitted',
        from_status: c.status, to_status: 'submitted', detail: { consent_kind: kind, record_hash: consent.record_hash },
      });
      c.status = 'submitted'; c.submitted_at = ts; c.signed_at = ts; c.fill_snapshot = fillSnapshot;
    }
    const { data: updatedReq, error: rErr } = await supabase.from('contract_requests').update({
      status: 'submitted', submitted_at: ts, signer_name: signerName, updated_at: ts,
    }).eq('id', request.id).select('*').maybeSingle();
    if (rErr) throw dbError(rErr, 'contract_requests');

    // 管理者へ「確認待ち」通知（失敗しても本処理は成功扱い）
    try {
      const titles = targets.map(c => (ctx.docById.get(c.document_id) || {}).title).filter(Boolean);
      await notifyAdmins(messages.buildAdminSubmittedMessage({
        memberName: displayNameOf(user) || user.full_name, docTitles: titles,
        partyName: party ? party.display_name : request.party_code, url: adminListUrl(),
      }));
    } catch (e) { console.warn('[contracts] 管理者通知に失敗:', e.message); }

    const receipt = await buildReceipt({ request: updatedReq || request, contracts: targets, consents, ctx, user });
    res.json({ ok: true, request: requestToJson(updatedReq || request, { self: true }), receipt });
  } catch (e) { sendError(res, e); }
});

// GET /member-contracts/:id/receipt — 同意記録の控え（本人 or contract.page）
router.get('/member-contracts/:id/receipt', requireAuth, async (req, res) => {
  try {
    const { data: contract, error } = await supabase.from('member_contracts').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw dbError(error, 'member_contracts');
    if (!contract) return res.status(404).json({ error: '契約が見つかりません' });
    const access = await getAccess(req);
    const isSelf = contract.user_id === req.user.id;
    if (!isSelf && !access.canManage) return res.status(403).json({ error: 'この操作の権限がありません' });
    const [request, consentsRes, user] = await Promise.all([
      contract.request_id ? supabase.from('contract_requests').select('*').eq('id', contract.request_id).maybeSingle().then(r => r.data || null) : Promise.resolve(null),
      supabase.from('contract_consents').select('*').eq('member_contract_id', contract.id).order('consented_at'),
      loadUserProfile(contract.user_id),
    ]);
    if (consentsRes.error) throw dbError(consentsRes.error, 'contract_consents');
    const ctx = await buildContext({ reqById: request ? new Map([[request.id, request]]) : new Map() });
    const receipt = await buildReceipt({ request, contracts: [contract], consents: consentsRes.data || [], ctx, user });
    res.json(receipt);
  } catch (e) { sendError(res, e); }
});

// GET /versions/:id/pdf — PDF ストリーム（本人にその版の契約がある or contract.page）
router.get('/versions/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { data: version, error } = await supabase.from('contract_document_versions').select(VERSION_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (error) throw dbError(error, 'contract_document_versions');
    if (!version) return res.status(404).json({ error: '文書バージョンが見つかりません' });
    if (!version.pdf_drive_file_id) return res.status(404).json({ error: 'この版には PDF 原本が登録されていません' });
    const access = await getAccess(req);
    let ownContractId = null;
    if (!access.canManage) {
      const { data: own } = await supabase.from('member_contracts').select('id')
        .eq('user_id', req.user.id).eq('document_version_id', version.id).limit(1);
      ownContractId = own && own[0] ? own[0].id : null;
      if (!ownContractId) return res.status(403).json({ error: 'この文書を閲覧する権限がありません' });
    }
    const drive = await getHaruka().getDriveService();
    const stream = await drive.files.get({ fileId: version.pdf_drive_file_id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    const name = version.pdf_file_name || `contract_v${version.version_no}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name).replace(/%20/g, ' ')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (version.pdf_size_bytes) res.setHeader('Content-Length', String(version.pdf_size_bytes));
    await logEvent(req, access, {
      member_contract_id: ownContractId, user_id: req.user.id, action: 'pdf_downloaded',
      detail: { document_version_id: version.id, version_no: version.version_no },
    });
    stream.data.on('error', (e) => { console.error('[contracts] PDF stream error:', e.message); if (!res.headersSent) res.status(500).end(); else res.end(); });
    stream.data.pipe(res);
  } catch (e) { sendError(res, e, 'PDF の取得に失敗しました'); }
});

// =============================================================
// 管理者
// =============================================================

const requireView = requireAnyPermission('contract.page', 'contract.view');
const requireManage = requirePermission('contract.page');

// ---------- 契約主体 ----------

router.get('/parties', requireAuth, requireView, async (req, res) => {
  try { res.json(await loadParties()); } catch (e) { sendError(res, e); }
});

router.put('/parties/:code', requireAuth, requireManage, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    for (const k of PARTY_EDITABLE) {
      if (!(k in body)) continue;
      let v = body[k];
      if (k === 'is_active') v = toBool(v, true);
      else if (k === 'sort_order') { v = Number(v); if (!Number.isInteger(v)) return res.status(400).json({ error: 'sort_order は整数で指定してください' }); }
      else if (k === 'effective_from' || k === 'effective_to') { v = trimOrNull(v); if (v && !state.isValidYmd(v)) return res.status(400).json({ error: `${k} は YYYY-MM-DD で指定してください` }); }
      else if (k === 'invoice_registration_number') { const n = normalizeInvoiceRegistrationNumber(v === null ? null : String(v)); if (n && typeof n === 'object' && n.error) return res.status(400).json({ error: n.error }); v = n === undefined ? null : n; }
      else if (k === 'corporate_number') { v = trimOrNull(v); if (v && !/^\d{13}$/.test(v)) return res.status(400).json({ error: '法人番号は数字13桁で指定してください' }); }
      else { v = trimOrNull(v); if ((k === 'legal_name' || k === 'display_name') && !v) return res.status(400).json({ error: `${k} は空にできません` }); }
      update[k] = v;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: '更新項目がありません' });
    update.updated_at = nowIso();
    const { data, error } = await supabase.from('billing_parties').update(update).eq('code', req.params.code).select('*').maybeSingle();
    if (error) throw dbError(error, 'billing_parties');
    if (!data) return res.status(404).json({ error: '契約主体が見つかりません' });
    const access = await getAccess(req);
    await logEvent(req, access, { action: 'party_updated', detail: { party_code: req.params.code, keys: Object.keys(update).filter(k => k !== 'updated_at') } });
    res.json(data);
  } catch (e) { sendError(res, e); }
});

// ---------- 文書・版 ----------

router.get('/documents', requireAuth, requireView, async (req, res) => {
  try {
    const access = await getAccess(req);
    const [documents, versions] = await Promise.all([loadDocuments(), loadVersions({ withBody: access.canManage })]);
    const byDoc = new Map();
    for (const v of versions) {
      if (!byDoc.has(v.document_id)) byDoc.set(v.document_id, []);
      byDoc.get(v.document_id).push({ ...v, has_pdf: !!v.pdf_drive_file_id });
    }
    res.json(documents.map(d => ({ ...d, versions: byDoc.get(d.id) || [], published_version: (byDoc.get(d.id) || []).find(v => v.status === 'published') || null })));
  } catch (e) { sendError(res, e); }
});

router.post('/documents', requireAuth, requireManage, async (req, res) => {
  try {
    const body = req.body || {};
    const doc_type = trimOrNull(body.doc_type);
    const title = trimOrNull(body.title);
    if (!doc_type || !state.DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: `doc_type は ${state.DOC_TYPES.join(' / ')} のいずれかで指定してください` });
    if (!title) return res.status(400).json({ error: 'title は必須です' });
    const party_code = trimOrNull(body.party_code);
    if (party_code) {
      const parties = await loadParties();
      if (!parties.some(p => p.code === party_code)) return res.status(400).json({ error: '契約主体が見つかりません' });
    }
    const row = {
      doc_type, party_code, client_id: trimOrNull(body.client_id), title, description: trimOrNull(body.description),
      sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
      is_active: toBool(body.is_active, true), created_by: req.user.id,
    };
    const { data, error } = await supabase.from('contract_documents').insert(row).select('*').maybeSingle();
    if (error) throw dbError(error, 'contract_documents');
    const access = await getAccess(req);
    await logEvent(req, access, { action: 'document_created', detail: { document_id: data.id, doc_type, title } });
    res.status(201).json({ ...data, versions: [] });
  } catch (e) { sendError(res, e); }
});

// POST /documents/:id/versions — multipart pdf ＋ メタ。Drive「契約書/文書原本」へ upload。status draft
router.post('/documents/:id/versions', requireAuth, requireManage, pdfUpload('pdf'), async (req, res) => {
  try {
    const { data: doc, error: dErr } = await supabase.from('contract_documents').select('*').eq('id', req.params.id).maybeSingle();
    if (dErr) throw dbError(dErr, 'contract_documents');
    if (!doc) return res.status(404).json({ error: '文書が見つかりません' });
    const body = req.body || {};
    const body_html = trimOrNull(body.body_html);
    const file = req.file || null;
    if (!file && !body_html) return res.status(400).json({ error: 'PDF か本文（body_html）のどちらかは必須です' });
    const effective_from = trimOrNull(body.effective_from);
    if (effective_from && !state.isValidYmd(effective_from)) return res.status(400).json({ error: 'effective_from は YYYY-MM-DD で指定してください' });
    const fill_fields = parseJsonField(body.fill_fields, []);
    if (!Array.isArray(fill_fields)) return res.status(400).json({ error: 'fill_fields は配列で指定してください' });

    const existing = await loadVersions({ documentId: doc.id });
    const version_no = existing.reduce((m, v) => Math.max(m, Number(v.version_no) || 0), 0) + 1;
    const version_label = trimOrNull(body.version_label) || `v${version_no}`;

    let pdfMeta = null;
    if (file) {
      const drive = await getHaruka().getDriveService();
      const rootId = await getContractRootFolderId(drive);
      const originalsId = await getHaruka().getOrCreateFolder(drive, rootId, '文書原本');
      const name = safeFileName(`${doc.title}_v${version_no}_${version_label}.pdf`);
      const uploaded = await uploadPdfToDrive(drive, originalsId, name, file.buffer);
      pdfMeta = { pdf_drive_file_id: uploaded.id, pdf_file_name: name, pdf_size_bytes: file.size, pdf_sha256: sha256Hex(file.buffer) };
    }
    const row = {
      document_id: doc.id, version_no, version_label, status: 'draft', effective_from,
      body_html, body_sha256: body_html ? sha256Hex(body_html) : null,
      ...(pdfMeta || {}),
      fill_fields, change_summary: trimOrNull(body.change_summary),
      requires_reconsent: toBool(body.requires_reconsent, true),
      created_by: req.user.id,
    };
    const { data, error } = await supabase.from('contract_document_versions').insert(row).select('*').maybeSingle();
    if (error) throw dbError(error, 'contract_document_versions');
    const access = await getAccess(req);
    await logEvent(req, access, { action: 'version_created', detail: { document_id: doc.id, document_version_id: data.id, version_no, version_label, has_pdf: !!pdfMeta, pdf_sha256: pdfMeta ? pdfMeta.pdf_sha256 : null } });
    res.status(201).json({ ...data, has_pdf: !!data.pdf_drive_file_id });
  } catch (e) { sendError(res, e); }
});

// POST /versions/:id/publish — draft→published。同 document の published→superseded。requires_reconsent なら旧版の active/ending→reconsent_required
router.post('/versions/:id/publish', requireAuth, requireManage, async (req, res) => {
  try {
    const { data: version, error } = await supabase.from('contract_document_versions').select(VERSION_COLUMNS).eq('id', req.params.id).maybeSingle();
    if (error) throw dbError(error, 'contract_document_versions');
    if (!version) return res.status(404).json({ error: '文書バージョンが見つかりません' });
    if (version.status !== 'draft') return res.status(400).json({ error: '下書きの版のみ公開できます' });
    const ts = nowIso();
    const access = await getAccess(req);
    const siblings = await loadVersions({ documentId: version.document_id });
    const prevPublished = siblings.filter(v => v.status === 'published' && v.id !== version.id);
    for (const p of prevPublished) {
      const { error: sErr } = await supabase.from('contract_document_versions').update({ status: 'superseded' }).eq('id', p.id);
      if (sErr) throw dbError(sErr, 'contract_document_versions');
    }
    const { data: published, error: pErr } = await supabase.from('contract_document_versions').update({
      status: 'published', published_at: ts, published_by: req.user.id,
      supersedes_version_id: prevPublished[0] ? prevPublished[0].id : null,
    }).eq('id', version.id).select('*').maybeSingle();
    if (pErr) throw dbError(pErr, 'contract_document_versions');

    let reconsentCount = 0;
    if (published.requires_reconsent) {
      const { data: olds, error: oErr } = await supabase.from('member_contracts').select('id, user_id, status, request_id')
        .eq('document_id', version.document_id).in('status', ['active', 'ending']).neq('document_version_id', version.id);
      if (oErr) throw dbError(oErr, 'member_contracts');
      if (olds && olds.length) {
        const { error: uErr } = await supabase.from('member_contracts').update({ status: 'reconsent_required', updated_at: ts }).in('id', olds.map(o => o.id));
        if (uErr) throw dbError(uErr, 'member_contracts');
        for (const o of olds) {
          await logEvent(req, access, { member_contract_id: o.id, request_id: o.request_id, user_id: o.user_id, action: 'reconsent_requested', from_status: o.status, to_status: 'reconsent_required', detail: { new_version_id: version.id, version_no: version.version_no } });
        }
        reconsentCount = olds.length;
      }
    }
    await logEvent(req, access, { action: 'version_published', detail: { document_id: version.document_id, document_version_id: version.id, version_no: version.version_no, superseded: prevPublished.map(p => p.id), reconsent_required_count: reconsentCount } });
    res.json({ ...published, has_pdf: !!published.pdf_drive_file_id, reconsent_required_count: reconsentCount });
  } catch (e) { sendError(res, e); }
});

// ---------- 依頼 ----------

async function loadUsersMap(userIds) {
  let q = supabase.from('users').select(`${NOTIFY_USER_COLUMNS}, email, role`);
  if (Array.isArray(userIds)) q = q.in('id', userIds);
  const { data, error } = await q;
  if (error) throw dbError(error, 'users');
  return indexBy(data || []);
}

// GET /requests — メンバー単位に集約した一覧（contract.view は限定列）
router.get('/requests', requireAuth, requireView, async (req, res) => {
  try {
    const access = await getAccess(req);
    const { status, party, q, doc, include_all } = req.query || {};
    const [{ data: requests, error: rErr }, { data: contracts, error: cErr }, usersMap] = await Promise.all([
      supabase.from('contract_requests').select('*').order('requested_at', { ascending: false }),
      supabase.from('member_contracts').select('*').order('created_at', { ascending: false }),
      loadUsersMap(null),
    ]);
    if (rErr) throw dbError(rErr, 'contract_requests');
    if (cErr) throw dbError(cErr, 'member_contracts');
    const ctx = await buildContext({ reqById: indexBy(requests || []) });
    const today = state.jstToday();

    const byUser = new Map();
    const ensure = (uid) => {
      if (!byUser.has(uid)) byUser.set(uid, { user: usersMap.get(uid) || { id: uid, full_name: '(不明なメンバー)', nickname: null, is_active: false }, requests: [], contracts: [] });
      return byUser.get(uid);
    };
    for (const r of requests || []) ensure(r.user_id).requests.push(r);
    for (const c of contracts || []) ensure(c.user_id).contracts.push(c);
    if (toBool(include_all, false)) for (const u of usersMap.values()) if (u.is_active !== false) ensure(u.id);

    const rows = [];
    for (const [uid, g] of byUser.entries()) {
      let cs = g.contracts;
      if (party) cs = cs.filter(c => c.party_code === party);
      if (doc) cs = cs.filter(c => c.document_id === doc);
      let rs = g.requests;
      if (party) rs = rs.filter(r => r.party_code === party);
      const latest = rs[0] || null;
      const effective = cs.filter(c => state.EFFECTIVE_STATUSES.includes(c.status));
      const pending = cs.filter(c => state.MEMBER_PENDING_STATUSES.includes(c.status));
      const submitted = cs.filter(c => c.status === 'submitted');
      const reconsent = cs.filter(c => c.status === 'reconsent_required');
      const endDates = effective.map(c => c.end_date).filter(Boolean).sort();
      const nextEnd = endDates[0] || null;
      const daysToEnd = nextEnd ? state.daysBetween(today, nextEnd) : null;
      let summary = 'none';
      if (submitted.length) summary = 'submitted';
      else if (pending.some(c => c.status === 'revision_requested')) summary = 'revision_requested';
      else if (pending.length) summary = 'requested';
      else if (reconsent.length) summary = 'reconsent_required';
      else if (effective.some(c => c.status === 'ending')) summary = 'ending';
      else if (effective.length) summary = 'active';
      else if (cs.some(c => c.status === 'ended')) summary = 'ended';
      else if (cs.some(c => c.status === 'cancelled')) summary = 'cancelled';
      const overdue = !!(latest && latest.status === 'open' && latest.due_date && state.daysBetween(today, latest.due_date) < 0);
      const unattended = !!(latest && latest.status === 'open' && !latest.first_viewed_at && latest.sent_at && (Date.now() - new Date(latest.sent_at).getTime()) >= 3 * 86_400_000);

      if (status && status !== 'all') {
        const matchStatus = status === 'overdue' ? overdue
          : status === 'unattended' ? unattended
            : status === 'expiring' ? (daysToEnd !== null && daysToEnd >= 0 && daysToEnd <= 30)
              : (summary === status || cs.some(c => c.status === status));
        if (!matchStatus) continue;
      }
      if (q) {
        const needle = String(q).toLowerCase();
        const hay = `${g.user.full_name || ''} ${g.user.nickname || ''} ${access.canManage ? (g.user.email || '') : ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const userJson = { id: uid, full_name: g.user.full_name, nickname: g.user.nickname, is_active: g.user.is_active };
      if (access.canManage) {
        userJson.email = g.user.email || null;
        userJson.has_chatwork = /^\d+$/.test(String(g.user.chatwork_dm_id || '').trim()) || /^\d+$/.test(String(g.user.chatwork_direct_room_id || '').trim());
        userJson.has_slack = /^[UW][A-Z0-9]+$/i.test(String(g.user.slack_dm_id || '').trim());
      }
      rows.push({
        user: userJson,
        summary_status: summary,
        latest_request: latest ? requestToJson(latest, { manage: access.canManage }) : null,
        contracts: cs.map(c => contractToJson(c, ctx)),
        effective_count: effective.length,
        pending_count: pending.length + submitted.length,
        reconsent_required: reconsent.length > 0,
        next_end_date: nextEnd,
        days_to_end: daysToEnd,
        overdue,
        unattended,
      });
    }
    rows.sort((a, b) => {
      const order = { submitted: 0, revision_requested: 1, requested: 2, reconsent_required: 3, ending: 4, active: 5, ended: 6, cancelled: 7, none: 8 };
      const d = (order[a.summary_status] ?? 9) - (order[b.summary_status] ?? 9);
      return d !== 0 ? d : String(a.user.full_name || '').localeCompare(String(b.user.full_name || ''), 'ja');
    });
    res.json({ rows, total: rows.length, parties: ctx.parties.map(p => ({ code: p.code, display_name: p.display_name })), documents: ctx.documents.map(d => ({ id: d.id, title: d.title, doc_type: d.doc_type, party_code: d.party_code })) });
  } catch (e) { sendError(res, e); }
});

// 依頼送信（新規・再送・催促で共通）
async function sendRequestToMember({ request, user, party, titles, kind, reason, sentDate }) {
  const url = requestUrl(request.token);
  const displayName = displayNameOf(user);
  let msg;
  if (kind === 'remind') msg = messages.buildReminderMessage({ displayName, sentDate, docTitles: titles, due: request.due_date, url });
  else if (kind === 'revision') msg = messages.buildRevisionMessage({ displayName, reason, url });
  else msg = messages.buildRequestMessage({ displayName, partyName: party ? party.display_name : request.party_code, docTitles: titles, url, due: request.due_date, extraMessage: request.message });
  const result = await notifyMember(user, msg);
  return { ...result, url, text: msg };
}

// POST /requests — 依頼発行（メンバーごとに request ＋ member_contracts）
router.post('/requests', requireAuth, requireManage, async (req, res) => {
  try {
    const body = req.body || {};
    const userIds = Array.from(new Set(toArray(body.user_ids)));
    const versionIds = Array.from(new Set(toArray(body.version_ids)));
    const party_code = trimOrNull(body.party_code);
    if (userIds.length === 0) return res.status(400).json({ error: 'user_ids は必須です' });
    if (versionIds.length === 0) return res.status(400).json({ error: 'version_ids は必須です' });
    if (!party_code) return res.status(400).json({ error: 'party_code は必須です' });
    const due_date = trimOrNull(body.due_date);
    if (due_date && !state.isValidYmd(due_date)) return res.status(400).json({ error: 'due_date は YYYY-MM-DD で指定してください' });
    const start_date = trimOrNull(body.start_date);
    if (start_date && !state.isValidYmd(start_date)) return res.status(400).json({ error: 'start_date は YYYY-MM-DD で指定してください' });
    const auto_renew = toBool(body.auto_renew, true);
    const renew_notice_days = Number.isInteger(Number(body.renew_notice_days)) && Number(body.renew_notice_days) >= 0 ? Number(body.renew_notice_days) : 30;
    const doSend = body.send !== false && String(body.send) !== 'false';
    const message = trimOrNull(body.message);
    const onboarding_record_id = trimOrNull(body.onboarding_record_id);

    const ctx = await buildContext();
    const party = ctx.partyByCode.get(party_code);
    if (!party) return res.status(400).json({ error: '契約主体が見つかりません' });
    const versions = versionIds.map(id => ctx.verById.get(id)).filter(Boolean);
    if (versions.length !== versionIds.length) return res.status(400).json({ error: '存在しない文書バージョンが含まれています' });
    const unpublished = versions.filter(v => v.status !== 'published');
    if (unpublished.length) return res.status(400).json({ error: '公開済みの版のみ依頼できます' });
    const docIds = Array.from(new Set(versions.map(v => v.document_id)));
    if (docIds.length !== versions.length) return res.status(400).json({ error: '同じ文書の版を複数指定することはできません' });
    for (const v of versions) {
      const d = ctx.docById.get(v.document_id);
      if (d && d.party_code && d.party_code !== party_code) return res.status(400).json({ error: `『${d.title}』は ${party_code} の文書ではありません` });
    }

    const usersMap = await loadUsersMap(userIds);
    const missingUsers = userIds.filter(id => !usersMap.has(id));
    if (missingUsers.length) return res.status(400).json({ error: '存在しないメンバーが含まれています' });

    // 既存の open 契約・有効契約をまとめて取得（N+1 回避）
    const { data: existingAll, error: eErr } = await supabase.from('member_contracts').select('*')
      .in('user_id', userIds).in('document_id', docIds);
    if (eErr) throw dbError(eErr, 'member_contracts');
    const openByUser = new Map();
    const effectiveByUserDoc = new Map();
    for (const c of existingAll || []) {
      if (state.OPEN_CONTRACT_STATUSES.includes(c.status)) {
        if (!openByUser.has(c.user_id)) openByUser.set(c.user_id, []);
        openByUser.get(c.user_id).push(c);
      }
      if (state.EFFECTIVE_STATUSES.includes(c.status)) effectiveByUserDoc.set(`${c.user_id}|${c.document_id}`, c);
    }
    const openReqIds = Array.from(new Set(Array.from(openByUser.values()).flat().map(c => c.request_id).filter(Boolean)));
    const openReqById = new Map();
    if (openReqIds.length) {
      const { data: rs } = await supabase.from('contract_requests').select('*').in('id', openReqIds);
      for (const r of rs || []) openReqById.set(r.id, r);
    }

    const access = await getAccess(req);
    const results = [];
    for (const uid of userIds) {
      const user = usersMap.get(uid);
      const openDocs = new Set((openByUser.get(uid) || []).map(c => c.document_id));
      const newVersions = versions.filter(v => !openDocs.has(v.document_id));
      const ts = nowIso();

      // すべて依頼中なら再送扱い（既存 request の URL をもう一度送る）
      if (newVersions.length === 0) {
        const openContracts = openByUser.get(uid) || [];
        const existingReq = openContracts.map(c => openReqById.get(c.request_id)).filter(r => r && r.status === 'open')[0]
          || openContracts.map(c => openReqById.get(c.request_id)).filter(Boolean)[0];
        if (!existingReq) { results.push({ user_id: uid, request_id: null, url: null, sent: false, channel: 'none', resent: false, reason: '依頼中の契約がありますが依頼が見つかりません' }); continue; }
        const titles = openContracts.map(c => (ctx.docById.get(c.document_id) || {}).title).filter(Boolean);
        let sent = { ok: false, channel: 'none', reason: '送信しない指定', url: requestUrl(existingReq.token) };
        if (doSend) {
          sent = await sendRequestToMember({ request: existingReq, user, party, titles, kind: 'request' });
          await supabase.from('contract_requests').update({
            channel: sent.channel, sent_at: sent.ok ? ts : existingReq.sent_at, send_result: { ok: sent.ok, channel: sent.channel, reason: sent.reason, at: ts },
            last_reminded_at: sent.ok ? ts : existingReq.last_reminded_at, updated_at: ts,
          }).eq('id', existingReq.id);
          await logEvent(req, access, { request_id: existingReq.id, user_id: uid, action: 'sent', detail: { channel: sent.channel, ok: sent.ok, resent: true, reason: sent.reason } });
        }
        results.push({ user_id: uid, request_id: existingReq.id, url: sent.url, sent: !!sent.ok, channel: sent.channel, resent: true, reason: sent.reason || null });
        continue;
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const reqRow = {
        user_id: uid, party_code, token, token_expires_at: state.computeTokenExpiry(new Date(), TOKEN_TTL_DAYS),
        due_date, status: 'open', message, onboarding_record_id, requested_by: req.user.id, requested_at: ts,
      };
      const { data: request, error: rErr } = await supabase.from('contract_requests').insert(reqRow).select('*').maybeSingle();
      if (rErr) throw dbError(rErr, 'contract_requests');

      const contractRows = newVersions.map(v => {
        const pred = effectiveByUserDoc.get(`${uid}|${v.document_id}`) || null;
        return {
          user_id: uid, request_id: request.id, document_id: v.document_id, document_version_id: v.id, party_code,
          status: 'requested', execution_method: 'hfs', start_date, auto_renew, renew_notice_days,
          predecessor_contract_id: pred ? pred.id : null, billing_party_code: party_code, created_by: req.user.id,
        };
      });
      const { data: created, error: cErr } = await supabase.from('member_contracts').insert(contractRows).select('*');
      if (cErr) throw dbError(cErr, 'member_contracts');
      for (const c of created || []) {
        await logEvent(req, access, { member_contract_id: c.id, request_id: request.id, user_id: uid, action: 'requested', to_status: 'requested', detail: { document_version_id: c.document_version_id, due_date, party_code, skipped_open_docs: Array.from(openDocs) } });
      }

      const titles = newVersions.map(v => (ctx.docById.get(v.document_id) || {}).title).filter(Boolean);
      let sent = { ok: false, channel: 'none', reason: '送信しない指定', url: requestUrl(token), text: null };
      if (doSend) {
        sent = await sendRequestToMember({ request, user, party, titles, kind: 'request' });
        await supabase.from('contract_requests').update({
          channel: sent.channel, sent_at: sent.ok ? ts : null,
          send_result: { ok: sent.ok, channel: sent.channel, reason: sent.reason, at: ts },
          message: sent.text ? (sent.text.chatwork || sent.text.slack) : message, updated_at: ts,
        }).eq('id', request.id);
        await logEvent(req, access, { request_id: request.id, user_id: uid, action: 'sent', detail: { channel: sent.channel, ok: sent.ok, reason: sent.reason } });
      }
      results.push({ user_id: uid, request_id: request.id, url: sent.url, sent: !!sent.ok, channel: sent.channel, resent: false, reason: sent.reason || null, member_contract_ids: (created || []).map(c => c.id) });
    }
    res.status(201).json(results);
  } catch (e) { sendError(res, e); }
});

async function loadRequestOr404(id) {
  const { data, error } = await supabase.from('contract_requests').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'contract_requests');
  if (!data) throw httpError(404, '依頼が見つかりません');
  return data;
}

// POST /requests/:id/remind — 催促
router.post('/requests/:id/remind', requireAuth, requireManage, async (req, res) => {
  try {
    const request = await loadRequestOr404(req.params.id);
    if (request.status !== 'open') return res.status(400).json({ error: '回答待ちの依頼のみ催促できます' });
    const contracts = (await loadRequestContracts(request.id)).filter(c => state.MEMBER_PENDING_STATUSES.includes(c.status));
    if (contracts.length === 0) return res.status(400).json({ error: '催促対象の文書がありません' });
    const ctx = await buildContext();
    const usersMap = await loadUsersMap([request.user_id]);
    const user = usersMap.get(request.user_id);
    const titles = contracts.map(c => (ctx.docById.get(c.document_id) || {}).title).filter(Boolean);
    const sentDate = state.jstToday(new Date(request.sent_at || request.requested_at));
    const sent = await sendRequestToMember({ request, user, party: ctx.partyByCode.get(request.party_code), titles, kind: 'remind', sentDate });
    const ts = nowIso();
    const access = await getAccess(req);
    if (sent.ok) {
      await supabase.from('contract_requests').update({ last_reminded_at: ts, remind_count: (request.remind_count || 0) + 1, updated_at: ts }).eq('id', request.id);
    }
    await logEvent(req, access, { request_id: request.id, user_id: request.user_id, action: 'reminded', detail: { channel: sent.channel, ok: sent.ok, reason: sent.reason } });
    res.json({ ok: sent.ok, sent: sent.ok, channel: sent.channel, reason: sent.reason || null, remind_count: sent.ok ? (request.remind_count || 0) + 1 : request.remind_count });
  } catch (e) { sendError(res, e); }
});

// POST /requests/:id/cancel — 依頼取消
router.post('/requests/:id/cancel', requireAuth, requireManage, async (req, res) => {
  try {
    const request = await loadRequestOr404(req.params.id);
    if (!['open', 'submitted'].includes(request.status)) return res.status(400).json({ error: 'この依頼は取り消せません' });
    const contracts = (await loadRequestContracts(request.id)).filter(c => state.OPEN_CONTRACT_STATUSES.includes(c.status));
    const ts = nowIso();
    const access = await getAccess(req);
    const reason = trimOrNull((req.body || {}).reason);
    if (contracts.length) {
      const { error } = await supabase.from('member_contracts').update({ status: 'cancelled', updated_at: ts, end_reason: reason || 'cancelled' }).in('id', contracts.map(c => c.id));
      if (error) throw dbError(error, 'member_contracts');
      for (const c of contracts) {
        await logEvent(req, access, { member_contract_id: c.id, request_id: request.id, user_id: request.user_id, action: 'cancelled', from_status: c.status, to_status: 'cancelled', detail: { reason } });
      }
    }
    const { error: rErr } = await supabase.from('contract_requests').update({ status: 'cancelled', cancelled_at: ts, updated_at: ts }).eq('id', request.id);
    if (rErr) throw dbError(rErr, 'contract_requests');
    res.json({ ok: true, cancelled_contract_ids: contracts.map(c => c.id) });
  } catch (e) { sendError(res, e); }
});

// ---------- メンバー契約 ----------

async function loadContractOr404(id) {
  const { data, error } = await supabase.from('member_contracts').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'member_contracts');
  if (!data) throw httpError(404, '契約が見つかりません');
  return data;
}

// GET /member-contracts/:id — 詳細（contract.view は限定列）
router.get('/member-contracts/:id', requireAuth, requireView, async (req, res) => {
  try {
    const access = await getAccess(req);
    const contract = await loadContractOr404(req.params.id);
    const [request, consentsRes, eventsRes, related, user] = await Promise.all([
      contract.request_id ? supabase.from('contract_requests').select('*').eq('id', contract.request_id).maybeSingle().then(r => r.data || null) : Promise.resolve(null),
      supabase.from('contract_consents').select('*').eq('member_contract_id', contract.id).order('consented_at'),
      supabase.from('contract_events').select('*').eq('member_contract_id', contract.id).order('created_at', { ascending: false }).limit(200),
      supabase.from('member_contracts').select('*').eq('user_id', contract.user_id).neq('id', contract.id).order('created_at', { ascending: false }).then(r => r.data || []),
      loadUserProfile(contract.user_id),
    ]);
    if (consentsRes.error) throw dbError(consentsRes.error, 'contract_consents');
    if (eventsRes.error) throw dbError(eventsRes.error, 'contract_events');
    const ctx = await buildContext({ reqById: request ? new Map([[request.id, request]]) : new Map() });
    const consents = consentsRes.data || [];
    const chain = verifyChain(consents);

    const strip = (row) => {
      const { ip_address, user_agent, ...rest } = row; // eslint-disable-line no-unused-vars
      return rest;
    };
    const consentsJson = access.canManage
      ? consents
      : consents.map(c => ({ id: c.id, consent_kind: c.consent_kind, consented_at: c.consented_at, document_version_id: c.document_version_id }));
    const eventsJson = access.canManage ? (eventsRes.data || []) : (eventsRes.data || []).map(strip);

    res.json({
      contract: contractToJson(contract, ctx, { full: access.canManage }),
      request: request ? requestToJson(request, { manage: access.canManage }) : null,
      profile: access.canManage ? profileForAdmin(user) : profileForViewer(user),
      consents: consentsJson,
      chain_ok: chain.ok,
      events: eventsJson,
      related_contracts: related.map(c => contractToJson(c, ctx)),
      can_bank_reveal: access.canBankReveal,
    });
  } catch (e) { sendError(res, e); }
});

// 承認後にオンボーディングの hf_contract を done にする（テーブルが無ければ無視）
async function markOnboardingContractDone(recordId, actorId) {
  if (!recordId) return;
  try {
    const { error } = await supabase.from('onboarding_tasks')
      .update({ done: true, done_at: nowIso(), done_by: actorId })
      .eq('record_id', recordId).eq('task_key', 'hf_contract').eq('done', false);
    if (error) console.warn('[contracts] onboarding hf_contract 更新失敗:', error.message);
  } catch (e) { console.warn('[contracts] onboarding hf_contract 更新失敗:', e.message); }
}

// POST /member-contracts/:id/approve — submitted→active
router.post('/member-contracts/:id/approve', requireAuth, requireManage, async (req, res) => {
  try {
    const contract = await loadContractOr404(req.params.id);
    if (!state.canTransition(contract.status, 'active', 'admin')) return res.status(400).json({ error: `現在の状態（${contract.status}）からは承認できません` });
    const body = req.body || {};
    const today = state.jstToday();
    const contract_date = trimOrNull(body.contract_date) || today;
    if (!state.isValidYmd(contract_date)) return res.status(400).json({ error: 'contract_date は YYYY-MM-DD で指定してください' });
    const start_date = trimOrNull(body.start_date) || contract.start_date || contract_date;
    if (!state.isValidYmd(start_date)) return res.status(400).json({ error: 'start_date は YYYY-MM-DD で指定してください' });
    let end_date = trimOrNull(body.end_date) || contract.end_date || state.defaultEndDate(start_date);
    if (end_date && !state.isValidYmd(end_date)) return res.status(400).json({ error: 'end_date は YYYY-MM-DD で指定してください' });
    const ts = nowIso();
    const access = await getAccess(req);

    // 同 user・同 document の他の有効契約を ended（superseded）にする（部分ユニークのため先に）
    const { data: olds, error: oErr } = await supabase.from('member_contracts').select('id, status, request_id')
      .eq('user_id', contract.user_id).eq('document_id', contract.document_id).neq('id', contract.id)
      .in('status', ['active', 'ending', 'reconsent_required']);
    if (oErr) throw dbError(oErr, 'member_contracts');
    for (const o of olds || []) {
      const { error } = await supabase.from('member_contracts').update({
        status: 'ended', ended_at: ts, ended_by: req.user.id, end_reason: 'superseded', end_date: state.addDays(start_date, -1) || contract_date, updated_at: ts,
      }).eq('id', o.id);
      if (error) throw dbError(error, 'member_contracts');
      await logEvent(req, access, { member_contract_id: o.id, request_id: o.request_id, user_id: contract.user_id, action: 'ended', from_status: o.status, to_status: 'ended', detail: { reason: 'superseded', successor_contract_id: contract.id } });
    }
    const patch = {
      status: 'active', approved_at: ts, approved_by: req.user.id, contract_date, start_date, end_date, updated_at: ts,
      predecessor_contract_id: contract.predecessor_contract_id || (olds && olds[0] ? olds[0].id : null),
    };
    if (trimOrNull(body.note) !== undefined && trimOrNull(body.note) !== null) patch.note = trimOrNull(body.note);
    const { data: updated, error: uErr } = await supabase.from('member_contracts').update(patch).eq('id', contract.id).select('*').maybeSingle();
    if (uErr) throw dbError(uErr, 'member_contracts');
    await logEvent(req, access, { member_contract_id: contract.id, request_id: contract.request_id, user_id: contract.user_id, action: 'approved', from_status: contract.status, to_status: 'active', detail: { contract_date, start_date, end_date, superseded: (olds || []).map(o => o.id) } });

    await refreshRequestStatus(contract.request_id);
    let request = null;
    if (contract.request_id) {
      const { data } = await supabase.from('contract_requests').select('*').eq('id', contract.request_id).maybeSingle();
      request = data || null;
      if (request && request.onboarding_record_id) await markOnboardingContractDone(request.onboarding_record_id, req.user.id);
    }

    // 本人へ承認通知（失敗しても成功扱い）
    let notify = { ok: false, channel: 'none', reason: null };
    try {
      const ctx = await buildContext();
      const usersMap = await loadUsersMap([contract.user_id]);
      const user = usersMap.get(contract.user_id);
      const title = (ctx.docById.get(contract.document_id) || {}).title;
      notify = await notifyMember(user, messages.buildApprovalMessage({ displayName: displayNameOf(user), docTitles: [title].filter(Boolean) }));
      const ctx2 = { ...ctx, reqById: request ? new Map([[request.id, request]]) : new Map() };
      return res.json({ ok: true, contract: contractToJson(updated, ctx2, { full: true }), request: request ? requestToJson(request, { manage: true }) : null, notified: notify.ok, notify_channel: notify.channel, notify_reason: notify.reason });
    } catch (e) {
      console.warn('[contracts] 承認通知に失敗:', e.message);
      return res.json({ ok: true, contract: { ...updated, has_external_pdf: !!updated.external_pdf_drive_file_id }, request: request ? requestToJson(request, { manage: true }) : null, notified: false, notify_channel: 'none', notify_reason: e.message });
    }
  } catch (e) { sendError(res, e); }
});

// POST /member-contracts/:id/revision — 修正依頼（理由必須）
router.post('/member-contracts/:id/revision', requireAuth, requireManage, async (req, res) => {
  try {
    const contract = await loadContractOr404(req.params.id);
    const reason = trimOrNull((req.body || {}).reason);
    if (!reason) return res.status(400).json({ error: '修正依頼の理由を入力してください' });
    if (!state.canTransition(contract.status, 'revision_requested', 'admin')) return res.status(400).json({ error: `現在の状態（${contract.status}）からは修正依頼できません` });
    const ts = nowIso();
    const access = await getAccess(req);
    const { data: updated, error } = await supabase.from('member_contracts').update({
      status: 'revision_requested', revision_requested_at: ts, revision_requested_by: req.user.id, revision_reason: reason, updated_at: ts,
    }).eq('id', contract.id).select('*').maybeSingle();
    if (error) throw dbError(error, 'member_contracts');
    await logEvent(req, access, { member_contract_id: contract.id, request_id: contract.request_id, user_id: contract.user_id, action: 'revision_requested', from_status: contract.status, to_status: 'revision_requested', detail: { reason } });

    let request = null;
    let notify = { ok: false, channel: 'none', reason: '依頼が見つかりません' };
    if (contract.request_id) {
      const { data } = await supabase.from('contract_requests').update({ status: 'open', updated_at: ts }).eq('id', contract.request_id).select('*').maybeSingle();
      request = data || null;
      if (request) {
        const usersMap = await loadUsersMap([contract.user_id]);
        const user = usersMap.get(contract.user_id);
        notify = await sendRequestToMember({ request, user, party: null, titles: [], kind: 'revision', reason });
      }
    }
    const ctx = await buildContext({ reqById: request ? new Map([[request.id, request]]) : new Map() });
    res.json({ ok: true, contract: contractToJson(updated, ctx, { full: true }), notified: notify.ok, notify_channel: notify.channel, notify_reason: notify.reason || null });
  } catch (e) { sendError(res, e); }
});

// POST /member-contracts/:id/end — 終了（end_date 未来なら ending、当日以前なら ended）
router.post('/member-contracts/:id/end', requireAuth, requireManage, async (req, res) => {
  try {
    const contract = await loadContractOr404(req.params.id);
    const body = req.body || {};
    const end_date = trimOrNull(body.end_date) || state.jstToday();
    if (!state.isValidYmd(end_date)) return res.status(400).json({ error: 'end_date は YYYY-MM-DD で指定してください' });
    const reason = trimOrNull(body.reason);
    const today = state.jstToday();
    const toStatus = state.daysBetween(today, end_date) > 0 ? 'ending' : 'ended';
    if (!state.canTransition(contract.status, toStatus, 'admin')) return res.status(400).json({ error: `現在の状態（${contract.status}）からは終了できません` });
    const ts = nowIso();
    const access = await getAccess(req);
    const patch = { status: toStatus, end_date, end_reason: reason, auto_renew: false, updated_at: ts };
    if (toStatus === 'ended') { patch.ended_at = ts; patch.ended_by = req.user.id; }
    const { data: updated, error } = await supabase.from('member_contracts').update(patch).eq('id', contract.id).select('*').maybeSingle();
    if (error) throw dbError(error, 'member_contracts');
    await logEvent(req, access, { member_contract_id: contract.id, request_id: contract.request_id, user_id: contract.user_id, action: toStatus === 'ended' ? 'ended' : 'ending_set', from_status: contract.status, to_status: toStatus, detail: { end_date, reason } });
    const ctx = await buildContext();
    res.json({ ok: true, contract: contractToJson(updated, ctx, { full: true }) });
  } catch (e) { sendError(res, e); }
});

// POST /member-contracts/external — 既存契約（外部締結）の登録。任意 multipart pdf
router.post('/member-contracts/external', requireAuth, requireManage, pdfUpload('pdf'), async (req, res) => {
  try {
    const body = req.body || {};
    const user_id = trimOrNull(body.user_id);
    const party_code = trimOrNull(body.party_code);
    const document_id = trimOrNull(body.document_id);
    const execution_method = trimOrNull(body.execution_method) || 'paper';
    if (!user_id || !party_code || !document_id) return res.status(400).json({ error: 'user_id / party_code / document_id は必須です' });
    if (!state.EXECUTION_METHODS.includes(execution_method)) return res.status(400).json({ error: `execution_method は ${state.EXECUTION_METHODS.join(' / ')} のいずれかです` });
    const contract_date = trimOrNull(body.contract_date);
    const start_date = trimOrNull(body.start_date) || contract_date;
    const end_date = trimOrNull(body.end_date);
    const switch_date = trimOrNull(body.switch_date);
    for (const [k, v] of Object.entries({ contract_date, start_date, end_date, switch_date })) {
      if (v && !state.isValidYmd(v)) return res.status(400).json({ error: `${k} は YYYY-MM-DD で指定してください` });
    }
    const switch_method = trimOrNull(body.switch_method);
    if (switch_method && !['new', 'succession'].includes(switch_method)) return res.status(400).json({ error: 'switch_method は new / succession のいずれかです' });

    const ctx = await buildContext();
    if (!ctx.partyByCode.has(party_code)) return res.status(400).json({ error: '契約主体が見つかりません' });
    const doc = ctx.docById.get(document_id);
    if (!doc) return res.status(400).json({ error: '文書が見つかりません' });
    let version = null;
    const version_id = trimOrNull(body.version_id);
    if (version_id) {
      version = ctx.verById.get(version_id);
      if (!version || version.document_id !== document_id) return res.status(400).json({ error: '文書バージョンが文書と一致しません' });
    } else {
      const vs = ctx.versions.filter(v => v.document_id === document_id);
      version = vs.find(v => v.status === 'published') || vs[0] || null;
      if (!version) return res.status(400).json({ error: 'この文書にはバージョンが登録されていません。先に文書バージョンを登録してください' });
    }
    const usersMap = await loadUsersMap([user_id]);
    const user = usersMap.get(user_id);
    if (!user) return res.status(400).json({ error: 'メンバーが見つかりません' });
    const existing_projects_party = trimOrNull(body.existing_projects_party);
    if (existing_projects_party && !ctx.partyByCode.has(existing_projects_party)) return res.status(400).json({ error: 'existing_projects_party が不正です' });
    const billing_party_code = trimOrNull(body.billing_party_code) || party_code;
    if (!ctx.partyByCode.has(billing_party_code)) return res.status(400).json({ error: 'billing_party_code が不正です' });

    const { data: activeDup, error: aErr } = await supabase.from('member_contracts').select('id').eq('user_id', user_id).eq('document_id', document_id).eq('status', 'active').limit(1);
    if (aErr) throw dbError(aErr, 'member_contracts');
    if (activeDup && activeDup.length) return res.status(409).json({ error: 'このメンバーには同じ文書の有効な契約が既にあります。先に終了してください' });

    let pdfMeta = {};
    if (req.file) {
      const drive = await getHaruka().getDriveService();
      const rootId = await getContractRootFolderId(drive);
      const year = (contract_date || state.jstToday()).slice(0, 4);
      const yearFolder = await getHaruka().getOrCreateFolder(drive, rootId, year);
      const memberFolder = await getHaruka().getOrCreateFolder(drive, yearFolder, safeFileName(user.full_name || user_id));
      const name = safeFileName(`${doc.title}_${user.full_name || ''}_${contract_date || ''}.pdf`);
      const uploaded = await uploadPdfToDrive(drive, memberFolder, name, req.file.buffer);
      pdfMeta = { external_pdf_drive_file_id: uploaded.id, external_pdf_url: `https://drive.google.com/file/d/${uploaded.id}/view` };
    } else if (trimOrNull(body.external_pdf_url)) {
      pdfMeta = { external_pdf_url: trimOrNull(body.external_pdf_url) };
    }
    const ts = nowIso();
    const row = {
      user_id, document_id, document_version_id: version.id, party_code, status: 'active', execution_method,
      ...pdfMeta, external_note: trimOrNull(body.external_note),
      contract_date, start_date, end_date, auto_renew: toBool(body.auto_renew, true),
      renew_notice_days: Number.isInteger(Number(body.renew_notice_days)) ? Number(body.renew_notice_days) : 30,
      switch_method, switch_date, has_existing_projects: body.has_existing_projects === undefined ? null : toBool(body.has_existing_projects, null),
      existing_projects_party, billing_party_code, storage_note: trimOrNull(body.storage_note), note: trimOrNull(body.note),
      approved_at: ts, approved_by: req.user.id, created_by: req.user.id,
    };
    const { data: created, error } = await supabase.from('member_contracts').insert(row).select('*').maybeSingle();
    if (error) throw dbError(error, 'member_contracts');
    const access = await getAccess(req);
    await logEvent(req, access, { member_contract_id: created.id, user_id, action: 'external_registered', to_status: 'active', detail: { execution_method, contract_date, party_code, document_id, has_pdf: !!req.file } });
    res.status(201).json({ ok: true, contract: contractToJson(created, ctx, { full: true }) });
  } catch (e) { sendError(res, e); }
});

// POST /member-contracts/:id/bank-reveal — 口座番号の全桁（contract.bank_reveal・履歴に残す）
router.post('/member-contracts/:id/bank-reveal', requireAuth, requirePermission('contract.bank_reveal'), async (req, res) => {
  try {
    const contract = await loadContractOr404(req.params.id);
    const { data: user, error } = await supabase.from('users')
      .select('id, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana')
      .eq('id', contract.user_id).maybeSingle();
    if (error) throw dbError(error, 'users');
    if (!user) return res.status(404).json({ error: 'メンバーが見つかりません' });
    const access = await getAccess(req);
    await logEvent(req, access, { member_contract_id: contract.id, request_id: contract.request_id, user_id: contract.user_id, action: 'bank_revealed' });
    res.json({
      account_number: user.account_number || null,
      bank_name: user.bank_name || null, bank_code: user.bank_code || null,
      branch_name: user.branch_name || null, branch_code: user.branch_code || null,
      account_type: user.account_type || null, account_holder_kana: user.account_holder_kana || null,
    });
  } catch (e) { sendError(res, e); }
});

// ---------- 操作履歴 ----------

router.get('/events', requireAuth, requireView, async (req, res) => {
  try {
    const access = await getAccess(req);
    const { member_contract_id, user_id, request_id, action } = req.query || {};
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    let q = supabase.from('contract_events').select('*').order('created_at', { ascending: false }).limit(limit);
    if (member_contract_id) q = q.eq('member_contract_id', member_contract_id);
    if (user_id) q = q.eq('user_id', user_id);
    if (request_id) q = q.eq('request_id', request_id);
    if (action) q = q.eq('action', action);
    const { data, error } = await q;
    if (error) throw dbError(error, 'contract_events');
    const rows = access.canManage ? (data || []) : (data || []).map(({ ip_address, user_agent, ...rest }) => rest); // eslint-disable-line no-unused-vars
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// ---------- 設定 ----------

router.get('/settings', requireAuth, requireView, async (req, res) => {
  try { res.json(await loadSettings()); } catch (e) { sendError(res, e); }
});

router.put('/settings', requireAuth, requireManage, async (req, res) => {
  try {
    const body = req.body || {};
    const rows = [];
    for (const key of Object.keys(body)) {
      if (!SETTING_KEYS[key]) return res.status(400).json({ error: `不明な設定キー: ${key}` });
      const r = validateSettingValue(key, body[key]);
      if (r.error) return res.status(400).json({ error: r.error });
      rows.push({ key, value: r.value, updated_at: nowIso() });
    }
    if (rows.length === 0) return res.status(400).json({ error: '更新項目がありません' });
    const { error } = await supabase.from('system_settings').upsert(rows, { onConflict: 'key' });
    if (error) throw dbError(error, 'system_settings');
    const access = await getAccess(req);
    await logEvent(req, access, { action: 'settings_updated', detail: { keys: rows.map(r => r.key) } });
    res.json(await loadSettings());
  } catch (e) { sendError(res, e); }
});

// ワーカー・テストから再利用するヘルパ
router.isMissingContractTable = isMissingContractTable;
router.insertEvent = insertEvent;
router.loadSettings = loadSettings;
router.requestUrl = requestUrl;
router.adminListUrl = adminListUrl;
router.buildProfileUpdate = buildProfileUpdate;
router.validateSettingValue = validateSettingValue;
router.SETTING_KEYS = SETTING_KEYS;
router.MIGRATION_HINT = MIGRATION_HINT;

module.exports = router;

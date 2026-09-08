// workers/contract-reminder.js
// =============================================================
// 契約管理（ADR 035）の期限監視ワーカ。毎日 JST 10時台に1回だけ実行する
//（30分ごとに tick し、JST 10〜18時のうち「その日まだ実行していなければ」実行。
//  onboarding-stall-reminder.js の型）。
//
// 1. 未対応催促: contract_requests.status='open' で last_reminded_at（無ければ sent_at）から
//    contract_remind_interval_days 経過 → 本人へ催促（1日1回）
// 2. 回答期限: due_date の contract_due_notice_days 前と当日 → 本人
// 3. 有効期限: member_contracts active/ending の end_date の 60日前・30日前
//    （expiry_notice_stage で二重送信防止）→ 本人＋管理者
// 4. 更新拒絶期限: auto_renew の end_date − renew_notice_days の 30日前 → 管理者
// 5. 終了日到来: ending → ended（自動更新契約は end_date +1年で active のまま、events に renewed）
// 6. 管理者日次サマリ（Slack DM）
//
// テーブル未作成（migration 未適用）のときは静かにスキップして他機能を巻き込まない。
// ログに口座・住所・電話・IP は出さない。
// =============================================================

const supabase = require('../supabase');
const state = require('../utils/contract-state');
const messages = require('../utils/contract-messages');
const { notifyMember, notifyAdmins, NOTIFY_USER_COLUMNS } = require('../utils/member-notify');

const TICK_MS = 30 * 60_000; // 30分
const RUN_HOUR_FROM = 10;    // JST 10時から
const RUN_HOUR_TO = 18;      // JST 18時台まで
const UNATTENDED_DAYS = 3;   // 日次サマリ「未対応（3日以上未閲覧）」

let intervalHandle = null;
let isRunning = false;
let lastRunDay = null; // JST 'YYYY-MM-DD'

// ---------- 純関数（テスト対象） ----------

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** その日まだ実行していなくて、JST の実行時間帯なら true */
function shouldRunNow({ now = new Date(), lastRunDay: last }) {
  const hour = jstHour(now);
  if (hour < RUN_HOUR_FROM || hour > RUN_HOUR_TO) return false;
  return state.jstToday(now) !== last;
}

/** 同じ JST 日付にすでに催促済みか（1日1回ガード） */
function remindedToday(lastRemindedAt, now = new Date()) {
  if (!lastRemindedAt) return false;
  return state.jstToday(new Date(lastRemindedAt)) === state.jstToday(now);
}

// ---------- ワーカ本体 ----------

function requestUrl(token) {
  return require('../routes/contracts').requestUrl(token);
}
function adminListUrl() {
  return require('../routes/contracts').adminListUrl();
}
function isMissingTable(err) {
  return require('../routes/contracts').isMissingContractTable(err);
}
async function insertEvent(row) {
  return require('../routes/contracts').insertEvent({ actor_name: 'system', actor_role: 'system', ...row });
}
async function loadSettings() {
  return require('../routes/contracts').loadSettings();
}

async function loadContext() {
  const [parties, documents, users] = await Promise.all([
    supabase.from('billing_parties').select('code, display_name, legal_name'),
    supabase.from('contract_documents').select('id, title, doc_type'),
    supabase.from('users').select(NOTIFY_USER_COLUMNS),
  ]);
  for (const r of [parties, documents, users]) if (r.error) throw r.error;
  return {
    partyByCode: new Map((parties.data || []).map(p => [p.code, p])),
    docById: new Map((documents.data || []).map(d => [d.id, d])),
    userById: new Map((users.data || []).map(u => [u.id, u])),
  };
}

// 1・2. 未対応催促 / 回答期限
async function processOpenRequests({ ctx, settings, today, nowMs }) {
  const { data: requests, error } = await supabase.from('contract_requests').select('*').eq('status', 'open');
  if (error) throw error;
  if (!requests || requests.length === 0) return { reminded: 0, due: 0 };
  const { data: contracts, error: cErr } = await supabase.from('member_contracts')
    .select('id, request_id, document_id, status').in('request_id', requests.map(r => r.id));
  if (cErr) throw cErr;
  const byReq = new Map();
  for (const c of contracts || []) {
    if (!state.MEMBER_PENDING_STATUSES.includes(c.status)) continue;
    if (!byReq.has(c.request_id)) byReq.set(c.request_id, []);
    byReq.get(c.request_id).push(c);
  }
  let reminded = 0; let due = 0;
  for (const r of requests) {
    const pending = byReq.get(r.id) || [];
    if (pending.length === 0) continue;
    const user = ctx.userById.get(r.user_id);
    if (!user || user.is_active === false) continue;
    if (remindedToday(r.last_reminded_at)) continue;
    const titles = pending.map(c => (ctx.docById.get(c.document_id) || {}).title).filter(Boolean);
    const url = requestUrl(r.token);
    const displayName = user.nickname || user.full_name;

    // 2. 回答期限（前・当日）は催促より優先して専用文面で送る
    const dueKind = r.due_date ? state.dueNoticeKind({ dueDate: r.due_date, today, noticeDays: settings.contract_due_notice_days }) : null;
    let msg = null; let action = null;
    if (dueKind === 'before' || dueKind === 'due') {
      msg = messages.buildDueNoticeMessage({ displayName, docTitles: titles, due: r.due_date, kind: dueKind, url });
      action = 'due_notified';
    } else if (state.needsReminder({ nowMs, lastRemindedAt: r.last_reminded_at, sentAt: r.sent_at, requestedAt: r.requested_at, intervalDays: settings.contract_remind_interval_days })) {
      msg = messages.buildReminderMessage({ displayName, sentDate: state.jstToday(new Date(r.sent_at || r.requested_at)), docTitles: titles, due: r.due_date, url });
      action = 'reminded';
    }
    if (!msg) continue;
    const sent = await notifyMember(user, msg);
    const ts = new Date().toISOString();
    if (sent.ok) {
      await supabase.from('contract_requests').update({ last_reminded_at: ts, remind_count: (r.remind_count || 0) + 1, updated_at: ts }).eq('id', r.id);
      if (action === 'reminded') reminded++; else due++;
    }
    await insertEvent({ request_id: r.id, user_id: r.user_id, action, detail: { channel: sent.channel, ok: sent.ok, reason: sent.reason, due_kind: dueKind, worker: true } });
  }
  return { reminded, due };
}

// 3・4・5. 有効期限 / 更新拒絶期限 / 終了日到来
async function processContractTerms({ ctx, settings, today }) {
  const { data: contracts, error } = await supabase.from('member_contracts')
    .select('id, user_id, request_id, document_id, party_code, status, contract_date, end_date, auto_renew, renew_notice_days, expiry_notice_stage')
    .in('status', ['active', 'ending', 'reconsent_required']).not('end_date', 'is', null);
  if (error) throw error;
  const stages = String(settings.contract_expiry_notice_days || '60,30').split(',').map(Number).filter(n => Number.isFinite(n));
  const out = { expiry: 0, renew: 0, ended: 0, renewed: 0 };
  for (const c of contracts || []) {
    const user = ctx.userById.get(c.user_id);
    const doc = ctx.docById.get(c.document_id) || {};
    const party = ctx.partyByCode.get(c.party_code) || {};
    const memberName = user ? (user.nickname || user.full_name) : '(不明なメンバー)';

    // 5. 終了日到来
    const act = state.endDateAction({ status: c.status, endDate: c.end_date, today, autoRenew: c.auto_renew });
    const ts = new Date().toISOString();
    if (act === 'end') {
      const { error: uErr } = await supabase.from('member_contracts').update({ status: 'ended', ended_at: ts, end_reason: c.status === 'ending' ? (c.end_reason || 'term_ended') : 'expired', updated_at: ts }).eq('id', c.id);
      if (!uErr) {
        out.ended++;
        await insertEvent({ member_contract_id: c.id, request_id: c.request_id, user_id: c.user_id, action: 'ended', from_status: c.status, to_status: 'ended', detail: { end_date: c.end_date, worker: true } });
      }
      continue;
    }
    if (act === 'renew') {
      const newEnd = state.addYears(c.end_date, 1);
      const { error: uErr } = await supabase.from('member_contracts').update({ end_date: newEnd, expiry_notice_stage: null, last_expiry_notified_at: null, updated_at: ts }).eq('id', c.id);
      if (!uErr) {
        out.renewed++;
        await insertEvent({ member_contract_id: c.id, request_id: c.request_id, user_id: c.user_id, action: 'renewed', from_status: c.status, to_status: c.status, detail: { previous_end_date: c.end_date, end_date: newEnd, worker: true } });
      }
      continue;
    }

    const sentStages = state.parseStages(c.expiry_notice_stage);
    let changed = false;

    // 3. 有効期限（本人＋管理者）
    const stage = state.nextExpiryStage({ endDate: c.end_date, today, sentStages, stages });
    if (stage) {
      const daysLeft = state.daysBetween(today, c.end_date);
      const renewDeadline = c.auto_renew ? state.renewDeadline(c.end_date, c.renew_notice_days) : null;
      let memberSent = { ok: false, channel: 'none', reason: 'メンバー不明' };
      if (user && user.is_active !== false) {
        memberSent = await notifyMember(user, messages.buildExpiryMessage({
          displayName: memberName, docTitle: doc.title || '契約書', partyName: party.display_name || c.party_code,
          contractDate: c.contract_date, endDate: c.end_date, renewDeadline, autoRenew: !!c.auto_renew,
        }));
      }
      await notifyAdmins(messages.buildAdminExpiryMessage({
        memberName, docTitle: doc.title || '契約書', partyName: party.display_name || c.party_code,
        endDate: c.end_date, daysLeft, autoRenew: !!c.auto_renew, url: adminListUrl(),
      }));
      sentStages.add(stage); changed = true; out.expiry++;
      await insertEvent({ member_contract_id: c.id, request_id: c.request_id, user_id: c.user_id, action: 'expiry_notified', detail: { stage, end_date: c.end_date, channel: memberSent.channel, ok: memberSent.ok, reason: memberSent.reason, worker: true } });
    }

    // 4. 更新拒絶期限（管理者のみ）
    if (c.auto_renew && state.needsRenewNotice({ endDate: c.end_date, today, renewNoticeDays: c.renew_notice_days, sentStages, adminLeadDays: settings.contract_renewal_notice_days })) {
      await notifyAdmins(messages.buildAdminRenewNoticeMessage({
        memberName, docTitle: doc.title || '契約書', partyName: party.display_name || c.party_code,
        endDate: c.end_date, renewDeadline: state.renewDeadline(c.end_date, c.renew_notice_days), url: adminListUrl(),
      }));
      sentStages.add('renew'); changed = true; out.renew++;
      await insertEvent({ member_contract_id: c.id, request_id: c.request_id, user_id: c.user_id, action: 'renew_notice_sent', detail: { end_date: c.end_date, renew_notice_days: c.renew_notice_days, worker: true } });
    }

    if (changed) {
      await supabase.from('member_contracts').update({ expiry_notice_stage: state.joinStages(sentStages), last_expiry_notified_at: ts, updated_at: ts }).eq('id', c.id);
    }
  }
  return out;
}

// 6. 管理者日次サマリ
async function sendAdminSummary({ ctx, settings, today, nowMs }) {
  const [{ data: requests, error: rErr }, { data: contracts, error: cErr }] = await Promise.all([
    supabase.from('contract_requests').select('id, user_id, status, due_date, sent_at, first_viewed_at').eq('status', 'open'),
    supabase.from('member_contracts').select('id, user_id, status, end_date').in('status', ['submitted', 'active', 'ending', 'reconsent_required']),
  ]);
  if (rErr) throw rErr;
  if (cErr) throw cErr;
  const nameOf = (uid) => { const u = ctx.userById.get(uid); return u ? (u.nickname || u.full_name) : '(不明)'; };
  const items = { awaiting: [], unattended: [], overdue: [], expiring: [], reconsent: [] };
  for (const c of contracts || []) {
    if (c.status === 'submitted') items.awaiting.push(nameOf(c.user_id));
    if (c.status === 'reconsent_required') items.reconsent.push(nameOf(c.user_id));
    if ((c.status === 'active' || c.status === 'ending') && c.end_date) {
      const d = state.daysBetween(today, c.end_date);
      if (d !== null && d >= 0 && d <= 30) items.expiring.push(nameOf(c.user_id));
    }
  }
  for (const r of requests || []) {
    if (!r.first_viewed_at && r.sent_at && nowMs - new Date(r.sent_at).getTime() >= UNATTENDED_DAYS * 86_400_000) items.unattended.push(nameOf(r.user_id));
    if (r.due_date && state.daysBetween(today, r.due_date) < 0) items.overdue.push(nameOf(r.user_id));
  }
  const counts = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total === 0) return { sent: false, counts };
  const msg = messages.buildAdminSummaryMessage({ date: today, counts, items, listUrl: adminListUrl() });
  const ids = String(settings.contract_admin_summary_slack_user_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const results = ids.length ? await notifyAdmins(msg, { slackUserIds: ids }) : await notifyAdmins(msg);
  return { sent: results.some(r => r.ok), counts };
}

async function runOnce(now = new Date()) {
  const today = state.jstToday(now);
  const nowMs = now.getTime();
  const settings = await loadSettings();
  const ctx = await loadContext();
  const a = await processOpenRequests({ ctx, settings, today, nowMs });
  const b = await processContractTerms({ ctx, settings, today });
  const c = await sendAdminSummary({ ctx, settings, today, nowMs });
  console.log(`[contract-reminder] ${today} 催促${a.reminded} 期限案内${a.due} 有効期限${b.expiry} 更新拒絶${b.renew} 終了${b.ended} 自動更新${b.renewed} サマリ${c.sent ? '送信' : 'なし'}`);
  return { ...a, ...b, summary: c };
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    if (!shouldRunNow({ now, lastRunDay })) return;
    lastRunDay = state.jstToday(now);
    await runOnce(now);
  } catch (e) {
    if (isMissingTable(e)) {
      // migration 未適用: 静かにスキップ（翌日また判定）
      console.warn('[contract-reminder] 契約管理テーブル未作成のためスキップ');
    } else {
      console.error('[contract-reminder] tick 失敗:', e.message);
    }
  } finally {
    isRunning = false;
  }
}

function startContractReminder() {
  if (intervalHandle) return;
  console.log(`[contract-reminder] 起動（${TICK_MS}ms 周期・JST ${RUN_HOUR_FROM}時台に日次実行）`);
  tick().catch(e => console.error('[contract-reminder] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[contract-reminder] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopContractReminder() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[contract-reminder] 停止しました');
  }
}

module.exports = {
  startContractReminder,
  stopContractReminder,
  // テスト・手動実行用
  runOnce,
  shouldRunNow,
  remindedToday,
  jstHour,
  RUN_HOUR_FROM,
  RUN_HOUR_TO,
  UNATTENDED_DAYS,
};

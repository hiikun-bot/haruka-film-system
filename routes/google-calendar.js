// routes/google-calendar.js — Google Calendar OAuth フロー & 動作確認 API（ADR 017 Phase 0）
//
// エンドポイント:
//   GET  /api/auth/google-calendar/start       認可 URL へリダイレクト
//   GET  /api/auth/google-calendar/callback    認可コード交換 -> refresh_token を暗号化保存
//   POST /api/auth/google-calendar/disconnect  本人の接続を切断
//   GET  /api/availability/preview-events      本人の予定を JSON で返す（動作確認用）
//
// セキュリティ:
//   - state は HMAC-SHA256 で署名し、userId + nonce + 有効期限を埋め込む
//   - 本人以外の操作は不可（disconnect / preview-events）
//   - refresh_token は AES-256-GCM で暗号化して保管（utils/crypto-aes.js）
//
// 設計判断:
//   - Phase 0 は本人のみ。VIEW AS（ADR 015）対応は Phase 1 で集約ページを作る時に判定ロジックを足す
//   - GCal トークン失効時は gcal_last_error にエラー文字列を残し、UI 側に再接続を促せるようにする

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const supabase = require('../supabase');
const { requireAuth, requirePermission, userHasPermission, getEffectiveRoleCodes } = require('../auth');
const cryptoAes = require('../utils/crypto-aes');
const gcal = require('../lib/google-calendar');
const wh = require('../lib/working-hours');

// 「現在の req（VIEW AS 含む）が指定 permission key を持つか」を判定する。
// auth.js#userHasPermission は code 単体のため、effective roles の OR を取る。
async function reqHasPermission(req, key) {
  try {
    const codes = await getEffectiveRoleCodes(req);
    for (const c of codes) {
      if (await userHasPermission(c, key)) return true;
    }
  } catch (_) { /* fall through */ }
  return false;
}

// 「現在の req（VIEW AS 含む）の実効ユーザーが leader_rank='leader' として登録されている
//  基本チーム」の id 集合 と そのメンバー user_id 集合 を返す。
//   - 基本チーム判定: team_code が単一英字 A〜Z（grid と同じ規約）
async function fetchLeaderScope(viewerUserId) {
  const out = { teamIds: new Set(), memberUserIds: new Set() };
  if (!viewerUserId) return out;
  // 自分が leader として所属するチーム
  const { data: leaderRows, error: lErr } = await supabase
    .from('team_members')
    .select('team_id, teams!inner(id, team_code, is_active)')
    .eq('user_id', viewerUserId)
    .eq('leader_rank', 'leader');
  if (lErr || !Array.isArray(leaderRows)) return out;
  const basicTeamIds = [];
  for (const r of leaderRows) {
    const t = r.teams;
    if (!t || t.is_active === false) continue;
    const code = String(t.team_code || '');
    if (!/^[A-Za-z]$/.test(code)) continue;
    basicTeamIds.push(t.id);
    out.teamIds.add(t.id);
  }
  if (!basicTeamIds.length) return out;
  // それらチームに所属する全 user_id
  const { data: members, error: mErr } = await supabase
    .from('team_members')
    .select('team_id, user_id')
    .in('team_id', basicTeamIds);
  if (mErr || !Array.isArray(members)) return out;
  for (const m of members) {
    if (m.user_id) out.memberUserIds.add(m.user_id);
  }
  return out;
}

// state 署名鍵: SESSION_SECRET を流用（既に env で必須化されている）
function getStateSecret() {
  return process.env.SESSION_SECRET || 'dev-fallback-state-secret-do-not-use-in-prod';
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 分

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [body, sig] = state.split('.', 2);
  const expected = crypto.createHmac('sha256', getStateSecret()).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// ============================================================
// GET /api/auth/google-calendar/start
// ============================================================
router.get('/start', requireAuth, (req, res) => {
  try {
    if (!cryptoAes.isConfigured()) {
      return res.status(500).send('GCAL_TOKEN_ENCRYPTION_KEY が未設定です。サーバー管理者に連絡してください。');
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const state = signState({
      uid: req.user.id,
      nonce,
      exp: Date.now() + STATE_TTL_MS,
    });
    const authUrl = gcal.buildAuthUrl({ state });
    return res.redirect(authUrl);
  } catch (e) {
    console.error('[gcal/start] failed:', e.message);
    return res.status(500).send(`Google Calendar 認可開始に失敗しました: ${e.message}`);
  }
});

// ============================================================
// GET /api/auth/google-calendar/callback
// ============================================================
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Google 認可がキャンセル/失敗しました: ${error}`);
  }
  if (!code || !state) {
    return res.status(400).send('code または state が欠けています');
  }
  const payload = verifyState(String(state));
  if (!payload) {
    return res.status(400).send('state の検証に失敗しました（期限切れ / 署名不一致）');
  }
  // 別ユーザーがコールバックURLを踏んだ場合は本人に紐付け直さないこと
  if (payload.uid !== req.user.id) {
    return res.status(403).send('認可フローを開始したユーザーと現在ログイン中のユーザーが一致しません。再度お試しください。');
  }

  try {
    const tokens = await gcal.exchangeCodeForTokens(String(code));
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      // 同じ Google アカウントで以前許諾済みかつ revoke せずに再接続した場合、
      // refresh_token が返らないことがある。prompt=consent で原則回避しているが念のため明示エラー。
      return res.status(400).send('refresh_token が取得できませんでした。Google アカウント側で当アプリのアクセス権を一度解除してから再接続してください。');
    }

    // 接続中アカウントの email を取得
    let accountEmail = null;
    try {
      accountEmail = await gcal.fetchAccountEmail(refreshToken);
    } catch (e) {
      console.warn('[gcal/callback] fetchAccountEmail failed (continuing):', e.message);
    }

    const enc = cryptoAes.encrypt(refreshToken);

    // upsert: 既存行があれば update、無ければ insert
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .from('member_working_hours_profile')
      .upsert({
        user_id: req.user.id,
        gcal_connected: true,
        gcal_account_email: accountEmail,
        gcal_calendar_id: 'primary',
        gcal_refresh_token_encrypted: enc.ciphertext,
        gcal_token_iv: enc.iv,
        gcal_token_auth_tag: enc.authTag,
        gcal_last_synced_at: nowIso,
        gcal_last_error: null,
        updated_at: nowIso,
      }, { onConflict: 'user_id' });
    if (upsertErr) {
      console.error('[gcal/callback] upsert failed:', upsertErr.message);
      return res.status(500).send(`接続情報の保存に失敗しました: ${upsertErr.message}`);
    }

    // 動作確認ページに戻る
    return res.redirect('/availability-setup.html?connected=1');
  } catch (e) {
    console.error('[gcal/callback] failed:', e.message);
    return res.status(500).send(`Google Calendar 接続に失敗しました: ${e.message}`);
  }
});

// ============================================================
// POST /api/auth/google-calendar/disconnect
// ============================================================
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .from('member_working_hours_profile')
      .upsert({
        user_id: req.user.id,
        gcal_connected: false,
        gcal_account_email: null,
        gcal_refresh_token_encrypted: null,
        gcal_token_iv: null,
        gcal_token_auth_tag: null,
        gcal_last_error: null,
        updated_at: nowIso,
      }, { onConflict: 'user_id' });
    if (upErr) {
      return res.status(500).json({ error: upErr.message });
    }
    // Phase 0: Google 側の revoke はベストエフォート未実装。失効ボタンを押した時点で
    //         DB から消えるので、当アプリからは GCal にアクセスできなくなる。
    return res.json({ ok: true });
  } catch (e) {
    console.error('[gcal/disconnect] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/availability/preview-events
//   クエリ: ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   省略時: 今日 00:00 〜 +7 日 23:59
// ============================================================
router.get('/preview-events', requireAuth, async (req, res) => {
  try {
    const { data: profile, error: pErr } = await supabase
      .from('member_working_hours_profile')
      .select('gcal_connected, gcal_account_email, gcal_calendar_id, gcal_refresh_token_encrypted, gcal_token_iv, gcal_token_auth_tag')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!profile || !profile.gcal_connected || !profile.gcal_refresh_token_encrypted) {
      return res.status(400).json({ error: 'Google Calendar が未接続です' });
    }

    let refreshToken;
    try {
      refreshToken = cryptoAes.decrypt({
        ciphertext: profile.gcal_refresh_token_encrypted,
        iv: profile.gcal_token_iv,
        authTag: profile.gcal_token_auth_tag,
      });
    } catch (e) {
      return res.status(500).json({ error: 'トークン復号に失敗しました（暗号鍵が変わった可能性）: ' + e.message });
    }

    // 日付パース
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fromStr = String(req.query.from || '').trim();
    const toStr = String(req.query.to || '').trim();
    const from = fromStr ? new Date(fromStr + 'T00:00:00') : today;
    const toBase = toStr ? new Date(toStr + 'T00:00:00') : new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    // to は当日 23:59:59 まで含めたい
    const to = new Date(toBase.getTime() + 24 * 60 * 60 * 1000 - 1000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: 'from / to の日付が不正です（YYYY-MM-DD 形式）' });
    }

    try {
      const events = await gcal.fetchEventsForRange({
        refreshToken,
        calendarId: profile.gcal_calendar_id || 'primary',
        from,
        to,
      });
      // 成功時は last_synced_at を更新（best effort）
      supabase.from('member_working_hours_profile')
        .update({ gcal_last_synced_at: new Date().toISOString(), gcal_last_error: null })
        .eq('user_id', req.user.id)
        .then(() => {});
      return res.json({
        account_email: profile.gcal_account_email,
        calendar_id: profile.gcal_calendar_id || 'primary',
        from: from.toISOString(),
        to: to.toISOString(),
        event_count: events.length,
        events,
      });
    } catch (e) {
      // 失効・レート制限・その他 — gcal_last_error にメモして UI に返す
      supabase.from('member_working_hours_profile')
        .update({ gcal_last_error: `${e.name || 'Error'}: ${e.message}` })
        .eq('user_id', req.user.id)
        .then(() => {});
      if (e.name === 'GCalAuthError') {
        return res.status(401).json({ error: e.message, code: 'gcal_auth_error' });
      }
      if (e.name === 'GCalRateLimitError') {
        return res.status(429).json({ error: e.message, code: 'gcal_rate_limit' });
      }
      return res.status(500).json({ error: e.message });
    }
  } catch (e) {
    console.error('[gcal/preview-events] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/availability/connection-status
//   フロント用に「自分が接続済みか」だけ軽量に返す
// ============================================================
router.get('/connection-status', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('member_working_hours_profile')
      .select('gcal_connected, gcal_account_email, gcal_last_synced_at, gcal_last_error')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      connected: !!(data && data.gcal_connected),
      account_email: data?.gcal_account_email || null,
      last_synced_at: data?.gcal_last_synced_at || null,
      last_error: data?.gcal_last_error || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 共通: 日付ループ
// ============================================================
function eachDate(fromStr, toStr) {
  const out = [];
  const from = new Date(String(fromStr) + 'T00:00:00');
  const to   = new Date(String(toStr)   + 'T00:00:00');
  for (let d = new Date(from); d.getTime() <= to.getTime(); d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDaysStr(s, n) {
  const d = new Date(String(s) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
// POST /api/availability/sync-self
//   body: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
//   省略時: 今日 〜 +60 日
//
// 認証済みの本人の GCal を取得 → 日次稼働時間を算出 →
//   member_working_hours_daily に upsert する。
//
// 仕様:
//   - manual_override=true の行はスキップ（ADR 017 §1.4）
//   - 過去日（昨日以前）は再計算しない（ADR 017 §5.3）
//   - 🔒 保存するのは時間情報 (computed_slots, gcal_raw_slots) のみ
// ============================================================
router.post('/sync-self', requireAuth, requirePermission('availability:sync-own'), async (req, res) => {
  try {
    const userId = req.user.id;
    const from = String(req.body?.from || todayStr());
    const to   = String(req.body?.to   || addDaysStr(todayStr(), 60));

    // user の基本稼働時間 / GCal プロフィール取得
    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('id, weekday_hours, weekend_hours, holiday_weekdays')
      .eq('id', userId)
      .maybeSingle();
    if (uErr) return res.status(500).json({ error: uErr.message });
    if (!user) return res.status(404).json({ error: 'user not found' });

    const { data: profile, error: pErr } = await supabase
      .from('member_working_hours_profile')
      .select('gcal_connected, gcal_calendar_id, gcal_refresh_token_encrypted, gcal_token_iv, gcal_token_auth_tag')
      .eq('user_id', userId)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!profile || !profile.gcal_connected || !profile.gcal_refresh_token_encrypted) {
      return res.status(400).json({ error: 'Google Calendar が未接続です' });
    }

    let refreshToken;
    try {
      refreshToken = cryptoAes.decrypt({
        ciphertext: profile.gcal_refresh_token_encrypted,
        iv: profile.gcal_token_iv,
        authTag: profile.gcal_token_auth_tag,
      });
    } catch (e) {
      return res.status(500).json({ error: 'トークン復号に失敗しました: ' + e.message });
    }

    // GCal イベント取得（範囲全体を1回で取る）
    let events;
    try {
      events = await gcal.fetchEventsForRange({
        refreshToken,
        calendarId: profile.gcal_calendar_id || 'primary',
        from: new Date(from + 'T00:00:00'),
        to:   new Date(to   + 'T23:59:59'),
      });
    } catch (e) {
      supabase.from('member_working_hours_profile')
        .update({ gcal_last_error: `${e.name || 'Error'}: ${e.message}` })
        .eq('user_id', userId).then(() => {});
      if (e.name === 'GCalAuthError')      return res.status(401).json({ error: e.message, code: 'gcal_auth_error' });
      if (e.name === 'GCalRateLimitError') return res.status(429).json({ error: e.message, code: 'gcal_rate_limit' });
      return res.status(500).json({ error: e.message });
    }

    // 既存の manual_override 行を取得（スキップ判定用）
    const dateList = eachDate(from, to);
    const { data: existing, error: exErr } = await supabase
      .from('member_working_hours_daily')
      .select('date, manual_override')
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to);
    if (exErr) return res.status(500).json({ error: exErr.message });
    const manualSet = new Set((existing || []).filter(r => r.manual_override).map(r => String(r.date)));

    const today = todayStr();
    const nowIso = new Date().toISOString();
    const rows = [];
    let skippedManual = 0, skippedPast = 0;

    for (const dateStr of dateList) {
      // 過去日（昨日以前）はスキップ — スナップショット保持
      if (dateStr < today) { skippedPast++; continue; }
      // 手動オーバーライド済みはスキップ
      if (manualSet.has(dateStr)) { skippedManual++; continue; }

      const base = wh.getBaseSlotsForDate(user, dateStr);
      const sub  = wh.subtractEvents(base.slots, events, { dateStr });

      // gcal_raw_slots: 該当日のイベント時間情報のみ抜粋
      const rawSlots = [];
      for (const ev of events) {
        if (!ev || ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
        const startStr = (typeof ev.start === 'string') ? ev.start : '';
        const endStr   = (typeof ev.end === 'string') ? ev.end : '';
        // 該当日に重なるか軽くフィルタ
        if (startStr.slice(0,10) <= dateStr && (endStr.slice(0,10) >= dateStr || endStr === '')) {
          rawSlots.push({ start: startStr, end: endStr, isAllDay: !!ev.isAllDay });
        }
      }

      rows.push({
        user_id: userId,
        date: dateStr,
        computed_slots: sub.slots,
        computed_hours: sub.hours,
        gcal_raw_slots: rawSlots,
        gcal_synced_at: nowIso,
        // manual_override は触らない（既存値が無ければ default false）
      });
    }

    let upsertCount = 0;
    if (rows.length) {
      // 分割 upsert（一度に大量だと負荷大）
      const CHUNK = 100;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { error: upErr } = await supabase
          .from('member_working_hours_daily')
          .upsert(chunk, { onConflict: 'user_id,date' });
        if (upErr) return res.status(500).json({ error: 'upsert failed: ' + upErr.message });
        upsertCount += chunk.length;
      }
    }

    // 同期完了マーク
    supabase.from('member_working_hours_profile')
      .update({ gcal_last_synced_at: nowIso, gcal_last_error: null })
      .eq('user_id', userId).then(() => {});

    return res.json({
      ok: true,
      from, to,
      upserted: upsertCount,
      skipped_manual: skippedManual,
      skipped_past: skippedPast,
      event_count: events.length,
    });
  } catch (e) {
    console.error('[sync-self] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ============================================================
// GET /api/availability/grid?from=&to=&scope=org|team:<teamId>
//
// 組織全体 or チーム単位の稼働時間グリッド。
// レスポンスはネスト構造（teams[].members[].days[]）。
// ============================================================
router.get('/grid', requireAuth, requirePermission('availability:view-org'), async (req, res) => {
  try {
    const from = String(req.query.from || todayStr());
    const toBase = req.query.to ? String(req.query.to) : addDaysStr(from, 69); // ~10週
    const to = toBase;
    const scope = String(req.query.scope || 'org');
    const dateList = eachDate(from, to);
    if (!dateList.length) return res.status(400).json({ error: 'from/to が不正です' });

    // チーム + メンバー取得
    let teamsQuery = supabase
      .from('teams')
      .select('id, team_code, team_name, team_type, is_active, team_members(user_id, leader_rank)')
      .eq('is_active', true)
      .order('team_code');
    if (scope.startsWith('team:')) {
      const tid = scope.slice(5);
      teamsQuery = supabase
        .from('teams')
        .select('id, team_code, team_name, team_type, is_active, team_members(user_id, leader_rank)')
        .eq('id', tid);
    }
    const { data: teamsRaw, error: tErr } = await teamsQuery;
    if (tErr) return res.status(500).json({ error: tErr.message });

    // 基本チームのみ採用（team_code が単一英字 A〜Z）。案件ごとのチーム（ARR, ARRD 等）は除外。
    // 判定規約は haruka.html の renderTeams ロジックと同じ。
    const isBasicTeamCode = (code) => typeof code === 'string' && /^[A-Za-z]$/.test(code);
    const basicTeamsRaw = (teamsRaw || []).filter(t => isBasicTeamCode(t.team_code));

    // 全 user_id を集める
    const userIdSet = new Set();
    for (const t of basicTeamsRaw) {
      for (const tm of (t.team_members || [])) userIdSet.add(tm.user_id);
    }
    const userIds = Array.from(userIdSet);
    if (!userIds.length) {
      return res.json({ from, to, dates: dateList, teams: [], org_totals_by_date: {} });
    }

    // users 詳細
    const { data: users, error: uErr } = await supabase
      .from('users')
      .select('id, full_name, nickname, weekday_hours, weekend_hours, holiday_weekdays, is_active')
      .in('id', userIds)
      .eq('is_active', true);
    if (uErr) return res.status(500).json({ error: uErr.message });
    const usersById = new Map((users || []).map(u => [u.id, u]));

    // GCal プロフィール（gcal_connected のみ判定に使う）
    const { data: profiles, error: pErr } = await supabase
      .from('member_working_hours_profile')
      .select('user_id, gcal_connected')
      .in('user_id', userIds);
    if (pErr) return res.status(500).json({ error: pErr.message });
    const profByUid = new Map((profiles || []).map(p => [p.user_id, p]));

    // 日次データ（GCal 連動者 + 手動オーバーライド）
    const { data: daily, error: dErr } = await supabase
      .from('member_working_hours_daily')
      .select('user_id, date, computed_slots, computed_hours, manual_override, manual_slots, manual_hours, manual_symbol, diverges_from_gcal')
      .in('user_id', userIds)
      .gte('date', from)
      .lte('date', to);
    if (dErr) return res.status(500).json({ error: dErr.message });
    const dailyMap = new Map(); // key: `${user_id}|${date}` -> row
    for (const r of (daily || [])) {
      dailyMap.set(`${r.user_id}|${String(r.date).slice(0,10)}`, r);
    }

    // 編集権限スコープ判定（VIEW AS 反映）
    const canEditOthers = await reqHasPermission(req, 'availability:edit-others');
    const leaderScope = await fetchLeaderScope(req.user.id);

    // 組み立て
    const orgTotalsByDate = Object.fromEntries(dateList.map(d => [d, 0]));
    const outTeams = [];

    for (const t of basicTeamsRaw) {
      const memberRows = (t.team_members || []);
      const teamTotalsByDate = Object.fromEntries(dateList.map(d => [d, 0]));
      let teamTotalWeekday = 0, teamTotalHoliday = 0;
      const members = [];

      for (const tm of memberRows) {
        const u = usersById.get(tm.user_id);
        if (!u) continue;
        const prof = profByUid.get(u.id);
        const isGcal = !!(prof && prof.gcal_connected);

        // ベースの平日/休日デフォルト時間（表ヘッダ用）
        const weekdayDefault = wh.hoursFromTimeRanges(u.weekday_hours);
        const holidayDefault = wh.hoursFromTimeRanges(u.weekend_hours);

        const days = [];
        for (const dateStr of dateList) {
          const base = wh.getBaseSlotsForDate(u, dateStr);
          const row = dailyMap.get(`${u.id}|${dateStr}`);
          const computed = (isGcal && row && row.computed_hours != null)
            ? { slots: row.computed_slots || [], hours: Number(row.computed_hours) }
            : null;
          const manual = (row && row.manual_override) ? {
            override: true,
            slots: row.manual_slots || null,
            hours: row.manual_hours != null ? Number(row.manual_hours) : null,
            symbol: row.manual_symbol || null,
          } : null;
          const eff = wh.resolveEffectiveDaily({ base, computed, manual });
          days.push({
            date: dateStr,
            hours: eff.hours,
            symbol: eff.symbol,
            source: eff.source,
            is_holiday: base.isHoliday,
            slots: (eff.source === 'gcal' || eff.source === 'manual') ? (eff.slots || []) : [],
            manual_override: !!(row && row.manual_override),
            diverges_from_gcal: !!(row && row.diverges_from_gcal),
            computed_hours: (isGcal && row && row.computed_hours != null) ? Number(row.computed_hours) : null,
            base_hours: base.hours,
          });
          teamTotalsByDate[dateStr] = Math.round((teamTotalsByDate[dateStr] + eff.hours) * 100) / 100;
          orgTotalsByDate[dateStr]  = Math.round((orgTotalsByDate[dateStr]  + eff.hours) * 100) / 100;
        }

        // 編集権限: 本人 / availability:edit-others / 「このメンバーが所属する基本チームのリーダー」
        const canEdit = (u.id === req.user.id)
          || canEditOthers
          || leaderScope.memberUserIds.has(u.id);

        teamTotalWeekday = Math.round((teamTotalWeekday + weekdayDefault) * 100) / 100;
        teamTotalHoliday = Math.round((teamTotalHoliday + holidayDefault) * 100) / 100;

        members.push({
          user_id: u.id,
          name: u.nickname || u.full_name || '(unnamed)',
          full_name: u.full_name,
          nickname: u.nickname,
          is_gcal_connected: isGcal,
          is_team_leader: tm.leader_rank === 'leader',
          weekday_default_hours: weekdayDefault,
          holiday_default_hours: holidayDefault,
          can_edit: canEdit,
          days,
        });
      }

      // メンバー並び順: leader 先、それ以外は名前
      members.sort((a, b) => {
        if (a.is_team_leader !== b.is_team_leader) return a.is_team_leader ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'ja');
      });

      outTeams.push({
        id: t.id,
        code: t.team_code,
        name: t.team_name,
        type: t.team_type,
        members,
        team_totals_by_date: teamTotalsByDate,
        team_total_weekday: teamTotalWeekday,
        team_total_holiday: teamTotalHoliday,
      });
    }

    res.json({
      from, to,
      dates: dateList,
      teams: outTeams,
      org_totals_by_date: orgTotalsByDate,
      viewer: {
        user_id: req.user.id,
        can_edit_others: canEditOthers,
        leader_team_ids: Array.from(leaderScope.teamIds),
        leader_member_user_ids: Array.from(leaderScope.memberUserIds),
      },
    });
  } catch (e) {
    console.error('[grid] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PATCH /api/availability/daily
//   body: {
//     user_id: uuid,
//     date: 'YYYY-MM-DD',
//     hours?: number | null,            // 0〜24 / null で削除
//     symbol?: '×'|'△'|'AM'|'PM' | null,
//     slots?: [{from,to}] | null,
//     clear?: boolean                   // 明示クリア（後方互換）
//   }
//
// 手動オーバーライド書き込み（ADR 017 §1.4）。
//
// 認可（ADR 015 準拠）:
//   1) req.user.id === body.user_id              → OK（本人）
//   2) availability:edit-others 権限あり         → OK（admin / secretary 等）
//   3) body.user_id が所属する基本チーム（A〜Z）の leader_rank='leader' が req.user.id → OK
//   4) それ以外                                  → 403
//
// 仕様:
//   - hours / symbol / slots すべて null（または clear=true）の場合 → manual_override 解除
//   - そうでなければ manual_override = true で記録
//   - diverges_from_gcal は computed_hours と比較して算出
//   - レスポンスに更新後のセル状態を返す（フロントで即時反映用）
// ============================================================
const VALID_SYMBOLS = new Set(['×', 'x', '△', 'AM', 'PM']);

function normalizeSymbol(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (str === 'x') return '×';
  if (VALID_SYMBOLS.has(str)) return str;
  return undefined; // invalid sentinel
}

function isValidHours(h) {
  if (h == null) return true; // null OK
  if (typeof h !== 'number' || !isFinite(h)) return false;
  if (h < 0 || h > 24) return false;
  // 半端な精度は許容（小数2桁以内に丸める）
  return true;
}

function isValidSlots(slots) {
  if (slots == null) return true;
  if (!Array.isArray(slots)) return false;
  for (const s of slots) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.from !== 'string' || typeof s.to !== 'string') return false;
    if (!/^\d{1,2}:\d{2}$/.test(s.from) || !/^\d{1,2}:\d{2}$/.test(s.to)) return false;
  }
  return true;
}

router.patch('/daily', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { user_id, date } = body;
    if (!user_id || !date) return res.status(400).json({ error: 'user_id / date が必要です' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'date は YYYY-MM-DD 形式である必要があります' });
    }

    // ===== 認可 =====
    const isSelf = (req.user.id === user_id);
    let authorized = isSelf;
    if (!authorized) {
      // 他人 → edit-others 権限あり？
      authorized = await reqHasPermission(req, 'availability:edit-others');
    }
    if (!authorized) {
      // 他人 → 「対象 user の所属する基本チームのリーダー」か？
      try {
        const { data: ownTeams, error: oErr } = await supabase
          .from('team_members')
          .select('team_id, teams!inner(id, team_code, is_active)')
          .eq('user_id', user_id);
        if (!oErr && Array.isArray(ownTeams)) {
          const basicTeamIds = ownTeams
            .filter(r => r.teams && r.teams.is_active !== false && /^[A-Za-z]$/.test(String(r.teams.team_code || '')))
            .map(r => r.team_id);
          if (basicTeamIds.length) {
            const { data: leaderRows } = await supabase
              .from('team_members')
              .select('team_id')
              .in('team_id', basicTeamIds)
              .eq('user_id', req.user.id)
              .eq('leader_rank', 'leader');
            if (leaderRows && leaderRows.length) authorized = true;
          }
        }
      } catch (_) { /* deny */ }
    }
    if (!authorized) return res.status(403).json({ error: 'このメンバーの稼働時間を編集する権限がありません' });

    // ===== バリデーション =====
    const hasClear = body.clear === true;
    let hours  = (body.hours === undefined) ? null : body.hours;
    let slots  = (body.slots === undefined) ? null : body.slots;
    let symbol = (body.symbol === undefined) ? null : body.symbol;

    if (!isValidHours(hours)) {
      return res.status(400).json({ error: 'hours は 0〜24 の数値、または null です' });
    }
    if (typeof hours === 'number') hours = Math.round(hours * 100) / 100;

    const sym = normalizeSymbol(symbol);
    if (sym === undefined) {
      return res.status(400).json({ error: 'symbol は × / △ / AM / PM / null のいずれかです' });
    }
    symbol = sym;

    if (!isValidSlots(slots)) {
      return res.status(400).json({ error: 'slots は [{from:"HH:MM", to:"HH:MM"}, ...] 形式です' });
    }

    // クリア判定: 明示 clear、または 3項すべて null
    const isClear = hasClear || (hours == null && symbol == null && (slots == null || (Array.isArray(slots) && slots.length === 0)));

    // ===== 既存行を読んで computed_hours と比較 → diverges_from_gcal を算出 =====
    const nowIso = new Date().toISOString();
    const { data: existing } = await supabase
      .from('member_working_hours_daily')
      .select('computed_slots, computed_hours, gcal_synced_at')
      .eq('user_id', user_id)
      .eq('date', date)
      .maybeSingle();

    if (isClear) {
      const { error } = await supabase
        .from('member_working_hours_daily')
        .upsert({
          user_id, date,
          manual_override: false,
          manual_slots: null,
          manual_hours: null,
          manual_symbol: null,
          manual_set_at: nowIso,
          manual_set_by: req.user.id,
          diverges_from_gcal: false,
        }, { onConflict: 'user_id,date' });
      if (error) return res.status(500).json({ error: error.message });

      // === 解除後の effective を返す ===
      // user 情報（base 計算用）
      const { data: u } = await supabase
        .from('users')
        .select('weekday_hours, weekend_hours, holiday_weekdays')
        .eq('id', user_id).maybeSingle();
      const base = wh.getBaseSlotsForDate(u || {}, date);
      const computed = (existing && existing.computed_hours != null)
        ? { slots: existing.computed_slots || [], hours: Number(existing.computed_hours) }
        : null;
      const eff = wh.resolveEffectiveDaily({ base, computed, manual: null });
      return res.json({
        ok: true,
        cleared: true,
        cell: {
          user_id, date,
          hours: eff.hours,
          symbol: eff.symbol,
          source: eff.source,
          slots: (eff.source === 'gcal' || eff.source === 'manual') ? (eff.slots || []) : [],
          manual_override: false,
          diverges_from_gcal: false,
          computed_hours: computed ? computed.hours : null,
          base_hours: base.hours,
        },
      });
    }

    // === 通常の上書き ===
    // 表示用 hours の決定: 明示 hours あればそれ、無ければ slots 合計、symbol が × なら 0
    let effectiveHours = (typeof hours === 'number') ? hours : null;
    if (effectiveHours == null && Array.isArray(slots) && slots.length) {
      effectiveHours = wh.totalHours(slots);
    }
    if (effectiveHours == null && (symbol === '×' || symbol === 'x')) effectiveHours = 0;

    // diverges 判定（computed_hours と比較）
    let diverges = false;
    if (existing && existing.computed_hours != null && effectiveHours != null) {
      const c = Math.round(Number(existing.computed_hours) * 100) / 100;
      const m = Math.round(Number(effectiveHours) * 100) / 100;
      if (c !== m) diverges = true;
    } else if (existing && existing.computed_hours != null && (symbol === '×' || symbol === 'x')) {
      // computed があるのに × なら必ず diverges
      diverges = Number(existing.computed_hours) !== 0;
    }

    const payload = {
      user_id, date,
      manual_override: true,
      manual_slots: (Array.isArray(slots) && slots.length) ? slots : null,
      manual_hours: (typeof hours === 'number') ? hours : null,
      manual_symbol: symbol || null,
      manual_set_at: nowIso,
      manual_set_by: req.user.id,
      diverges_from_gcal: diverges,
    };
    const { error: upErr } = await supabase
      .from('member_working_hours_daily')
      .upsert(payload, { onConflict: 'user_id,date' });
    if (upErr) return res.status(500).json({ error: upErr.message });

    // === effective を返す ===
    const { data: u } = await supabase
      .from('users')
      .select('weekday_hours, weekend_hours, holiday_weekdays')
      .eq('id', user_id).maybeSingle();
    const base = wh.getBaseSlotsForDate(u || {}, date);
    const computed = (existing && existing.computed_hours != null)
      ? { slots: existing.computed_slots || [], hours: Number(existing.computed_hours) }
      : null;
    const manual = {
      override: true,
      slots: payload.manual_slots,
      hours: payload.manual_hours,
      symbol: payload.manual_symbol,
    };
    const eff = wh.resolveEffectiveDaily({ base, computed, manual });
    return res.json({
      ok: true,
      manual_override: true,
      cell: {
        user_id, date,
        hours: eff.hours,
        symbol: eff.symbol,
        source: eff.source,
        slots: (eff.source === 'gcal' || eff.source === 'manual') ? (eff.slots || []) : [],
        manual_override: true,
        diverges_from_gcal: diverges,
        computed_hours: computed ? computed.hours : null,
        base_hours: base.hours,
      },
    });
  } catch (e) {
    console.error('[daily PATCH] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

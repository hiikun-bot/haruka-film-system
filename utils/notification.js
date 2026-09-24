// utils/notification.js — 通知発火ヘルパー（Phase 1）
//
// 役割:
//   ・notification_logs への INSERT を一箇所に集約
//   ・受信者の notification_settings.{type}_enabled フラグを尊重（Phase 2のUIで利用）
//   ・全体通知向けの一括INSERT（bulk）も提供
//   ・スコープA（人が能動的に出す通知）向けの「時間帯指定送信モード」対応
//      sendMode='scheduled' を指定すると delivered_at=NULL で INSERT し、
//      ワーカ workers/notification-scheduler.js が予定時刻に delivered_at を埋める。
//
// 使い方（即時, 既存挙動）:
//   await createNotification({ userId, type: 'global', title, body, senderId });
//
// 使い方（時間帯指定, 受信者の活動枠の最初に配信）:
//   await createNotification({
//     userId, type: 'global', title, body, senderId,
//     sendMode: 'scheduled',
//     // scheduledSendAt 省略時は受信者の users.weekday_hours/weekend_hours/holiday_weekdays を見て自動計算
//   });
//
// エラーハンドリング方針:
//   notification_logs への INSERT は補助処理。失敗しても主処理を止めたくないので、
//   catch して console.error に残すだけ。throw しない。
//
// 注意:
//   ball_returned 通知だけは DBトリガー (notify_ball_returned) が直接 notification_logs に
//   INSERT するルートを持っている。アプリ側からこのヘルパで発火させる必要はない（重複発火回避）。
//   このヘルパを使うのは global / mention / post_reaction / post_comment などアプリ層発火の通知。

const supabase = require('../supabase');

// 種別 → notification_settings の列名・既定値は utils/notification-settings.js（ADR 043）に集約。
// 列が無い種別（pricing_approval / leader_remind / announcement_remind / bulk_delivered / global 系）は
// 常時 ON。設定行が無いユーザー・migration 未適用で列が無い場合は既定値で判定する。
//
// 通知タイプ追加手順は utils/notification-settings.js の冒頭コメントを参照。
const {
  settingColumnFor,
  isEnabledFor,
  filterRowsBySettings,
} = require('./notification-settings');

/**
 * 受信者集合の notification_settings 行を 1 クエリで引いて Map にする。
 * 取得失敗時は空 Map（＝全員既定値で判定）。
 */
async function fetchSettingsMap(userIds) {
  const map = new Map();
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (ids.length === 0) return map;
  try {
    const { data, error } = await supabase
      .from('notification_settings')
      .select('*')
      .in('user_id', ids);
    if (error) {
      console.error('[notification] settings 一括取得失敗（既定値で継続）:', error.message);
      return map;
    }
    (data || []).forEach(row => { if (row && row.user_id) map.set(row.user_id, row); });
  } catch (e) {
    console.error('[notification] settings 一括取得例外（既定値で継続）:', e.message);
  }
  return map;
}

// JST(UTC+9) のオフセットミリ秒
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * UTC の Date を JST 観点での「年月日・曜日・時・分」に分解する。
 * Asia/Tokyo 固定（YAGNI: タイムゾーン抽象化は不要）。
 *
 * @param {Date} d
 * @returns {{ year:number, month:number, day:number, weekday:number, hour:number, minute:number }}
 *   weekday は 0=日, 1=月, ..., 6=土（Date#getDay と同じ並び）
 */
function toJSTParts(d) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    weekday: j.getUTCDay(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

/**
 * JST の (year, month, day, hour, minute) → UTC Date を作る。
 * month は 1-12 で受ける。
 */
function jstToUtc(year, month, day, hour, minute = 0) {
  // Date.UTC で「JSTの y/m/d h:m を UTC として作って」から JST_OFFSET 分だけ引くと、
  // 実際のJST時刻を表すUTCタイムスタンプになる。
  const utcAsIfJst = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return new Date(utcAsIfJst - JST_OFFSET_MS);
}

/**
 * 「from以降で最も近い活動枠の開始時刻」を JST 基準で計算して UTC Date で返す。
 *
 * 仕様:
 *   ・ user.holiday_weekdays(default=[0,6]) に from の曜日が入っていれば weekend_hours 採用、
 *     なければ weekday_hours 採用
 *   ・ 採用した hours が NULL/空配列 → 翌日 0:00 から再帰探索（最大14日先まで）
 *   ・ hours は [{from:9,to:18}, {from:13,to:18}] 形式の数値時。複数枠OK
 *   ・ 「from が枠内」なら from 自体を返す（即時配信扱い）
 *   ・ 「from がその日の全枠より後」なら翌日 0:00 から再帰
 *   ・ 「from が枠の前」ならその枠の開始時刻を返す
 *
 * @param {object} user                 users 行（weekday_hours, weekend_hours, holiday_weekdays を持つ）
 * @param {Date}   [from=new Date()]    基準時刻
 * @param {number} [depth=0]            再帰深さガード
 * @returns {Date} 配信開始時刻（UTC Date）
 */
function nextActiveSlot(user, from = new Date(), depth = 0) {
  // 14日先まで枠が見つからなければ「from そのまま」を返す（事実上の即時配信）
  if (depth > 14) return from;

  // ユーザー設定を取り出し
  const weekdayHours = Array.isArray(user?.weekday_hours)
    ? user.weekday_hours
    : (user?.weekday_hours == null ? [{ from: 9, to: 18 }] : []);
  const weekendHours = Array.isArray(user?.weekend_hours) ? user.weekend_hours : null;
  const holidayWeekdays = Array.isArray(user?.holiday_weekdays)
    ? user.holiday_weekdays.map(Number)
    : [0, 6];

  const parts = toJSTParts(from);
  const isHoliday = holidayWeekdays.includes(parts.weekday);
  const hours = isHoliday ? weekendHours : weekdayHours;

  // 休日扱いで weekend_hours が NULL なら「休み」→ 翌日 0:00 JST から再探索
  if (!hours || hours.length === 0) {
    const next = jstToUtc(parts.year, parts.month, parts.day, 0, 0);
    // 翌日 0:00 JST = 当日 0:00 + 24h
    const nextDay = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    return nextActiveSlot(user, nextDay, depth + 1);
  }

  // 枠を「from の昇順」でソート
  const sortedSlots = [...hours]
    .filter(s => s && Number.isFinite(Number(s.from)) && Number.isFinite(Number(s.to)))
    .map(s => ({ from: Number(s.from), to: Number(s.to) }))
    .filter(s => s.to > s.from)
    .sort((a, b) => a.from - b.from);

  if (sortedSlots.length === 0) {
    const next = jstToUtc(parts.year, parts.month, parts.day, 0, 0);
    const nextDay = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    return nextActiveSlot(user, nextDay, depth + 1);
  }

  // 現在時刻（JST 観点での「時+分/60」）
  const nowDecimalHour = parts.hour + parts.minute / 60;

  for (const slot of sortedSlots) {
    if (nowDecimalHour < slot.from) {
      // 枠の前 → 枠開始時刻
      return jstToUtc(parts.year, parts.month, parts.day, slot.from, 0);
    }
    if (nowDecimalHour >= slot.from && nowDecimalHour < slot.to) {
      // 枠内 → 即時（from そのまま）
      return from;
    }
    // 枠を過ぎている → 次の枠を試す
  }

  // 当日全枠を過ぎた → 翌日 0:00 JST から再探索
  const todayMidnightJst = jstToUtc(parts.year, parts.month, parts.day, 0, 0);
  const nextDay = new Date(todayMidnightJst.getTime() + 24 * 60 * 60 * 1000);
  return nextActiveSlot(user, nextDay, depth + 1);
}

/**
 * 受信者の users 行を取得する小ヘルパー（nextActiveSlot 計算に使う）。
 * 失敗時は null。
 */
async function fetchUserForScheduling(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, weekday_hours, weekend_hours, holiday_weekdays')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.error('[notification] fetchUserForScheduling 失敗:', e.message);
    return null;
  }
}

/**
 * 単件の通知を発火する。
 *
 * @param {object}  args
 * @param {string}  args.userId            受信者 user_id
 * @param {string}  args.type              notification_type コード
 * @param {string}  args.title             見出し（最大80文字想定）
 * @param {string=} args.body              プレビュー本文（最大200文字想定）
 * @param {string=} args.linkUrl           タップ後の遷移先
 * @param {object=} args.meta              追加情報 jsonb
 * @param {string=} args.senderId          送信者 user_id（システム発火なら null）
 * @param {('immediate'|'scheduled')=} args.sendMode  既定 'immediate'。'scheduled' で予約配信。
 * @param {Date|string|null=} args.scheduledSendAt    sendMode='scheduled' の予定時刻。
 *                                                    省略時は受信者の活動枠から自動計算。
 *
 * @returns {Promise<object|null>} INSERT 結果の行、設定でOFFまたは失敗時は null
 */
async function createNotification({
  userId, type, title,
  body = null, linkUrl = null, meta = {}, senderId = null,
  sendMode = 'immediate', scheduledSendAt = null,
}) {
  if (!userId || !type || !title) {
    console.error('[notification] createNotification: 必須パラメータ不足', { userId, type, title });
    return null;
  }

  // 受信者の設定を確認（対応する _enabled 列がある型のみ）。
  // 設定行が無い / 列が無い（migration 未適用）→ 種別の既定値で判定（既定 OFF の種別は届けない）。
  if (settingColumnFor(type)) {
    const settingsMap = await fetchSettingsMap([userId]);
    if (!isEnabledFor(settingsMap.get(userId) || null, type)) {
      return null; // ユーザーが種別ごと OFF にしている（または既定 OFF）
    }
  }

  // 予約モード: scheduledSendAt を確定 → delivered_at=null で INSERT
  let resolvedScheduledAt = null;
  let resolvedDeliveredAt = new Date().toISOString();
  let resolvedSendMode = 'immediate';

  if (sendMode === 'scheduled') {
    resolvedSendMode = 'scheduled';
    resolvedDeliveredAt = null;

    if (scheduledSendAt) {
      const d = scheduledSendAt instanceof Date ? scheduledSendAt : new Date(scheduledSendAt);
      if (Number.isFinite(d.getTime())) resolvedScheduledAt = d.toISOString();
    }
    if (!resolvedScheduledAt) {
      const u = await fetchUserForScheduling(userId);
      if (u) {
        resolvedScheduledAt = nextActiveSlot(u, new Date()).toISOString();
      } else {
        // ユーザー情報が取れない → 即時にフォールバック（壊さない）
        resolvedSendMode = 'immediate';
        resolvedDeliveredAt = new Date().toISOString();
      }
    }
  }

  try {
    const insertRow = {
      user_id: userId,
      notification_type: type,
      title,
      body,
      link_url: linkUrl,
      meta,
      sender_id: senderId,
      send_mode: resolvedSendMode,
      scheduled_send_at: resolvedScheduledAt,
      delivered_at: resolvedDeliveredAt,
    };
    const { data, error } = await supabase
      .from('notification_logs')
      .insert(insertRow)
      .select()
      .single();
    if (error) {
      console.error('[notification] INSERT 失敗:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[notification] 例外:', e.message);
    return null;
  }
}

/**
 * 複数通知を一括発火する。全体通知（admin が全員へ告知）等で使う。
 * 受信者ごとの notification_settings を 1 クエリで引き、OFF（既定 OFF 含む）の行は間引く。
 * 列が無い種別（global / pricing_approval / leader_remind など）は常時 ON。
 *
 * sendMode='scheduled' のとき:
 *   ・ scheduledSendAt が明示指定されていれば全員共通でその時刻
 *   ・ 省略時は受信者ごとに nextActiveSlot を個別計算
 *
 * @param {Array<{user_id, notification_type, title, body?, link_url?, meta?, sender_id?}>} notifications
 * @param {object=} options
 * @param {('immediate'|'scheduled')=} options.sendMode
 * @param {Date|string|null=} options.scheduledSendAt 全員共通の配信時刻（明示）
 * @returns {Promise<Array>} INSERT 結果の行配列、失敗時は空配列
 */
async function createBulkNotifications(notificationsInput, options = {}) {
  if (!Array.isArray(notificationsInput) || notificationsInput.length === 0) return [];

  // 受信者の設定で間引く（設定列が無い種別だけなら settings を引かない）
  let notifications = notificationsInput;
  if (notificationsInput.some(n => n && settingColumnFor(n.notification_type))) {
    const settingsMap = await fetchSettingsMap(notificationsInput.map(n => n && n.user_id));
    notifications = filterRowsBySettings(notificationsInput, settingsMap);
    if (notifications.length === 0) return [];
  }

  const { sendMode = 'immediate', scheduledSendAt = null } = options;
  const nowIso = new Date().toISOString();

  let rows;
  if (sendMode !== 'scheduled') {
    // 既存挙動: 即時（delivered_at=now, send_mode=immediate）
    rows = notifications.map(n => ({
      ...n,
      send_mode: 'immediate',
      scheduled_send_at: null,
      delivered_at: nowIso,
    }));
  } else if (scheduledSendAt) {
    // 全員共通の予約時刻
    const d = scheduledSendAt instanceof Date ? scheduledSendAt : new Date(scheduledSendAt);
    const iso = Number.isFinite(d.getTime()) ? d.toISOString() : nowIso;
    rows = notifications.map(n => ({
      ...n,
      send_mode: 'scheduled',
      scheduled_send_at: iso,
      delivered_at: null,
    }));
  } else {
    // 受信者ごとに nextActiveSlot を個別計算
    const userIds = Array.from(new Set(notifications.map(n => n.user_id).filter(Boolean)));
    let userMap = new Map();
    try {
      const { data: users } = await supabase
        .from('users')
        .select('id, weekday_hours, weekend_hours, holiday_weekdays')
        .in('id', userIds);
      (users || []).forEach(u => userMap.set(u.id, u));
    } catch (e) {
      console.error('[notification] bulk: users 取得失敗', e.message);
    }
    const baseTime = new Date();
    rows = notifications.map(n => {
      const u = userMap.get(n.user_id);
      const at = u ? nextActiveSlot(u, baseTime) : baseTime;
      return {
        ...n,
        send_mode: 'scheduled',
        scheduled_send_at: at.toISOString(),
        delivered_at: null,
      };
    });
  }

  try {
    const { data, error } = await supabase
      .from('notification_logs')
      .insert(rows)
      .select();
    if (error) {
      console.error('[notification] bulk INSERT 失敗:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[notification] bulk 例外:', e.message);
    return [];
  }
}

// ---------- メンション解決 ----------
// 本文中の「@名前」を users に解決して user_id 配列を返す。
// 照合ロジック本体は utils/mention-resolve.js（フロントの「@」補完・ハイライトと共有）。
//   ・前方一致・最長一致（「@たごんお疲れ様」→ たごん / 「@川崎 かおり」→ 川崎 かおり）
//   ・nickname / full_name / 姓のみ、全角半角・大文字小文字は無視
// 名簿（id, full_name, nickname）は 60 秒キャッシュして投稿の度に users を引かない。
const { extractMentionIds } = require('./mention-resolve');
const MENTION_DIR_TTL_MS = 60 * 1000;
let _mentionDirCache = { at: 0, users: [] };

async function loadMentionDirectory({ force = false } = {}) {
  const now = Date.now();
  if (!force && _mentionDirCache.users.length && (now - _mentionDirCache.at) < MENTION_DIR_TTL_MS) {
    return _mentionDirCache.users;
  }
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, nickname, is_active');
  if (error) throw error;
  // 退会者（is_active=false）は対象外。null は在籍扱い（旧データ）
  const users = (data || []).filter(u => u && u.is_active !== false);
  _mentionDirCache = { at: now, users };
  return users;
}

async function extractMentions(body) {
  if (!body || typeof body !== 'string') return [];
  if (!/[@＠]/.test(body)) return [];
  try {
    const users = await loadMentionDirectory();
    return extractMentionIds(body, users);
  } catch (e) {
    console.error('[notification] extractMentions 失敗:', e.message);
    return [];
  }
}

module.exports = {
  createNotification,
  loadMentionDirectory,
  createBulkNotifications,
  extractMentions,
  nextActiveSlot,
};

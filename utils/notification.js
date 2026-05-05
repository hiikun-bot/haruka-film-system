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

// notification_settings の {type}_enabled 列名対応表。
// type が settings 列に対応していないものは「常時ON扱い」（settings 確認をスキップ）
const TYPE_TO_SETTING_COL = {
  ball_returned:  'ball_returned_enabled',
  global:         'global_enabled',
  mention:        'mention_enabled',
  post_reaction:  'post_reaction_enabled',
  post_comment:   'post_comment_enabled',
  sos:            'sos_enabled',
  deadline:       'deadline_enabled',
  assignment:     'assignment_enabled',
  invoice:        'invoice_enabled',
};

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

  // 受信者の設定を確認（対応する _enabled 列がある型のみ）
  const settingCol = TYPE_TO_SETTING_COL[type];
  if (settingCol) {
    try {
      const { data: settings } = await supabase
        .from('notification_settings')
        .select(settingCol)
        .eq('user_id', userId)
        .maybeSingle();
      if (settings && settings[settingCol] === false) {
        return null; // ユーザーが種別ごと OFF にしている
      }
    } catch (e) {
      console.error('[notification] settings 取得失敗（処理は継続）:', e.message);
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
 * notification_settings の確認は省略（全体通知を個別 OFF にする UI は Phase 2で別途）。
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
async function createBulkNotifications(notifications, options = {}) {
  if (!Array.isArray(notifications) || notifications.length === 0) return [];

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

/**
 * 投稿本文（つぶやき / コメント）から `@名前` 表記のメンションを抽出して
 * users テーブルから user_id を解決する。
 *
 * 仕様:
 *   ・正規表現は /@([\p{L}\p{N}_]+)/gu — 全角OK / アンダースコア許容
 *   ・名前部分は半角/全角スペース・改行・文末で区切られる
 *   ・大文字小文字無視（lower で比較）
 *   ・nickname または full_name と完全一致で照合（nickname優先）
 *   ・重複排除して string[] (UUID) を返す
 *   ・0件マッチ時 / 解決失敗時は空配列
 *
 * @param {string} body  投稿本文
 * @returns {Promise<string[]>} ユニークな user_id 配列
 */
async function extractMentions(body) {
  if (!body || typeof body !== 'string') return [];

  const matches = body.match(/@([\p{L}\p{N}_]+)/gu);
  if (!matches || matches.length === 0) return [];

  // 先頭の @ を除いて重複排除
  const names = Array.from(new Set(
    matches.map(m => m.replace(/^@/, '').trim()).filter(Boolean)
  ));
  if (names.length === 0) return [];

  // users から nickname / full_name を取得して名前→id マップを作る
  // （IN 句を投げる前に重複排除済み。10名くらい想定なので一括で全件取らない）
  try {
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, nickname')
      .or(
        // nickname / full_name どちらかが候補名と一致
        names.flatMap(n => [`nickname.eq.${n}`, `full_name.eq.${n}`]).join(',')
      );
    if (!users || users.length === 0) return [];

    // 大文字小文字無視で照合: 名前 → user_id
    const lowerNames = new Set(names.map(n => n.toLowerCase()));
    const resolved = new Set();
    for (const u of users) {
      const nick = (u.nickname || '').toLowerCase();
      const full = (u.full_name || '').toLowerCase();
      if ((nick && lowerNames.has(nick)) || (full && lowerNames.has(full))) {
        resolved.add(u.id);
      }
    }
    return Array.from(resolved);
  } catch (e) {
    console.error('[notification] extractMentions 失敗:', e.message);
    return [];
  }
}

module.exports = {
  createNotification,
  createBulkNotifications,
  extractMentions,
  nextActiveSlot,
};

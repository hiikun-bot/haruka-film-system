// lib/working-hours.js — 稼働時間計算ユーティリティ（ADR 017 Phase 1.0）
//
// 純粋関数群。routes 層には依存しない。
//
// 時間帯の表現:
//   slot = { from: "HH:MM", to: "HH:MM" }
//   ranges (users.weekday_hours 形式) = [{ from: 9, to: 18 }, ...]
//     - from/to は整数の hour。1.5h 等の半端は minutes 副キー、または
//       "HH:MM" 文字列で来るパターンも吸収する。
//
// 公開 API:
//   hoursFromTimeRanges(ranges)
//   normalizeRanges(ranges) -> slots ([{from:"HH:MM", to:"HH:MM"}])
//   isHolidayForUser(date, user)
//   getBaseSlotsForDate(user, date) -> { slots, hours, isHoliday }
//   subtractEvents(baseSlots, events, { dateStr, tz }) -> { slots, hours }
//   resolveEffectiveDaily({ base, computed, manual }) -> { hours, symbol, slots, source }

const { isJapanHoliday } = require('./japanese-holidays');

// ===== helpers =====

function pad2(n) { return String(n).padStart(2, '0'); }

function toMinutes(hhmm) {
  if (hhmm == null) return null;
  if (typeof hhmm === 'number') {
    // 9 -> 540, 9.5 -> 570
    const h = Math.floor(hhmm);
    const m = Math.round((hhmm - h) * 60);
    return h * 60 + m;
  }
  const s = String(hhmm);
  const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const n = parseFloat(s);
  if (!Number.isNaN(n)) {
    const h = Math.floor(n);
    const mm = Math.round((n - h) * 60);
    return h * 60 + mm;
  }
  return null;
}

function fromMinutes(min) {
  if (min == null || Number.isNaN(min)) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/**
 * users.weekday_hours / weekend_hours のような range を
 * 統一形式 [{from:"HH:MM", to:"HH:MM"}] に正規化する。
 *
 * 受け取れる形式:
 *   [{from:9, to:18}]
 *   [{from:"09:00", to:"18:00"}]
 *   [{from:9, to:18, minutes:30}]   ← Phase 0 メモに登場。to に分を足す扱い
 *   [{start:"09:00", end:"18:00"}]  ← 念のため
 *   null / [] / undefined
 */
function normalizeRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  const out = [];
  for (const r of ranges) {
    if (!r || typeof r !== 'object') continue;
    const fromRaw = r.from ?? r.start;
    const toRaw   = r.to   ?? r.end;
    let fromMin = toMinutes(fromRaw);
    let toMin   = toMinutes(toRaw);
    // minutes 副キー: to に分を加算（"19-21 + 30分" → 21:30）
    if (typeof r.minutes === 'number' && toMin != null) {
      toMin = toMin + r.minutes;
    }
    if (fromMin == null || toMin == null) continue;
    if (toMin <= fromMin) continue;
    out.push({ from: fromMinutes(fromMin), to: fromMinutes(toMin) });
  }
  // 結合・ソート
  out.sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && toMinutes(s.from) <= toMinutes(last.to)) {
      last.to = fromMinutes(Math.max(toMinutes(last.to), toMinutes(s.to)));
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * normalized slots の合計時間 (h)。小数2桁。
 */
function totalHours(slots) {
  let m = 0;
  for (const s of slots || []) {
    const f = toMinutes(s.from), t = toMinutes(s.to);
    if (f == null || t == null) continue;
    m += Math.max(0, t - f);
  }
  return Math.round((m / 60) * 100) / 100;
}

/**
 * users.weekday_hours のような ranges から「平日デフォルト時間数」を返す。
 */
function hoursFromTimeRanges(ranges) {
  return totalHours(normalizeRanges(ranges));
}

/**
 * date が user にとって「休日扱い」かどうか。
 *   - user.holiday_weekdays (例: [0,6] = 日,土) に該当する曜日
 *   - 日本の祝日
 * のいずれかなら true。
 */
function isHolidayForUser(date, user) {
  const d = (date instanceof Date) ? date : new Date(String(date) + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun..6=Sat
  let holidayWeekdays;
  if (user && Array.isArray(user.holiday_weekdays)) {
    holidayWeekdays = user.holiday_weekdays;
  } else if (user && typeof user.holiday_weekdays === 'string') {
    try { holidayWeekdays = JSON.parse(user.holiday_weekdays); } catch (_) { holidayWeekdays = [0, 6]; }
  } else {
    holidayWeekdays = [0, 6];
  }
  if (holidayWeekdays.includes(dow)) return true;
  if (isJapanHoliday(d)) return true;
  return false;
}

/**
 * 指定日の基本 slots を返す。
 * @returns {{ slots:Array<{from,to}>, hours:number, isHoliday:boolean }}
 */
function getBaseSlotsForDate(user, date) {
  const holiday = isHolidayForUser(date, user);
  const rangesRaw = holiday ? (user?.weekend_hours) : (user?.weekday_hours);
  const slots = normalizeRanges(rangesRaw);
  const hours = totalHours(slots);
  return { slots, hours, isHoliday: holiday };
}

// ===== GCal subtract =====

/**
 * GCal event の {start,end} (ISO 文字列 or YYYY-MM-DD) を当該 dateStr の HH:MM range に丸める。
 *
 * Phase 1.0 は JST 固定（process.env.TZ=Asia/Tokyo 想定）。タイムゾーン精密対応は Phase 1.x。
 */
function eventToDayMinutes(ev, dateStr) {
  if (!ev || !ev.start || !ev.end) return null;
  // 終日イベント or 日付のみ
  if (ev.isAllDay || /^\d{4}-\d{2}-\d{2}$/.test(String(ev.start))) {
    return { from: 0, to: 24 * 60 };
  }
  const start = new Date(ev.start);
  const end   = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  // 該当日の 00:00..24:00 範囲（ローカル）
  const dayStart = new Date(String(dateStr) + 'T00:00:00');
  const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const s = Math.max(start.getTime(), dayStart.getTime());
  const e = Math.min(end.getTime(),   dayEnd.getTime());
  if (e <= s) return null;
  const fromMin = Math.round((s - dayStart.getTime()) / 60000);
  const toMin   = Math.round((e - dayStart.getTime()) / 60000);
  return { from: fromMin, to: toMin };
}

/**
 * baseSlots から events と被る時間を引く。
 * @param {Array<{from,to}>} baseSlots
 * @param {Array<{start,end,status,transparency,isAllDay}>} events
 * @param {{dateStr:string}} opts
 * @returns {{ slots:Array<{from,to}>, hours:number }}
 */
function subtractEvents(baseSlots, events, opts = {}) {
  const dateStr = opts.dateStr;
  // 該当日のイベント time-ranges を分単位で集める
  const busy = [];
  for (const ev of events || []) {
    if (!ev) continue;
    if (ev.status === 'cancelled') continue;
    if (ev.transparency === 'transparent') continue;
    const r = eventToDayMinutes(ev, dateStr);
    if (r) busy.push(r);
  }
  // busy をマージ
  busy.sort((a, b) => a.from - b.from);
  const mergedBusy = [];
  for (const b of busy) {
    const last = mergedBusy[mergedBusy.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else mergedBusy.push({ ...b });
  }
  // baseSlots を分単位に
  const baseMin = (baseSlots || []).map(s => ({
    from: toMinutes(s.from),
    to: toMinutes(s.to),
  })).filter(s => s.from != null && s.to != null && s.to > s.from);

  // 各 baseSlot から busy を差し引く
  const result = [];
  for (const slot of baseMin) {
    let pieces = [{ from: slot.from, to: slot.to }];
    for (const b of mergedBusy) {
      const next = [];
      for (const p of pieces) {
        if (b.to <= p.from || b.from >= p.to) {
          next.push(p);
        } else {
          if (b.from > p.from) next.push({ from: p.from, to: b.from });
          if (b.to   < p.to)   next.push({ from: b.to,   to: p.to });
        }
      }
      pieces = next;
    }
    // 30分未満の隙間カット
    for (const p of pieces) {
      if (p.to - p.from >= 30) result.push(p);
    }
  }
  const slots = result.map(p => ({ from: fromMinutes(p.from), to: fromMinutes(p.to) }));
  return { slots, hours: totalHours(slots) };
}

/**
 * その日の effective 値を決める。
 *   manual_override (manual.symbol === '×' なら 0h) > computed > base
 *
 * @param {object} args
 * @param {object} [args.base]     { slots, hours, isHoliday }
 * @param {object} [args.computed] { slots, hours }  (GCal sync の結果)
 * @param {object} [args.manual]   { override:boolean, symbol?:string, slots?, hours? }
 * @returns {{ hours:number, symbol:?string, slots:Array, source:'manual'|'gcal'|'base' }}
 */
function resolveEffectiveDaily({ base, computed, manual } = {}) {
  if (manual && manual.override) {
    if (manual.symbol === '×' || manual.symbol === 'x') {
      return { hours: 0, symbol: manual.symbol || null, slots: [], source: 'manual' };
    }
    if (Array.isArray(manual.slots) && manual.slots.length) {
      return { hours: typeof manual.hours === 'number' ? manual.hours : totalHours(manual.slots), symbol: manual.symbol || null, slots: manual.slots, source: 'manual' };
    }
    if (typeof manual.hours === 'number') {
      return { hours: manual.hours, symbol: manual.symbol || null, slots: [], source: 'manual' };
    }
    if (manual.symbol) {
      return { hours: 0, symbol: manual.symbol, slots: [], source: 'manual' };
    }
  }
  if (computed && Array.isArray(computed.slots)) {
    return { hours: typeof computed.hours === 'number' ? computed.hours : totalHours(computed.slots), symbol: null, slots: computed.slots, source: 'gcal' };
  }
  const b = base || { slots: [], hours: 0 };
  return { hours: b.hours || 0, symbol: null, slots: b.slots || [], source: 'base' };
}

module.exports = {
  toMinutes,
  fromMinutes,
  totalHours,
  hoursFromTimeRanges,
  normalizeRanges,
  isHolidayForUser,
  getBaseSlotsForDate,
  subtractEvents,
  resolveEffectiveDaily,
};

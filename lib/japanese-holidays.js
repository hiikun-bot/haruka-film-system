// lib/japanese-holidays.js — 日本の祝日判定（ADR 017 Phase 1.0）
//
// Phase 2 で会社カレンダーマスターと統合される設計のため、Phase 1.0 は
// 2026 / 2027 の祝日を JSON にハードコードした薄い実装で十分。
// 振替休日・国民の休日も判定済みの結果として含める。

const HOLIDAYS = {
  // 2026
  '2026-01-01': '元日',
  '2026-01-12': '成人の日',
  '2026-02-11': '建国記念の日',
  '2026-02-23': '天皇誕生日',
  '2026-03-20': '春分の日',
  '2026-04-29': '昭和の日',
  '2026-05-03': '憲法記念日',
  '2026-05-04': 'みどりの日',
  '2026-05-05': 'こどもの日',
  '2026-05-06': '振替休日',
  '2026-07-20': '海の日',
  '2026-08-11': '山の日',
  '2026-09-21': '敬老の日',
  '2026-09-22': '国民の休日',
  '2026-09-23': '秋分の日',
  '2026-10-12': 'スポーツの日',
  '2026-11-03': '文化の日',
  '2026-11-23': '勤労感謝の日',
  // 2027
  '2027-01-01': '元日',
  '2027-01-11': '成人の日',
  '2027-02-11': '建国記念の日',
  '2027-02-23': '天皇誕生日',
  '2027-03-21': '春分の日',
  '2027-03-22': '振替休日',
  '2027-04-29': '昭和の日',
  '2027-05-03': '憲法記念日',
  '2027-05-04': 'みどりの日',
  '2027-05-05': 'こどもの日',
  '2027-07-19': '海の日',
  '2027-08-11': '山の日',
  '2027-09-20': '敬老の日',
  '2027-09-23': '秋分の日',
  '2027-10-11': 'スポーツの日',
  '2027-11-03': '文化の日',
  '2027-11-23': '勤労感謝の日',
};

/**
 * 日付文字列 (YYYY-MM-DD) または Date が日本の祝日かどうかを返す。
 * @param {string|Date} d
 * @returns {boolean}
 */
function isJapanHoliday(d) {
  if (!d) return false;
  let key;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    key = `${y}-${m}-${day}`;
  } else {
    key = String(d).slice(0, 10);
  }
  return Object.prototype.hasOwnProperty.call(HOLIDAYS, key);
}

function getHolidayName(d) {
  if (!d) return null;
  const key = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    : String(d).slice(0, 10);
  return HOLIDAYS[key] || null;
}

module.exports = { isJapanHoliday, getHolidayName, HOLIDAYS };

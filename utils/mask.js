// utils/mask.js
// =============================================================
// 個人情報のマスク（ADR 035 契約管理）。純関数・DB 非依存。
//
//   maskAccountNumber('1234567') → '****4567'（4桁未満は全部 '*'）
//   maskAddress('兵庫県尼崎市上坂部1丁目8番1－424号') → '兵庫県尼崎市'
//   maskPhone('090-1234-5678') → '****5678'
//   maskProfile(user) → 口座・住所・電話をマスクした浅いコピー
// =============================================================

const MASK = '****';

function maskAccountNumber(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (s.length < 4) return '*'.repeat(s.length);
  return MASK + s.slice(-4);
}

// 都道府県＋市区町村（郡）まで残す。判定できないときは空文字（安全側）。
const ADDRESS_RE = /^(?:\s*)((?:東京都|北海道|(?:京都|大阪)府|[^\s都道府県]{1,4}県)?\s*[^\s市区町村郡]{1,10}?(?:市|区|町|村|郡))/;
function maskAddress(v) {
  if (!v) return '';
  const s = String(v).replace(/　/g, ' ').trim();
  const m = s.match(ADDRESS_RE);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function maskPhone(v) {
  if (v === null || v === undefined) return '';
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 4) return '*'.repeat(digits.length);
  return MASK + digits.slice(-4);
}

// 契約管理の詳細画面（本人以外）向け: 口座番号は下4桁、住所は市区町村、電話は下4桁だけ残す。
function maskProfile(user) {
  if (!user) return null;
  const out = { ...user };
  if ('account_number' in out) out.account_number = maskAccountNumber(out.account_number);
  if ('address' in out) out.address = maskAddress(out.address);
  if ('phone' in out) out.phone = maskPhone(out.phone);
  return out;
}

module.exports = { maskAccountNumber, maskAddress, maskPhone, maskProfile, MASK };

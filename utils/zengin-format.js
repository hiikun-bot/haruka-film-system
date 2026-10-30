// utils/zengin-format.js — 総合振込（全銀形式）向けの口座情報の変換と検証（ADR 054 §4）
// =============================================================
// 純関数・DB 非依存。routes/bank-transfer.js と workers/bank-transfer-poller.js から使う。
// テスト: tests/zengin-format.test.js
//
// GMOあおぞらネット銀行 オープンAPI仕様書（法人口座編 1.21.0）「振込の文字について」に合わせる:
//   - 振込許容文字: 半角カナ（ｱ〜ﾝ・ｦ・ｰ・濁点ﾞ・半濁点ﾟ）、英大文字、数字、スペース、
//     丸括弧 ( )、ハイフン -、ピリオド .、スラッシュ /、カンマ ,、かぎ括弧 ｢ ｣、円マーク \
//   - 銀行側の変換（小文字カナ→大文字カナ、英小文字→英大文字、長音 ｰ→-、カナとして成立しない
//     濁点・半濁点は削除）を HFS 側でも先に同じように行い、DB に残す受取人名と銀行の取り込み結果を一致させる
//   - 受取人名は 30 文字目まで有効（31 文字目以降は銀行が切り捨てる）
//   - 口座番号は 7 桁・7 桁未満は前ゼロ。科目コードは 1:普通 2:当座 4:貯蓄 9:その他
// =============================================================

const BENEFICIARY_NAME_MAX = 30;

// 全角カタカナ（濁点・半濁点つきは分解）→ 半角カナ
const FULL_TO_HALF_KANA = {
  'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ',
  'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
  'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ',
  'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
  'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ',
  'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
  'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ',
  'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
  'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ',
  'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
  'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ',
  'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
  'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ',
  'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
  'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ',
  'ヴ': 'ｳﾞ',
  // 小文字カナは銀行側で大文字に変換される → 先に大文字へ
  'ァ': 'ｱ', 'ィ': 'ｲ', 'ゥ': 'ｳ', 'ェ': 'ｴ', 'ォ': 'ｵ',
  'ッ': 'ﾂ', 'ャ': 'ﾔ', 'ュ': 'ﾕ', 'ョ': 'ﾖ',
  'ヮ': 'ﾜ', 'ヰ': 'ｲ', 'ヱ': 'ｴ', 'ヵ': 'ｶ', 'ヶ': 'ｹ',
  'ー': 'ｰ', '゛': 'ﾞ', '゜': 'ﾟ', '・': '.',
  '　': ' ',
  '（': '(', '）': ')', '－': '-', '―': '-', '‐': '-', '．': '.', '／': '/', '，': ',',
  '「': '｢', '」': '｣', '￥': '\\',
};

// 半角の小文字カナ → 大文字カナ（銀行側の変換表①）
const HALF_SMALL_TO_LARGE = {
  'ｧ': 'ｱ', 'ｨ': 'ｲ', 'ｩ': 'ｳ', 'ｪ': 'ｴ', 'ｫ': 'ｵ', 'ｯ': 'ﾂ', 'ｬ': 'ﾔ', 'ｭ': 'ﾕ', 'ｮ': 'ﾖ',
};

// 濁点を付けられる半角カナ / 半濁点を付けられる半角カナ（カナとして成立しない濁点・半濁点は削除する）
const DAKUTEN_BASE = new Set('ｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾊﾋﾌﾍﾎｳ'.split(''));
const HANDAKUTEN_BASE = new Set('ﾊﾋﾌﾍﾎ'.split(''));

// 振込許容文字（半角カナ ｦ〜ﾟ = U+FF66〜U+FF9F、英大文字、数字、記号）
const ALLOWED_RE = /^[｢｣ｦ-ﾟA-Z0-9 ()\-./\\,]$/;

const ACCOUNT_TYPE_CODES = {
  '普通': '1', '普通預金': '1', 'ordinary': '1', 'savings_ordinary': '1', '1': '1',
  '当座': '2', '当座預金': '2', 'checking': '2', 'current': '2', '2': '2',
  '貯蓄': '4', '貯蓄預金': '4', 'savings': '4', '4': '4',
  'その他': '9', 'other': '9', '9': '9',
};
const ACCOUNT_TYPE_LABELS = { '1': '普通', '2': '当座', '4': '貯蓄', '9': 'その他' };

/** 全角英数字・全角スペースを半角へ */
function toHalfWidthAlnum(str) {
  return String(str || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

/** ひらがな → 全角カタカナ（口座名義にひらがなが入ってしまった場合の救済） */
function hiraganaToKatakana(str) {
  return String(str || '').replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

/**
 * 全角カナ → 半角カナ（濁点・半濁点は別文字に分解: ガ → ｶﾞ）。
 * 英数字・記号の全角も半角に寄せる。元から半角のものはそのまま。
 */
function toHalfWidthKana(str) {
  const src = hiraganaToKatakana(toHalfWidthAlnum(str));
  let out = '';
  for (const ch of src) {
    out += Object.prototype.hasOwnProperty.call(FULL_TO_HALF_KANA, ch) ? FULL_TO_HALF_KANA[ch] : ch;
  }
  return out;
}

/**
 * 振込許容文字だけを残す。銀行側の変換（英小文字→大文字・小文字カナ→大文字カナ・ｰ→-・孤立した濁点削除）も
 * 同じ順序で先に行う。
 * @returns {{ value: string, removed: string[], converted: boolean }}
 */
function filterAllowedChars(str) {
  const src = toHalfWidthKana(str);
  const removed = [];
  let converted = false;
  let out = '';
  for (let ch of src) {
    const orig = ch;
    if (/^[a-z]$/.test(ch)) ch = ch.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(HALF_SMALL_TO_LARGE, ch)) ch = HALF_SMALL_TO_LARGE[ch];
    if (ch === 'ｰ') ch = '-';
    if (ch !== orig) converted = true;
    if (ch === 'ﾞ' || ch === 'ﾟ') {
      // 直前がカナとして成立する文字でなければ落とす（例: ｱﾞ → ｱ）
      const prev = out.slice(-1);
      const ok = ch === 'ﾞ' ? DAKUTEN_BASE.has(prev) : HANDAKUTEN_BASE.has(prev);
      if (!ok) { removed.push(orig); converted = true; continue; }
    }
    if (!ALLOWED_RE.test(ch)) { removed.push(orig); continue; }
    out += ch;
  }
  // 連続スペース・前後スペースは詰める（銀行の文字数制限 30 を無駄にしない）
  const value = out.replace(/ {2,}/g, ' ').trim();
  return { value, removed, converted };
}

/**
 * 受取人名（account_holder_kana）を全銀形式に整える。
 * @returns {{ value: string|null, warnings: string[], error: string|null }}
 */
function normalizeBeneficiaryName(kana) {
  const warnings = [];
  const raw = String(kana || '').trim();
  if (!raw) return { value: null, warnings, error: '口座名義（カナ）が未設定です' };
  const { value, removed } = filterAllowedChars(raw);
  if (removed.length) {
    warnings.push(`口座名義に使えない文字を除きました: ${[...new Set(removed)].join(' ')}`);
  }
  if (!value) return { value: null, warnings, error: '口座名義（カナ）に有効な文字がありません' };
  let name = value;
  if (name.length > BENEFICIARY_NAME_MAX) {
    name = name.slice(0, BENEFICIARY_NAME_MAX).trim();
    warnings.push(`口座名義が ${BENEFICIARY_NAME_MAX} 文字を超えるため ${BENEFICIARY_NAME_MAX} 文字で切りました`);
  }
  return { value: name, warnings, error: null };
}

function digitsOnly(v) {
  return toHalfWidthAlnum(v).replace(/[^0-9]/g, '');
}

/** 銀行コード → 4桁（前ゼロ）。数字が無い・5桁以上は null */
function formatBankCode(v) {
  const d = digitsOnly(v);
  if (!d || d.length > 4) return null;
  return d.padStart(4, '0');
}

/** 支店コード → 3桁（前ゼロ）。数字が無い・4桁以上は null */
function formatBranchCode(v) {
  const d = digitsOnly(v);
  if (!d || d.length > 3) return null;
  return d.padStart(3, '0');
}

/**
 * 口座番号 → 7桁（前ゼロ）。
 * @returns {{ value: string|null, error: string|null }}
 */
function formatAccountNumber(v) {
  const d = digitsOnly(v);
  if (!d) return { value: null, error: '口座番号が未設定です' };
  if (d.length > 7) return { value: null, error: `口座番号が 8 桁以上です（${d.length} 桁）。7 桁で登録し直してください` };
  if (/^0+$/.test(d)) return { value: null, error: '口座番号が 0 のみです' };
  return { value: d.padStart(7, '0'), error: null };
}

/** 科目（'普通' / '当座' / '貯蓄' / コード）→ 科目コード。不明は null */
function accountTypeCode(v) {
  const key = String(v ?? '').trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(ACCOUNT_TYPE_CODES, key)) return ACCOUNT_TYPE_CODES[key];
  const lower = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ACCOUNT_TYPE_CODES, lower)) return ACCOUNT_TYPE_CODES[lower];
  return null;
}

function accountTypeLabel(code) {
  return ACCOUNT_TYPE_LABELS[String(code)] || null;
}

/** 口座番号の下4桁だけ残す（ログ・通知・画面用） */
function maskAccountNumber(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length < 4) return '*'.repeat(s.length);
  return '****' + s.slice(-4);
}

/**
 * users 行から総合振込の明細（口座部分）を組み立てる。
 * @param {object} user users 行（bank_code, branch_code, account_type, account_number, account_holder_kana）
 * @returns {{ ok: true, item: {bank_code, branch_code, account_type_code, account_number, beneficiary_name}, errors: [], warnings: string[] }
 *          | { ok: false, item: null, errors: string[], warnings: string[] }}
 */
function buildBeneficiary(user) {
  const u = user || {};
  const errors = [];
  const warnings = [];

  const bankCode = formatBankCode(u.bank_code);
  if (!bankCode) errors.push(u.bank_code ? `銀行コードが不正です（${String(u.bank_code).trim()}）` : '銀行コードが未設定です');

  const branchCode = formatBranchCode(u.branch_code);
  if (!branchCode) errors.push(u.branch_code ? `支店コードが不正です（${String(u.branch_code).trim()}）` : '支店コードが未設定です');

  const typeCode = accountTypeCode(u.account_type);
  if (!typeCode) errors.push(u.account_type ? `科目が不正です（${String(u.account_type).trim()}）` : '科目（普通/当座）が未設定です');

  const acct = formatAccountNumber(u.account_number);
  if (acct.error) errors.push(acct.error);

  const name = normalizeBeneficiaryName(u.account_holder_kana);
  if (name.error) errors.push(name.error);
  warnings.push(...name.warnings);

  if (errors.length) return { ok: false, item: null, errors, warnings };
  return {
    ok: true,
    item: {
      bank_code: bankCode,
      branch_code: branchCode,
      account_type_code: typeCode,
      account_number: acct.value,
      beneficiary_name: name.value,
    },
    errors: [],
    warnings,
  };
}

module.exports = {
  BENEFICIARY_NAME_MAX,
  toHalfWidthAlnum,
  hiraganaToKatakana,
  toHalfWidthKana,
  filterAllowedChars,
  normalizeBeneficiaryName,
  formatBankCode,
  formatBranchCode,
  formatAccountNumber,
  accountTypeCode,
  accountTypeLabel,
  maskAccountNumber,
  buildBeneficiary,
};

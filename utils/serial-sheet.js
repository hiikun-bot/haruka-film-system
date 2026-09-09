// utils/serial-sheet.js — ADR 038: ファイル名連番のスプレッドシート連動（純関数）
//
// - parseSerialCells(values): シート 1 列分の値配列から「先頭の数字列」を集計し、次の連番を返す
// - normalizeColumnLetter(s): 'a' / ' B ' / 'AA' → 'A' / 'B' / 'AA'（不正なら null）
// - resolveSerialDigits(project, template): 桁数の解決順「案件 → テンプレ → 3」
//
// Sheets API の呼び出しは sheets.js 側（readSheetColumn）。ここは I/O を持たない。

const DEFAULT_SERIAL_DIGITS = 3;

function _toDigits(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

/**
 * 桁数の解決: projects.serial_digits → filename_templates.serial_digits → 3
 * NULL / 不正値は「未設定」として次に送る。
 */
function resolveSerialDigits(project, template) {
  return _toDigits(project?.serial_digits)
    ?? _toDigits(template?.serial_digits)
    ?? DEFAULT_SERIAL_DIGITS;
}

/**
 * 列記号の正規化。A〜ZZZ のみ許可。
 */
function normalizeColumnLetter(s) {
  const v = String(s == null ? '' : s).trim().toUpperCase();
  return /^[A-Z]{1,3}$/.test(v) ? v : null;
}

/**
 * 列記号 → 0 始まりの index（A=0, B=1, ..., Z=25, AA=26）
 */
function columnLetterToIndex(letter) {
  const v = normalizeColumnLetter(letter);
  if (!v) return null;
  let n = 0;
  for (const ch of v) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * シートの値配列（values.get の 2 次元配列 or 1 次元配列）から連番を集計する。
 *
 * opts:
 *   numberIdx … 番号が入っている列の index（行配列内の位置。既定 0）
 *   usedIdx   … 「この列が空でない行だけを使用中とみなす」列の index（null = 判定しない）
 *               例) A 列「No」が 1〜300 まで事前採番されているシートで、B 列「CR名」が埋まっている行だけを数える
 *
 * ルール:
 *   - 各セルの文字列の先頭にある数字列（^\d+）を採用。'010' も '010_ネコ…png' も 10 として扱う
 *   - 数字で始まらないセル（見出し・空欄・'No.'）は無視
 *   - 数値セル（Sheets が number で返す 10 / 10.0）も対象
 *
 * 戻り値: { max, next, count, digitsHint, lastRaw }
 *   max        … 最大番号（数値セルが無ければ 0）
 *   next       … max + 1
 *   count      … 採用したセルの個数（usedIdx 指定時は「使用中」行の中の番号セル数）
 *   digitsHint … シート側がゼロ埋め（'010' など）されているときの最頻出桁数。素の数字だけなら null
 *   lastRaw    … 最大番号を持つセルの生の文字列（接続確認の表示用）
 */
function parseSerialCells(values, opts = {}) {
  const rows = Array.isArray(values) ? values : [];
  const numberIdx = Number.isInteger(opts.numberIdx) && opts.numberIdx >= 0 ? opts.numberIdx : 0;
  const usedIdx = Number.isInteger(opts.usedIdx) && opts.usedIdx >= 0 ? opts.usedIdx : null;
  let max = 0;
  let lastRaw = null;
  let count = 0;
  const widthFreq = new Map();
  for (const row of rows) {
    const cell = Array.isArray(row) ? row[numberIdx] : row;
    if (cell == null) continue;
    if (usedIdx != null) {
      const used = Array.isArray(row) ? row[usedIdx] : null;
      if (used == null || String(used).trim() === '') continue;
    }
    const str = String(cell).trim();
    const m = str.match(/^(\d+)/);
    if (!m) continue;
    const digitsStr = m[1];
    const n = Number(digitsStr);
    if (!Number.isFinite(n)) continue;
    count++;
    // ゼロ埋めされている（'010' → 10 の桁数 2 < 3）ときだけ桁数ヒントの材料にする
    if (digitsStr.length > String(n).length) {
      widthFreq.set(digitsStr.length, (widthFreq.get(digitsStr.length) || 0) + 1);
    }
    if (n > max) { max = n; lastRaw = str; }
  }
  let digitsHint = null;
  let best = 0;
  for (const [w, c] of widthFreq) {
    if (c > best || (c === best && w > (digitsHint || 0))) { best = c; digitsHint = w; }
  }
  return { max, next: max + 1, count, digitsHint, lastRaw };
}

module.exports = {
  DEFAULT_SERIAL_DIGITS,
  resolveSerialDigits,
  normalizeColumnLetter,
  columnLetterToIndex,
  parseSerialCells,
};

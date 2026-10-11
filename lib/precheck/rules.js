// lib/precheck/rules.js — シートの行を「ルール」に変換する（ADR 050 §2）
//
// 列: A No / B 対象ファイル / C 項目 / D 指摘内容 / E 備考 / F 判定方法 / G 誤 / H 正
// 読み込み（Google Sheets）と、純関数の parseRules / parseScheduleRow を分けてある。

const METHODS = ['辞書', '必須', 'AI', '映像', '人'];
const DELETE_MARK = /^[（(]\s*削除\s*[)）]$/;

function cell(row, i) {
  return String((row && row[i]) ?? '').trim();
}

// 「圧す／盛り土」→ ['圧す', '盛り土']。全角・半角のスラッシュどちらでも区切る
function splitPairs(text) {
  return String(text || '')
    .split(/[／/]/)
    .map(s => s.trim())
    .filter(Boolean);
}

// values: シートの 2 次元配列（1 行目は見出し）
function parseRules(values) {
  const rules = [];
  const rows = Array.isArray(values) ? values.slice(1) : [];
  for (const row of rows) {
    const no = Number(cell(row, 0));
    const detail = cell(row, 3);
    if (!Number.isFinite(no) || no <= 0 || !detail) continue;
    let method = cell(row, 5);
    if (!METHODS.includes(method)) method = 'AI'; // 選び忘れは AI として効かせる
    const wrong = splitPairs(cell(row, 6));
    const right = splitPairs(cell(row, 7));
    const pairs = method === '辞書'
      ? wrong.map((w, i) => {
        const r = right[i] ?? right[right.length - 1] ?? '';
        return { wrong: w, right: DELETE_MARK.test(r) ? '' : r, remove: DELETE_MARK.test(r) };
      })
      : [];
    rules.push({
      no,
      target: cell(row, 1),   // 動画編集 / サムネイル / キャプション文
      item: cell(row, 2),
      detail,
      note: cell(row, 4),
      method,
      pairs,
      required: method === '必須' ? right : [],
    });
  }
  return rules;
}

// 投稿予定一覧から管理番号の行を探し、AI に渡す「何の動画か」を返す
function parseScheduleRow(values, code) {
  if (!Array.isArray(values) || values.length < 2 || !code) return null;
  const header = values[0].map(h => String(h || '').replace(/\s+/g, ''));
  const col = name => header.indexOf(name);
  const codeCol = col('管理番号');
  if (codeCol < 0) return null;
  const row = values.slice(1).find(r => cell(r, codeCol) === code);
  if (!row) return null;
  const pick = name => (col(name) >= 0 ? cell(row, col(name)) : '');
  return {
    code,
    field: pick('区分'),
    grade: pick('等級'),
    exam: pick('試験区分'),
    subject: pick('試験内容'),
    title: pick('タイトル'),
    major: pick('大分類'),
    middle: pick('中分類'),
    minor: pick('小分類'),
    thumbnailTitle: pick('サムネタイトル'),
  };
}

// ==================== 読み込み（1 分キャッシュ） ====================
const CACHE_MS = 60 * 1000;
const _cache = new Map(); // key -> { at, value }

function sheetsClient() {
  const { google } = require('googleapis');
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readTabById(spreadsheetId, sheetId) {
  const key = `${spreadsheetId}:${sheetId}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const sheets = sheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const tab = (meta.data.sheets || []).find(s => s.properties.sheetId === sheetId);
  if (!tab) throw new Error(`シートのタブが見つかりません（sheetId=${sheetId}）`);
  const title = tab.properties.title.replace(/'/g, "''");
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'!A1:AZ5000` });
  const value = res.data.values || [];
  _cache.set(key, { at: Date.now(), value });
  return value;
}

async function loadRules(set) {
  return parseRules(await readTabById(set.spreadsheetId, set.rulesSheetId));
}

async function loadVideoInfo(set, code) {
  if (!code || !set.scheduleSheetId) return null;
  return parseScheduleRow(await readTabById(set.spreadsheetId, set.scheduleSheetId), code);
}

module.exports = { METHODS, splitPairs, parseRules, parseScheduleRow, loadRules, loadVideoInfo };

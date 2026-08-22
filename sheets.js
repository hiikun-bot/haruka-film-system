// sheets.js — Google Sheets連携（共有ドライブにシートを作成・読み込み）
const { google } = require('googleapis');

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

// 2D配列を受け取り、共有ドライブのルートに新規シート作成 → URL返却
async function createSheetWithData(title, rows) {
  const folderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!folderId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID が設定されていません');
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // Drive API でスプレッドシート(MIME) を共有ドライブ内に新規作成
  const file = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId],
    },
    supportsAllDrives: true,
    fields: 'id, webViewLink',
  });

  // データを書き込み
  if (rows && rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: file.data.id,
      range: 'A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }
  return { id: file.data.id, url: file.data.webViewLink };
}

// 個人所有シートへの出力: 1枚目シートを全消し→2D配列を書き込み（ヘッダー行固定＋太字）
// SAのマイドライブは保存容量0でシート新規作成が不可（quota exceeded）のため、
// マイゴール等の完全個人領域は「ユーザー所有のシートにSAが書き込む」方式をとる
async function overwriteFirstSheet(spreadsheetId, rows) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const first = meta.data.sheets?.[0]?.properties;
  if (!first) throw new Error('スプレッドシートにシートが存在しません');
  const range = `'${String(first.title).replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${range}!A:ZZ` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${range}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  // ヘッダー行を固定＋太字（失敗しても本体は成立しているので握りつぶす）
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { updateSheetProperties: { properties: { sheetId: first.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { repeatCell: { range: { sheetId: first.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        ],
      },
    });
  } catch (_) { /* 整形は任意 */ }
}

// SAのメールアドレス（ユーザーが自分のシートをSAに共有する際の案内用）
function getServiceAccountEmail() {
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}').client_email || null;
  } catch (_) {
    return null;
  }
}

// URLからspreadsheetIdを抽出
function extractSpreadsheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// シートID指定で1枚目シートの全データを2D配列で取得
async function readSheetData(spreadsheetId) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  // 最初のシート名を取得
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const firstSheet = meta.data.sheets?.[0]?.properties?.title;
  if (!firstSheet) throw new Error('スプレッドシートにシートが存在しません');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${firstSheet}!A:ZZ`,
  });
  return res.data.values || [];
}

module.exports = { createSheetWithData, overwriteFirstSheet, getServiceAccountEmail, extractSpreadsheetId, readSheetData };

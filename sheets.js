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
// format（任意）: { sheetTitle, fontSize, hideColumns: [列index], columnWidths: [px], zebra: true, dropdowns: [{ column, values }] }
// sheetTitle を渡すと1枚目タブの名前を「シート1」から付け替える（同名タブが他にあるときは衝突するので触らない）
// 再出力時も同じ見た目になるよう、ゼブラ（バンド）は既存を消してから貼り直す
// 0-origin の列indexをA1表記の列文字に変換（0→A, 25→Z, 26→AA）
function colLetter(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function overwriteFirstSheet(spreadsheetId, rows, format = {}) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title),bandedRanges(bandedRangeId),conditionalFormats)',
  });
  const firstSheet = meta.data.sheets?.[0];
  const first = firstSheet?.properties;
  if (!first) throw new Error('スプレッドシートにシートが存在しません');
  const range = `'${String(first.title).replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${range}!A:ZZ` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${range}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  // 日付列（format.dateColumns）はRAWだと文字列のままでカレンダー入力（日付ピッカー）が
  // 効かないため、該当列だけ USER_ENTERED で書き直して実際の日付セルにする。
  // 値は YYYY-MM-DD 形式の文字列（または空）である前提。
  for (const col of format.dateColumns || []) {
    const colValues = rows.slice(1).map(r => [r[col] ?? '']);
    if (!colValues.length) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${range}!${colLetter(col)}2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: colValues },
    });
  }
  // 整形（失敗しても本体データは成立しているので握りつぶす）
  try {
    const sheetId = first.sheetId;
    const numRows = rows.length;
    const numCols = rows[0]?.length || 0;
    const requests = [];
    // タブ名の付け替え（format.sheetTitle）: 「シート1」のままだと何のタブか分からないため
    // 他タブと同名になると batchUpdate 全体が失敗し整形まで巻き添えになるので、その場合はスキップ
    const wantTitle = String(format.sheetTitle || '').trim();
    if (wantTitle && wantTitle !== first.title) {
      const taken = (meta.data.sheets || []).some(s => s.properties?.sheetId !== sheetId && s.properties?.title === wantTitle);
      if (!taken) {
        requests.push({ updateSheetProperties: { properties: { sheetId, title: wantTitle }, fields: 'title' } });
      }
    }
    // 前回貼ったゼブラを削除（重複貼りはAPIエラーになる）
    for (const b of firstSheet.bandedRanges || []) {
      requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
    }
    // ヘッダー行固定
    requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    // 全体フォントサイズ
    if (format.fontSize) {
      requests.push({ repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numCols },
        cell: { userEnteredFormat: { textFormat: { fontSize: format.fontSize } } },
        fields: 'userEnteredFormat.textFormat.fontSize',
      } });
    }
    // ヘッダー行 太字
    requests.push({ repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    } });
    // 列幅
    for (let i = 0; i < (format.columnWidths || []).length; i++) {
      requests.push({ updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: format.columnWidths[i] },
        fields: 'pixelSize',
      } });
    }
    // 列の非表示（ID列など）
    for (const i of format.hideColumns || []) {
      requests.push({ updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      } });
    }
    // 中央揃え（format.centerColumns）: データ行全体に適用（後から追記する行にも効く）
    for (const col of format.centerColumns || []) {
      requests.push({ repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      } });
    }
    // 日付列（format.dateColumns）: yyyy-mm-dd 表示に固定（取込側のパーサと揃える）＋
    // 日付の入力規則を付与（セルをダブルクリックでカレンダー（日付ピッカー）が開く）
    for (const col of format.dateColumns || []) {
      requests.push({ repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
        fields: 'userEnteredFormat.numberFormat',
      } });
      requests.push({ setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: {
          condition: { type: 'DATE_IS_VALID' },
          strict: false, // 手入力の多少の揺れは取込側パーサが吸収するためブロックしない
          showCustomUi: true,
        },
      } });
    }
    // プルダウン（データ入力規則）: ヘッダーを除く列全体に適用（後から追記する行にも効く）
    for (const d of format.dropdowns || []) {
      requests.push({ setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: d.column, endColumnIndex: d.column + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: d.values.map(v => ({ userEnteredValue: v })) },
          strict: false, // 選択肢外は警告どまり（取込側でも警告して弾くため入力自体はブロックしない）
          showCustomUi: true,
        },
      } });
    }
    // ゼブラ表示（ヘッダー色つきバンド。データ行が無いときは貼らない）
    // format.zebra: true（従来の既定色）または { header, first, second }（0-1のRGBオブジェクト）で色指定
    if (format.zebra && numRows >= 2) {
      const z = (typeof format.zebra === 'object') ? format.zebra : {};
      requests.push({ addBanding: { bandedRange: {
        range: { sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numCols },
        rowProperties: {
          headerColor: z.header || { red: 0.835, green: 0.922, blue: 0.910 },   // 既定: 薄いティール（ブランド色系）
          firstBandColor: z.first || { red: 1, green: 1, blue: 1 },
          secondBandColor: z.second || { red: 0.957, green: 0.976, blue: 0.973 },
        },
      } } });
    }
    // 値→色の条件付き書式（ステータス等のチップ風配色）
    // format.valueColors: [{ column, colors: { '完了': { bg:{r,g,b}, fg:{r,g,b} }, ... } }]
    // 再出力でルールが積み重ならないよう、シートの既存ルールを全削除してから貼り直す
    // （このタブはエクスポートが全面上書きする前提の管理領域。手動で足したルールも消える点は仕様）
    if (format.valueColors && format.valueColors.length > 0) {
      const existingRules = (firstSheet.conditionalFormats || []).length;
      for (let i = 0; i < existingRules; i++) {
        requests.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
      }
      for (const vc of format.valueColors) {
        for (const [text, c] of Object.entries(vc.colors || {})) {
          requests.push({ addConditionalFormatRule: { rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: vc.column, endColumnIndex: vc.column + 1 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
              format: {
                backgroundColor: c.bg,
                textFormat: { foregroundColor: c.fg, bold: true },
              },
            },
          }, index: 0 } });
        }
      }
    }
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  } catch (e) { console.error('overwriteFirstSheet 整形スキップ:', e.message); }
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

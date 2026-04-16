// sheets.js — Google Sheets連携（未設定時はスキップ）
async function exportToSheets() { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON未設定'); }
async function importFromSheets() { return { imported: 0, feedbacks: [] }; }
module.exports = { exportToSheets, importFromSheets };

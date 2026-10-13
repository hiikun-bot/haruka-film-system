// 投稿前チェックの手元テスト用サーバー（ADR 050）。/api/precheck だけを立てる。
//   railway run node scripts/precheck-dev-server.js [port]
// 本番の DB・シート・Gemini を読む（書き込みはしない）。通知ワーカー等は起動しない。
const express = require('express');
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => { console.log(`[dev] ${req.method} ${req.path}`); next(); });
app.use('/api/precheck', require('../routes/precheck'));
const port = Number(process.argv[2]) || 3939;
app.listen(port, '127.0.0.1', () => console.log(`[dev] precheck server http://127.0.0.1:${port}`));

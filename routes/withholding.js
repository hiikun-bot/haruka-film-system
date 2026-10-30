// routes/withholding.js
// =============================================================
// 🧾 源泉徴収台帳 API（ADR 054 §5 Stage D）
//
// mount: server.js で app.use('/api/haruka/admin/withholding', require('./routes/withholding'))
//        を app.use('/api/haruka', harukaRouter) より前に置く。
//
// 権限（ADR 015）: requireAuth ＋ requirePermission('payout.page')（実効ロール・VIEW AS 追従）
//                 ＋ requireSuperAdmin（実ユーザーが SUPER_ADMIN_EMAILS の admin。X-View-As で昇格しない）。
//   VIEW AS で admin 以外を見ているときは requirePermission が 403 を返す。
//
// データ源: utils/withholding-ledger-source.js（payout_transfer_items ＋ payout_records → invoices 結合）
//   payout_transfer_items は Stage A 適用前の環境では存在しない → 空扱い＋ warnings で知らせる。
// 計算・シート行: utils/withholding-ledger.js（純関数・jest）
// 出力: sheets.js#createSheetWithTabs（共有ドライブに新規スプレッドシート・CSV は使わない）
//
// マイナンバーは扱わない（ADR 054 §5）。ログに住所・金額の明細を出さない。
// =============================================================

const express = require('express');
const { requireAuth, requirePermission, requireSuperAdmin } = require('../auth');
const { createSheetWithTabs } = require('../sheets');
const ledger = require('../utils/withholding-ledger');
const source = require('../utils/withholding-ledger-source');

const router = express.Router();
const guard = [requireAuth, requirePermission('payout.page'), requireSuperAdmin];

function parseYear(v) {
  const y = Number(v);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  return y;
}
function parseMonth(v) {
  const m = Number(v);
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  return m;
}

// API に返す行（内部用の usersById などは落とす）
function publicRow(r) {
  return {
    user_id: r.user_id,
    user_name: r.user_name,
    paid_date: r.paid_date,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number,
    source: r.source,
    tax_mode: r.tax_mode,
    subtotal: r.subtotal,
    tax: r.tax,
    withholding: r.withholding,
    gross: r.gross,
    net: r.net,
    paid_via: r.paid_via,
    paid_via_label: r.paid_via_label,
    apply_no: r.apply_no,
    payout_record_id: r.payout_record_id,
    transfer_item_id: r.transfer_item_id,
    from_snapshot: !!r.from_snapshot,
    extra_of_payout_record_id: r.extra_of_payout_record_id || null,
    needs_review: r.needs_review,
    review_reasons: r.review_reasons,
    notes: r.notes,
  };
}

// GET /summary?year&month … 支払月の 人数・支払金額（税込）・源泉徴収税額・差引支払額・要確認件数
router.get('/summary', ...guard, async (req, res) => {
  const year = parseYear(req.query.year);
  const month = parseMonth(req.query.month);
  if (!year || !month) return res.status(400).json({ error: 'year と month（1〜12）を指定してください' });
  try {
    const rep = await source.buildMonthReport(year, month);
    res.json({ year, month, summary: rep.summary, due: ledger.taxPaymentDueDate(year, month), due_date: ledger.taxPaymentDueDate(year, month).date, warnings: rep.warnings });
  } catch (e) {
    console.error('[withholding/summary]', e.message);
    res.status(500).json({ error: `源泉徴収の集計に失敗しました: ${e.message}` });
  }
});

// GET /ledger?year&month … 支払台帳（行）＋集計
router.get('/ledger', ...guard, async (req, res) => {
  const year = parseYear(req.query.year);
  const month = parseMonth(req.query.month);
  if (!year || !month) return res.status(400).json({ error: 'year と month（1〜12）を指定してください' });
  try {
    const rep = await source.buildMonthReport(year, month);
    res.json({
      year, month,
      rows: rep.rows.map(publicRow),
      summary: rep.summary,
      due: ledger.taxPaymentDueDate(year, month),            // { date, base, holiday_checked, shifted }（土日祝は翌営業日）
      due_date: ledger.taxPaymentDueDate(year, month).date,
      warnings: rep.warnings,
    });
  } catch (e) {
    console.error('[withholding/ledger]', e.message);
    res.status(500).json({ error: `支払台帳の取得に失敗しました: ${e.message}` });
  }
});

// GET /yearly?year … 支払調書用（支払先ごとの年間合計）
router.get('/yearly', ...guard, async (req, res) => {
  const year = parseYear(req.query.year);
  if (!year) return res.status(400).json({ error: 'year を指定してください' });
  try {
    const rep = await source.buildYearReport(year);
    res.json({ year, payees: rep.payees, summary: rep.summary, warnings: rep.warnings });
  } catch (e) {
    console.error('[withholding/yearly]', e.message);
    res.status(500).json({ error: `年間集計の取得に失敗しました: ${e.message}` });
  }
});

// POST /export-sheet { year, month? }
//   month あり … タブ「納付用 YYYY-MM」「支払台帳 YYYY-MM」
//   month なし … タブ「支払調書 YYYY」「支払台帳 YYYY」（年間の台帳）
router.post('/export-sheet', ...guard, async (req, res) => {
  const year = parseYear(req.body?.year);
  const hasMonth = req.body?.month != null && req.body.month !== '';
  const month = hasMonth ? parseMonth(req.body.month) : null;
  if (!year || (hasMonth && !month)) return res.status(400).json({ error: 'year（と month）を正しく指定してください' });
  try {
    const tabs = [];
    let title;
    let warnings = [];
    if (month) {
      const rep = await source.buildMonthReport(year, month);
      const ym = `${year}-${String(month).padStart(2, '0')}`;
      // 先頭: e-Tax「報酬・料金等の所得税徴収高計算書」に打ち込む順の転記用
      tabs.push({ title: `徴収高計算書 転記用 ${ym}`, rows: ledger.buildTaxPaymentFormRows(rep.summary, rep.rows, { year, month }) });
      tabs.push({ title: `納付用 ${ym}`, rows: ledger.buildMonthlySheetRows({ year, month, summary: rep.summary }) });
      tabs.push({ title: `支払台帳 ${ym}`, rows: ledger.buildLedgerSheetRows({ rows: rep.rows }) });
      title = `源泉徴収 ${year}年${month}月支払分（${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })} 出力）`;
      warnings = rep.warnings;
    } else {
      const rep = await source.buildYearReport(year);
      tabs.push({ title: `支払調書 ${year}`, rows: ledger.buildYearlySheetRows({ year, payees: rep.payees }) });
      tabs.push({ title: `支払台帳 ${year}`, rows: ledger.buildLedgerSheetRows({ rows: rep.rows }) });
      title = `源泉徴収 ${year}年 支払調書用（${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })} 出力）`;
      warnings = rep.warnings;
    }
    if (warnings.length) {
      // 先頭タブの末尾に注意書きを足す（税理士に渡したとき前提条件が分かるように）
      tabs[0].rows.push([], ...warnings.map(w => [`※ ${w}`]));
    }
    const { url } = await createSheetWithTabs(title, tabs);
    console.log(`[withholding/export-sheet] ${year}${month ? `-${month}` : ''} by user=${req.user?.id} → sheet created`);
    res.json({ url, tabs: tabs.map(t => t.title), warnings });
  } catch (e) {
    console.error('[withholding/export-sheet]', e.message);
    res.status(500).json({ error: `スプレッドシートの出力に失敗しました: ${e.message}` });
  }
});

module.exports = router;

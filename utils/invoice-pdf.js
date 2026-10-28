// utils/invoice-pdf.js — メンバー請求書（invoices.invoice_type != 'client'）の PDF 生成（ADR 047）
//
// 目的:
//   「＋ 今月の請求書を作成」で作った請求書を、画面の 🖨 PDF出力（window.print）と同じ見た目で
//   サーバー側でも PDF 化し、本人の Drive 請求書フォルダ（請求書/YYYY年/MM月/氏名 YYYY年MM月）へ
//   自動で置けるようにする。ブラウザ（headless Chrome）は使わず pdfkit で描画する。
//
// 構成:
//   buildInvoicePdfModel(inv, { now })  … invoices/:id の JSON → 描画用モデル（純関数・jest）
//   buildInvoicePdfFileName(inv, issuer) … Drive 上のファイル名（純関数・jest）
//   renderInvoicePdf(model, opts)       … モデル → PDF Buffer（pdfkit）
//
// 時刻は Railway (UTC) でも JST で表示する（feedback_time_logic_jst_explicit）。
// 金額の文字列は 振込管理 の自動抽出（utils/payout.js extractInvoiceAmount）が
// 「ご請求金額」直後の数字を拾う前提なので、見出しと金額を続けて描く。
// 新方式（tax_mode='exclusive'・ADR 046 Stage 4）は別レイアウト（buildExclusiveInvoicePdfModel /
// renderExclusiveInvoicePdf）。旧方式の描画は変えない（tests/utils/invoice-pdf-exclusive.test.js がハッシュで担保）。

const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSansJP-Regular.otf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSansJP-Bold.otf');
const LOGO_PATH = path.join(__dirname, '..', 'public', 'HARUKA FILM ロゴ.png');

const TEAL = '#2BB8B4';
const TEAL_LIGHT = '#e6f8f8';
const TEAL_PALE = '#f0fafa';
const GROUP_BG = '#f5fafa';
const GROUP_BORDER = '#cfe5e5';
const BORDER = '#dddddd';
const BORDER_SOFT = '#eeeeee';
const GRAY_BG = '#fafafa';

function fmtYen(n) {
  const v = Math.round(Number(n) || 0);
  return `¥${v.toLocaleString('ja-JP')}`;
}

// 'YYYY/MM/DD'（JST）。無効値は ''。
function formatJstDateSlash(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '/');
}

// 'YYYY年M月D日'（JST）
function formatJstDateLong(raw) {
  const d = raw ? new Date(raw) : new Date();
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' });
}

function sortItems(items) {
  return (items || []).slice().sort((a, b) => {
    const sa = a.sort_order ?? 0, sb = b.sort_order ?? 0;
    if (sa !== sb) return sa - sb;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

function lineAmount(it) {
  const qty = Number(it.quantity) || 0;
  const up = Number(it.unit_price) || 0;
  return (it.total_amount != null) ? Number(it.total_amount) || 0 : Math.round(qty * up);
}

// GET /invoices/:id の JSON（issuer / projects / invoice_items(creatives) 展開済み）から描画モデルを組む。
// 画面の printInvoice() と同じ規則:
//   - 内税: total_amount が税込、税抜小計 = floor(total / 1.1)、消費税 = total - 小計
//   - creative_id のある明細は creative 単位でグループ化（出現順）、無いものは「その他の明細」
//   - グループ見出しの日付は final_deadline → draft_deadline → updated_at の順
function buildInvoicePdfModel(inv, { now = new Date() } = {}) {
  if (!inv) throw new Error('invoice が空です');
  // ADR 046 Stage 4: 新方式（税抜＋源泉）は別レイアウト。旧方式（内税）は以下を 1 行も変えない
  if (inv.tax_mode === 'exclusive') return buildExclusiveInvoicePdfModel(inv, { now });
  const issuer = inv.issuer || {};
  const project = inv.projects || {};
  const client = project.clients || {};

  const total = Math.round(Number(inv.total_amount) || 0);
  // 整数演算で floor（27,500 / 1.1 が浮動小数で 24,999.99… になり 1 円ずれる問題を回避）
  const subtotal = Math.floor((total * 10) / 11);
  const tax = total - subtotal;

  const groups = [];
  const groupMap = new Map();
  const manualRows = [];
  for (const it of sortItems(inv.invoice_items)) {
    if (it.creative_id) {
      let g = groupMap.get(it.creative_id);
      if (!g) {
        const cr = it.creatives || {};
        const cp = cr.projects || project;
        const cc = (cp && cp.clients) || client;
        g = {
          creative_id: it.creative_id,
          label: it.creative_label || cr.file_name || '(無題)',
          date: formatJstDateSlash(cr.final_deadline || cr.draft_deadline || cr.updated_at) || '-',
          project_name: (cp && cp.name) || '',
          client_name: (cc && cc.name) || '',
          items: [],
        };
        groupMap.set(it.creative_id, g);
        groups.push(g);
      }
      g.items.push({
        label: it.label || '',
        unit: it.unit || '本',
        unit_price: Number(it.unit_price) || 0,
        amount: lineAmount(it),
      });
    } else {
      manualRows.push({
        label: it.label || '明細',
        unit: it.unit || '式',
        quantity: Number(it.quantity) || 0,
        unit_price: Number(it.unit_price) || 0,
        amount: lineAmount(it),
      });
    }
  }

  const bankLines = [
    issuer.bank_name ? `${issuer.bank_name}${issuer.bank_code ? ` (${issuer.bank_code})` : ''}` : '',
    issuer.branch_name ? `${issuer.branch_name}支店${issuer.branch_code ? ` (${issuer.branch_code})` : ''}` : '',
    (issuer.account_type && issuer.account_number) ? `${issuer.account_type} ${issuer.account_number}` : '',
    issuer.account_holder_kana ? `口座名義：${issuer.account_holder_kana}` : '',
  ].filter(Boolean);

  const issuerLines = [];
  if (issuer.email) issuerLines.push(String(issuer.email));
  if (issuer.phone) issuerLines.push(`TEL：${issuer.phone}`);
  if (issuer.postal_code || issuer.address) {
    issuerLines.push(`${issuer.postal_code ? `〒${issuer.postal_code}　` : ''}${issuer.address || ''}`.trim());
  }
  issuerLines.push(`登録番号：${issuer.invoice_registration_number || '—'}`);

  return {
    invoice_number: inv.invoice_number || '',
    issue_date: formatJstDateLong(inv.issued_at || now),
    period: `${inv.year || ''}年${inv.month || ''}月`,
    recipient: invoiceRecipient(inv.year, inv.month),
    issuer_name: issuer.full_name || '-',
    issuer_lines: issuerLines,
    total, subtotal, tax,
    groups,
    manual_rows: manualRows,
    bank_lines: bankLines,
    notes: inv.notes ? String(inv.notes) : '',
  };
}

// メンバー → HARUKA FILM の請求書の宛名。法人化（2026-09-22 設立）に合わせ、2026年10月分以降は法人宛て（会社名＋御中・個人名なし）。
// それより前の請求書は発行当時の宛名のまま（作り直しても過去分の PDF が変わらないように）。
const HOUJIN_RECIPIENT_FROM = 202610;
function invoiceRecipient(year, month) {
  const ym = (Number(year) || 0) * 100 + (Number(month) || 0);
  if (ym >= HOUJIN_RECIPIENT_FROM) return { company: '株式会社HARUKA FILM 御中', person: '' };
  return { company: 'HARUKA FILM', person: '高橋聖 様' };
}

// Drive 上のファイル名。画面の印刷タイトル「請求書_Y年M月_YYYYMMDD_高橋宛_氏名_番号」から
// 日付を抜いたもの（同じ請求書を作り直しても同名で上書きできるように、日付は入れない）。
function buildInvoicePdfFileName(inv, issuer) {
  const name = String((issuer && issuer.full_name) || (inv && inv.issuer && inv.issuer.full_name) || '不明')
    .replace(/\s+/g, '');
  const num = String((inv && inv.invoice_number) || 'INV').replace(/[\\/:*?"<>|]/g, '-');
  return `請求書_${inv.year || ''}年${inv.month || ''}月_高橋宛_${name}_${num}.pdf`;
}

function assetsAvailable() {
  return fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);
}

// モデル → PDF Buffer。pdfkit は遅延 require（テスト・起動時のコストを避ける）。
async function renderInvoicePdf(model, { logoPath = LOGO_PATH } = {}) {
  if (model && model.layout === 'exclusive') return renderExclusiveInvoicePdf(model, { logoPath });
  if (!assetsAvailable()) throw new Error('請求書PDF用フォント（assets/fonts/NotoSansJP-*.otf）が見つかりません');
  const PDFDocument = require('pdfkit');

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 44, left: 40, right: 40 },
    info: { Title: `請求書 ${model.invoice_number}`, Author: model.issuer_name, Creator: 'HARUKA FILM SYSTEM' },
    bufferPages: true,
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('jp', FONT_REGULAR);
  doc.registerFont('jpb', FONT_BOLD);
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const BOTTOM = doc.page.height - doc.page.margins.bottom;
  let y = doc.page.margins.top;

  const text = (str, x, yy, opts = {}) => {
    const { bold = false, size = 11, color = '#222', width, align = 'left', lineBreak = false } = opts;
    doc.font(bold ? 'jpb' : 'jp').fontSize(size).fillColor(color);
    doc.text(String(str ?? ''), x, yy, { width, align, lineBreak, ellipsis: lineBreak ? false : true });
  };
  const heightOf = (str, size, width, bold = false) => {
    doc.font(bold ? 'jpb' : 'jp').fontSize(size);
    return doc.heightOfString(String(str ?? ''), { width });
  };

  // ---------- ヘッダー ----------
  let logoDrawn = false;
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, L, y, { fit: [56, 56] }); logoDrawn = true; } catch (_) { /* ロゴ無しで続行 */ }
  }
  text('請 求 書', L + 200, y, { bold: true, size: 22, width: W - 200, align: 'right' });
  text(`No. ${model.invoice_number}`, L + 200, y + 32, { size: 10, color: '#666', width: W - 200, align: 'right' });
  text(`発行日：${model.issue_date}`, L + 200, y + 46, { size: 10, color: '#666', width: W - 200, align: 'right' });
  text(`対象期間：${model.period}`, L + 200, y + 60, { size: 10, color: '#666', width: W - 200, align: 'right' });
  y += Math.max(logoDrawn ? 56 : 0, 76) + 20;

  // ---------- 請求先 / 請求者 ----------
  const colW = (W - 24) / 2;
  const rx = L + colW + 24;
  text('請求先', L, y, { size: 9, color: '#999', width: colW });
  text('請求者', rx, y, { size: 9, color: '#999', width: colW, align: 'right' });
  doc.moveTo(L, y + 14).lineTo(L + colW, y + 14).lineWidth(0.5).strokeColor(BORDER_SOFT).stroke();
  doc.moveTo(rx, y + 14).lineTo(R, y + 14).lineWidth(0.5).strokeColor(BORDER_SOFT).stroke();
  let ly = y + 20;
  text(model.recipient.company, L, ly, { bold: true, size: 16, width: colW }); ly += 24;
  if (model.recipient.person) { text(model.recipient.person, L, ly, { size: 12, color: '#444', width: colW }); ly += 18; }
  let ry = y + 20;
  text(model.issuer_name, rx, ry, { bold: true, size: 14, width: colW, align: 'right' }); ry += 21;
  for (const line of model.issuer_lines) {
    const h = Math.max(13, heightOf(line, 9.5, colW));
    doc.font('jp').fontSize(9.5).fillColor('#666').text(line, rx, ry, { width: colW, align: 'right' });
    ry += h + 1;
  }
  y = Math.max(ly, ry) + 16;

  // ---------- ご請求金額 ----------
  doc.roundedRect(L, y, W, 54, 8).lineWidth(1.5).fillAndStroke(TEAL_PALE, TEAL);
  text('ご請求金額（税込・内税10%）', L + 20, y + 20, { size: 11, color: '#555', width: 260 });
  text(fmtYen(model.total), L + 200, y + 11, { bold: true, size: 26, color: TEAL, width: W - 220, align: 'right' });
  y += 54 + 22;

  // ---------- 明細テーブル ----------
  const COL = { price: 110, sub: 75, amt: 80 };
  COL.label = W - COL.price - COL.sub - COL.amt;
  const X = { label: L, price: L + COL.label, sub: L + COL.label + COL.price, amt: L + COL.label + COL.price + COL.sub };

  const drawTableHeader = () => {
    doc.rect(L, y, W, 26).fill(TEAL);
    text('品目（納品日 / クリエイティブごと）', X.label + 6, y + 7, { bold: true, size: 10.5, color: '#fff', width: COL.label - 12 });
    text('単価', X.price, y + 7, { bold: true, size: 10.5, color: '#fff', width: COL.price - 6, align: 'right' });
    text('小計', X.sub, y + 7, { bold: true, size: 10.5, color: '#fff', width: COL.sub - 6, align: 'right' });
    text('金額', X.amt, y + 7, { bold: true, size: 10.5, color: '#fff', width: COL.amt - 6, align: 'right' });
    y += 26;
  };
  // 残り高さが足りなければ改ページ。明細テーブルの途中なら新ページ先頭にヘッダー行を描き直す
  const ensureSpace = (h, { tableHeader = false } = {}) => {
    if (y + h <= BOTTOM) return;
    doc.addPage();
    y = doc.page.margins.top;
    if (tableHeader) drawTableHeader();
  };
  const cellBorders = (h, color) => {
    doc.lineWidth(0.5).strokeColor(color);
    doc.rect(L, y, W, h).stroke();
    for (const xx of [X.price, X.sub, X.amt]) doc.moveTo(xx, y).lineTo(xx, y + h).stroke();
  };

  drawTableHeader();
  let anyRow = false;

  for (const g of model.groups) {
    const headLine1 = `${g.date}    ${g.label}`;
    const sub = g.project_name ? `${g.project_name}${g.client_name ? ` / ${g.client_name}` : ''}` : '';
    const h1 = heightOf(headLine1, 10.5, W - 20, true);
    const h2 = sub ? heightOf(sub, 8.5, W - 20) : 0;
    const gh = 8 + h1 + (sub ? h2 + 2 : 0) + 8;
    ensureSpace(gh + 24, { tableHeader: true });
    doc.rect(L, y, W, gh).fillAndStroke(GROUP_BG, GROUP_BORDER);
    doc.font('jpb').fontSize(10.5).fillColor('#222266').text(g.date, L + 10, y + 8, { continued: true });
    doc.font('jpb').fontSize(10.5).fillColor('#222').text(`    ${g.label}`, { width: W - 20 });
    if (sub) doc.font('jp').fontSize(8.5).fillColor('#666').text(sub, L + 10, y + 8 + h1 + 2, { width: W - 20 });
    y += gh;
    for (const it of g.items) {
      const lh = Math.max(13, heightOf(it.label, 10, COL.label - 30));
      const rh = lh + 12;
      ensureSpace(rh, { tableHeader: true });
      cellBorders(rh, BORDER_SOFT);
      doc.font('jp').fontSize(10).fillColor('#222').text(it.label, X.label + 24, y + 6, { width: COL.label - 30 });
      text(`${fmtYen(it.unit_price)} / ${it.unit}`, X.price, y + 6, { size: 10, color: '#555', width: COL.price - 6, align: 'right' });
      text(fmtYen(it.unit_price), X.sub, y + 6, { size: 10, width: COL.sub - 6, align: 'right' });
      text(fmtYen(it.amount), X.amt, y + 6, { bold: true, size: 10, width: COL.amt - 6, align: 'right' });
      y += rh;
      anyRow = true;
    }
  }

  if (model.manual_rows.length) {
    ensureSpace(22 + 26, { tableHeader: true });
    doc.rect(L, y, W, 22).fillAndStroke(GRAY_BG, BORDER_SOFT);
    text('その他の明細', L + 10, y + 6, { bold: true, size: 9.5, color: '#888', width: W - 20 });
    y += 22;
    for (const it of model.manual_rows) {
      const lh = Math.max(13, heightOf(it.label, 10, COL.label - 12));
      const rh = lh + 14;
      ensureSpace(rh, { tableHeader: true });
      cellBorders(rh, BORDER_SOFT);
      doc.font('jp').fontSize(10).fillColor('#222').text(it.label, X.label + 6, y + 7, { width: COL.label - 12 });
      text(`${it.quantity} ${it.unit}`, X.price, y + 7, { size: 10, color: '#555', width: COL.price - 6, align: 'right' });
      text(fmtYen(it.unit_price), X.sub, y + 7, { size: 10, width: COL.sub - 6, align: 'right' });
      text(fmtYen(it.amount), X.amt, y + 7, { bold: true, size: 10, width: COL.amt - 6, align: 'right' });
      y += rh;
      anyRow = true;
    }
  }

  if (!anyRow) {
    ensureSpace(40, { tableHeader: true });
    doc.rect(L, y, W, 40).lineWidth(0.5).strokeColor(BORDER).stroke();
    text('明細なし', L, y + 13, { size: 10.5, color: '#aaa', width: W, align: 'center' });
    y += 40;
  }

  // 合計行
  const footRow = (label, value, { strong = false } = {}) => {
    const rh = strong ? 28 : 24;
    ensureSpace(rh, { tableHeader: true });
    doc.rect(L, y, W, rh).fillAndStroke(strong ? TEAL_LIGHT : GRAY_BG, strong ? TEAL : BORDER);
    doc.lineWidth(0.5).strokeColor(strong ? TEAL : BORDER).moveTo(X.amt, y).lineTo(X.amt, y + rh).stroke();
    text(label, L, y + (strong ? 8 : 7), { bold: strong, size: strong ? 11 : 10, width: COL.label + COL.price + COL.sub - 6, align: 'right' });
    text(value, X.amt, y + (strong ? 8 : 7), { bold: strong, size: strong ? 11 : 10, color: strong ? TEAL : '#222', width: COL.amt - 6, align: 'right' });
    y += rh;
  };
  footRow('税抜小計', fmtYen(model.subtotal));
  footRow('消費税（10%）', fmtYen(model.tax));
  footRow('合計（税込）', fmtYen(model.total), { strong: true });

  // ---------- 振込先 ----------
  const box = (title, lines, { warn = false } = {}) => {
    const lineH = 17;
    const bodyH = lines.reduce((s, l) => s + Math.max(lineH, heightOf(l, 10, W - 32) + 5), 0);
    const bh = 14 + 14 + bodyH + 10;
    y += 16;
    ensureSpace(bh);
    doc.roundedRect(L, y, W, bh, 6).lineWidth(0.5).fillAndStroke(GRAY_BG, BORDER);
    text(title, L + 16, y + 12, { bold: true, size: 9, color: '#999', width: W - 32 });
    let by = y + 30;
    for (const l of lines) {
      doc.font('jp').fontSize(10).fillColor(warn ? '#F59E0B' : '#222').text(l, L + 16, by, { width: W - 32 });
      by += Math.max(lineH, heightOf(l, 10, W - 32) + 5);
    }
    y += bh;
  };
  if (model.bank_lines.length) box('振込先', model.bank_lines);
  else box('振込先', ['⚠ 振込先が未設定です。メンバー設定から口座情報を登録してください。'], { warn: true });

  if (model.notes) {
    const noteLines = model.notes.split(/\r?\n/);
    box('備考', noteLines.length ? noteLines : ['']);
  }

  // ---------- フッター ----------
  y += 16;
  ensureSpace(24);
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#f0f0f0').stroke();
  text('※ お振込み手数料はご負担ください。　※ ご不明な点はご連絡ください。', L, y + 8, { size: 9, color: '#aaa', width: W });

  // ページ番号（2ページ以上のときだけ）
  // 下余白の中に描くので、pdfkit の自動改ページ（下余白より下に text すると addPage される）を
  // 一時的に無効化する（margins.bottom = 0）。これをしないとページ番号を描くたびに空ページが増える。
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('jp').fontSize(8.5).fillColor('#aaa')
        .text(`${model.invoice_number}　${i - range.start + 1} / ${range.count}`, L, doc.page.height - 28, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
  }

  doc.end();
  return done;
}

// =====================================================================
// ADR 046 Stage 4: 新方式（tax_mode='exclusive'・税抜＋源泉）の PDF
// =====================================================================
//
// レイアウトは請求書エディタの [PDFを見る]（public/js/invoice-editor.js preview()）と同じ並び:
//
//                          請 求 書               請求日 2026/10/31 / No. / お支払期限
//   株式会社HARUKA FILM 御中                       請求者（氏名・連絡先・登録番号）
//   件名：2026年10月分 制作費として
//   ┌ ご請求金額（税込）  ¥26,400 ┐
//   └ 差引お振込額        ¥23,950 ┘
//   No │ 納品日 │ 品目 │ 税抜単価 │ 数量 │ 税抜金額
//                    小計（税抜） / 消費税（10%） / ご請求金額（税込）
//                    源泉徴収税額（10.21%） / 差引お振込額
//   振込先 / 備考
//
// 金額は DB の保存値（提出時にサーバーが計算した subtotal_amount 等）を正とし、
// 欠けていれば utils/invoice-editor.js の computeTotals で明細から再計算する。
// 振込管理（utils/payout.js extractInvoiceAmount）は「差引お振込額」直後の金額を最優先で拾う。

function invoiceEditorCalc() {
  // 遅延 require（旧方式の PDF 生成では読み込まない）
  return require('./invoice-editor');
}

function isIntLike(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// 'YYYY-MM-DD' → 'YYYY/MM/DD'（エディタの longDate と同じ）
function slashLongDate(d) {
  return d ? String(d).replace(/-/g, '/') : '';
}

// 'YYYY-MM-DD' → 'MM/DD'（エディタの slashDate と同じ）
function slashShortDate(d) {
  return d ? `${String(d).slice(5, 7)}/${String(d).slice(8, 10)}` : '―';
}

function buildIssuerContactLines(issuer) {
  const lines = [];
  if (issuer.email) lines.push(String(issuer.email));
  if (issuer.phone) lines.push(`TEL：${issuer.phone}`);
  if (issuer.postal_code || issuer.address) {
    lines.push(`${issuer.postal_code ? `〒${issuer.postal_code}　` : ''}${issuer.address || ''}`.trim());
  }
  lines.push(`登録番号：${issuer.invoice_registration_number || '—'}`);
  return lines;
}

function buildBankLines(issuer) {
  return [
    issuer.bank_name ? `${issuer.bank_name}${issuer.bank_code ? ` (${issuer.bank_code})` : ''}` : '',
    issuer.branch_name ? `${issuer.branch_name}支店${issuer.branch_code ? ` (${issuer.branch_code})` : ''}` : '',
    (issuer.account_type && issuer.account_number) ? `${issuer.account_type} ${issuer.account_number}` : '',
    issuer.account_holder_kana ? `口座名義：${issuer.account_holder_kana}` : '',
  ].filter(Boolean);
}

function buildExclusiveInvoicePdfModel(inv, { now = new Date() } = {}) {
  const IE = invoiceEditorCalc();
  const issuer = inv.issuer || {};
  const items = sortItems(inv.invoice_items);
  const withholdingEnabled = inv.withholding_enabled !== false;

  // 明細（1 CR × 役割 = 1 行。HFS外・作業時間・分割の行もそのまま 1 行）
  const rows = items.map((it, i) => {
    const kind = IE.isCrLine(it) ? 'cr' : (IE.isFixedLine(it) ? 'fixed' : 'manual');
    const cr = it.creatives || {};
    const cp = cr.projects || null;
    const clientName = (cp && cp.clients && cp.clients.name) || '';
    let label;
    if (kind === 'cr') {
      const crLabel = it.creative_label || cr.file_name || '(無題)';
      label = IE.crItemLabel(clientName, crLabel, it.cost_type, it.label);
    } else if (kind === 'fixed') {
      label = it.creative_label || it.label || '';
    } else {
      label = it.label || '明細';
    }
    const hasPrice = !(it.unit_price === null || it.unit_price === undefined || it.unit_price === '');
    return {
      no: i + 1,
      kind,
      date: kind === 'cr' ? slashShortDate(IE.billingDateOf(cr, cp)) : '',
      label,
      unit_price: hasPrice ? Math.trunc(Number(it.unit_price) || 0) : null,
      quantity: kind === 'manual' ? (Math.trunc(Number(it.quantity)) || 0) : 1,
      amount: IE.lineAmount(it),
    };
  });

  // 金額: DB 保存値が揃っていればそれが正。欠けていれば明細から再計算
  const recalc = IE.computeTotals(items, { withholding_enabled: withholdingEnabled });
  const fromDb = ['subtotal_amount', 'tax_amount', 'total_amount', 'payout_amount'].every(k => isIntLike(inv[k]));
  const subtotal = fromDb ? Math.round(Number(inv.subtotal_amount)) : recalc.subtotal;
  const tax = fromDb ? Math.round(Number(inv.tax_amount)) : recalc.tax;
  const total = fromDb ? Math.round(Number(inv.total_amount)) : recalc.total;
  const payout = fromDb ? Math.round(Number(inv.payout_amount)) : recalc.payout;
  const withholding = fromDb
    ? (isIntLike(inv.withholding_amount) ? Math.round(Number(inv.withholding_amount)) : total - payout)
    : recalc.withholding;

  return {
    layout: 'exclusive',
    invoice_number: inv.invoice_number || '',
    invoice_date: slashLongDate(IE.invoiceDate(inv.year, inv.month)) || formatJstDateSlash(now),
    due_date: slashLongDate(IE.paymentDueDate(inv.year, inv.month)),
    period: `${inv.year || ''}年${inv.month || ''}月`,
    subject: `${inv.year || ''}年${inv.month || ''}月分 制作費として`,
    recipient: invoiceRecipient(inv.year, inv.month),
    issuer_name: issuer.full_name || '-',
    issuer_lines: buildIssuerContactLines(issuer),
    rows,
    subtotal, tax, total, withholding, payout,
    withholding_enabled: withholdingEnabled,
    withholding_over_limit: withholdingEnabled && subtotal > IE.WITHHOLDING_WARN_THRESHOLD,
    amounts_from: fromDb ? 'db' : 'recalc',
    bank_lines: buildBankLines(issuer),
    notes: inv.notes ? String(inv.notes) : '',
  };
}

async function renderExclusiveInvoicePdf(model, { logoPath = LOGO_PATH } = {}) {
  if (!assetsAvailable()) throw new Error('請求書PDF用フォント（assets/fonts/NotoSansJP-*.otf）が見つかりません');
  const PDFDocument = require('pdfkit');

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 44, left: 40, right: 40 },
    info: { Title: `請求書 ${model.invoice_number}`, Author: model.issuer_name, Creator: 'HARUKA FILM SYSTEM' },
    bufferPages: true,
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('jp', FONT_REGULAR);
  doc.registerFont('jpb', FONT_BOLD);
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const BOTTOM = doc.page.height - doc.page.margins.bottom;
  let y = doc.page.margins.top;

  // 1 行の text（折り返しなし・省略記号）。下余白を超える位置には描かない（ensureSpace で必ず改ページしてから呼ぶ）
  const text = (str, x, yy, opts = {}) => {
    const { bold = false, size = 11, color = '#222', width, align = 'left' } = opts;
    doc.font(bold ? 'jpb' : 'jp').fontSize(size).fillColor(color);
    doc.text(String(str ?? ''), x, yy, { width, align, lineBreak: false, ellipsis: true });
  };
  // 折り返しありの text（高さは heightOf で事前に測ってから ensureSpace する）
  const wrapText = (str, x, yy, opts = {}) => {
    const { bold = false, size = 10, color = '#222', width, align = 'left' } = opts;
    doc.font(bold ? 'jpb' : 'jp').fontSize(size).fillColor(color);
    doc.text(String(str ?? ''), x, yy, { width, align });
  };
  const heightOf = (str, size, width, bold = false) => {
    doc.font(bold ? 'jpb' : 'jp').fontSize(size);
    return doc.heightOfString(String(str ?? ''), { width });
  };

  // ---------- ヘッダー ----------
  let logoDrawn = false;
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, L, y, { fit: [56, 56] }); logoDrawn = true; } catch (_) { /* ロゴ無しで続行 */ }
  }
  text('請 求 書', L + 200, y, { bold: true, size: 22, width: W - 200, align: 'right' });
  text(`No. ${model.invoice_number}`, L + 200, y + 32, { size: 10, color: '#666', width: W - 200, align: 'right' });
  text(`請求日：${model.invoice_date}`, L + 200, y + 46, { size: 10, color: '#666', width: W - 200, align: 'right' });
  text(`お支払期限：${model.due_date}`, L + 200, y + 60, { size: 10, color: '#666', width: W - 200, align: 'right' });
  y += Math.max(logoDrawn ? 56 : 0, 76) + 20;

  // ---------- 請求先 / 請求者 ----------
  const colW = (W - 24) / 2;
  const rx = L + colW + 24;
  text('請求先', L, y, { size: 9, color: '#999', width: colW });
  text('請求者', rx, y, { size: 9, color: '#999', width: colW, align: 'right' });
  doc.moveTo(L, y + 14).lineTo(L + colW, y + 14).lineWidth(0.5).strokeColor(BORDER_SOFT).stroke();
  doc.moveTo(rx, y + 14).lineTo(R, y + 14).lineWidth(0.5).strokeColor(BORDER_SOFT).stroke();
  let ly = y + 20;
  text(model.recipient.company, L, ly, { bold: true, size: 16, width: colW }); ly += 24;
  if (model.recipient.person) { text(model.recipient.person, L, ly, { size: 12, color: '#444', width: colW }); ly += 18; }
  text(`件名：${model.subject}`, L, ly + 2, { size: 10.5, color: '#444', width: colW }); ly += 18;
  let ry = y + 20;
  text(model.issuer_name, rx, ry, { bold: true, size: 14, width: colW, align: 'right' }); ry += 21;
  for (const line of model.issuer_lines) {
    const h = Math.max(13, heightOf(line, 9.5, colW));
    wrapText(line, rx, ry, { size: 9.5, color: '#666', width: colW, align: 'right' });
    ry += h + 1;
  }
  y = Math.max(ly, ry) + 12;

  // ---------- ご請求金額（税込）／ 差引お振込額 ----------
  // 振込管理の金額抽出が「差引お振込額」→ 直後の金額 の並びで読めるよう、見出しと金額を同じ行に描く
  const boxH = 70;
  doc.roundedRect(L, y, W, boxH, 8).lineWidth(1.5).fillAndStroke(TEAL_PALE, TEAL);
  text('ご請求金額（税込）', L + 20, y + 14, { size: 11, color: '#555', width: 240 });
  text(fmtYen(model.total), L + 200, y + 10, { bold: true, size: 18, color: '#222', width: W - 220, align: 'right' });
  doc.moveTo(L + 16, y + 36).lineTo(R - 16, y + 36).lineWidth(0.5).strokeColor(GROUP_BORDER).stroke();
  text('差引お振込額', L + 20, y + 46, { bold: true, size: 11, color: '#555', width: 240 });
  text(fmtYen(model.payout), L + 200, y + 40, { bold: true, size: 20, color: TEAL, width: W - 220, align: 'right' });
  y += boxH + 16;

  // ---------- 明細テーブル ----------
  const COL = { no: 24, date: 42, price: 70, qty: 32, amt: 76 };
  COL.label = W - COL.no - COL.date - COL.price - COL.qty - COL.amt;
  const X = {};
  X.no = L; X.date = X.no + COL.no; X.label = X.date + COL.date; X.price = X.label + COL.label;
  X.qty = X.price + COL.price; X.amt = X.qty + COL.qty;
  const vlines = [X.date, X.label, X.price, X.qty, X.amt];

  const drawTableHeader = () => {
    doc.rect(L, y, W, 24).fill(TEAL);
    const hd = (s, x, w, align) => text(s, x + 3, y + 6, { bold: true, size: 9.5, color: '#fff', width: w - 6, align });
    hd('No', X.no, COL.no, 'center');
    hd('納品日', X.date, COL.date, 'center');
    hd('品目', X.label, COL.label, 'left');
    hd('税抜単価', X.price, COL.price, 'right');
    hd('数量', X.qty, COL.qty, 'center');
    hd('税抜金額', X.amt, COL.amt, 'right');
    y += 24;
  };
  const ensureSpace = (h, { tableHeader = false } = {}) => {
    if (y + h <= BOTTOM) return;
    doc.addPage();
    y = doc.page.margins.top;
    if (tableHeader) drawTableHeader();
  };

  drawTableHeader();
  for (const r of model.rows) {
    const labelH = Math.max(12, heightOf(r.label, 9.5, COL.label - 10));
    const rh = labelH + 10;
    ensureSpace(rh, { tableHeader: true });
    doc.lineWidth(0.5).strokeColor(BORDER_SOFT);
    if (r.kind === 'manual') doc.rect(L, y, W, rh).fillAndStroke('#f3f8ff', BORDER_SOFT);
    else doc.rect(L, y, W, rh).stroke();
    for (const xx of vlines) doc.moveTo(xx, y).lineTo(xx, y + rh).stroke();
    text(String(r.no), X.no + 2, y + 5, { size: 9.5, color: '#555', width: COL.no - 4, align: 'center' });
    text(r.date, X.date + 2, y + 5, { size: 9.5, color: '#555', width: COL.date - 4, align: 'center' });
    wrapText(r.label, X.label + 5, y + 5, { size: 9.5, width: COL.label - 10 });
    text(r.unit_price == null ? '' : fmtYen(r.unit_price), X.price + 3, y + 5, { size: 9.5, width: COL.price - 8, align: 'right' });
    text(String(r.quantity), X.qty + 2, y + 5, { size: 9.5, width: COL.qty - 4, align: 'center' });
    text(r.unit_price == null ? '' : fmtYen(r.amount), X.amt + 3, y + 5, { bold: true, size: 9.5, width: COL.amt - 8, align: 'right' });
    y += rh;
  }
  if (!model.rows.length) {
    ensureSpace(36, { tableHeader: true });
    doc.rect(L, y, W, 36).lineWidth(0.5).strokeColor(BORDER).stroke();
    text('明細なし', L, y + 11, { size: 10.5, color: '#aaa', width: W, align: 'center' });
    y += 36;
  }

  // ---------- 合計 ----------
  const sumX = L + W - 300;
  const sumRow = (label, value, { strong = false, color = '#222' } = {}) => {
    const rh = strong ? 24 : 20;
    ensureSpace(rh);
    doc.rect(sumX, y, 300, rh).lineWidth(0.5).fillAndStroke(strong ? TEAL_LIGHT : GRAY_BG, strong ? TEAL : BORDER);
    text(label, sumX + 10, y + 5, { bold: strong, size: strong ? 10.5 : 10, width: 170 });
    text(value, sumX + 170, y + 5, { bold: strong, size: strong ? 10.5 : 10, color, width: 120, align: 'right' });
    y += rh;
  };
  y += 8;
  sumRow('小計（税抜）', fmtYen(model.subtotal));
  sumRow('消費税（10%）', fmtYen(model.tax));
  sumRow('ご請求金額（税込）', fmtYen(model.total), { strong: true });
  sumRow('源泉徴収税額（10.21%）', model.withholding ? `-${fmtYen(model.withholding)}` : fmtYen(0));
  sumRow('差引お振込額', fmtYen(model.payout), { strong: true, color: TEAL });

  // ---------- 振込先・備考 ----------
  const box = (title, lines, { warn = false } = {}) => {
    const lineH = 17;
    const bodyH = lines.reduce((s, l) => s + Math.max(lineH, heightOf(l, 10, W - 32) + 5), 0);
    const bh = 14 + 14 + bodyH + 8;
    y += 12;
    ensureSpace(bh);
    doc.roundedRect(L, y, W, bh, 6).lineWidth(0.5).fillAndStroke(GRAY_BG, BORDER);
    text(title, L + 16, y + 12, { bold: true, size: 9, color: '#999', width: W - 32 });
    let by = y + 30;
    for (const l of lines) {
      wrapText(l, L + 16, by, { size: 10, color: warn ? '#F59E0B' : '#222', width: W - 32 });
      by += Math.max(lineH, heightOf(l, 10, W - 32) + 5);
    }
    y += bh;
  };
  if (model.bank_lines.length) box('振込先', model.bank_lines);
  else box('振込先', ['⚠ 振込先が未設定です。メンバー設定から口座情報を登録してください。'], { warn: true });
  if (model.notes) {
    const noteLines = model.notes.split(/\r?\n/);
    box('備考', noteLines.length ? noteLines : ['']);
  }

  // ---------- フッター ----------
  y += 16;
  ensureSpace(24);
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor('#f0f0f0').stroke();
  text('※ お振込み手数料はご負担ください。　※ ご不明な点はご連絡ください。', L, y + 8, { size: 9, color: '#aaa', width: W });

  // ページ番号（2ページ以上のときだけ）。下余白の中に描くので一時的に margins.bottom = 0
  // （pdfkit は下余白より下に text すると自動で addPage し、空ページが増える）
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('jp').fontSize(8.5).fillColor('#aaa')
        .text(`${model.invoice_number}　${i - range.start + 1} / ${range.count}`, L, doc.page.height - 28, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
  }

  doc.end();
  return done;
}

module.exports = {
  buildInvoicePdfModel,
  buildExclusiveInvoicePdfModel,
  renderExclusiveInvoicePdf,
  invoiceRecipient,
  buildInvoicePdfFileName,
  renderInvoicePdf,
  formatJstDateSlash,
  formatJstDateLong,
  assetsAvailable,
  FONT_REGULAR,
  FONT_BOLD,
  LOGO_PATH,
};

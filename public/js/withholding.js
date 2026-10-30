/* ============================================================
 * withholding.js — 🧾 源泉徴収（振込管理 #page-payout のモーダル modal-withholding）
 *   ADR 054（docs/design/decisions/054-aozora-bank-api-transfer.md）§5 Stage D。
 *
 *   公開 API（window）:
 *     openWithholdingModal()   振込管理ヘッダーの「🧾 源泉徴収」から。?withholding=YYYY-MM でも開く
 *
 *   権限（ADR 015）: 判定は hasPermission('payout.page')（VIEW AS 追従）。
 *   サーバー側は requirePermission('payout.page') ＋ requireSuperAdmin なので、
 *   VIEW AS で admin 以外のときは 403 が返る（ボタン自体も loadPayoutPage が隠す）。
 *   API 呼び出しは必ず apiFetch（X-View-As 付与）。マイナンバーは扱わない。
 * ============================================================ */
(function (window, document) {
  'use strict';

  const MODAL_ID = 'modal-withholding';
  const S = { year: null, month: null, yearly: null, loading: false, data: null };

  // haruka.html の const API（グローバル lexical・window には載らない）。未定義なら既定値
  /* global API, _poYear, _poMonth, currentUser */
  function api() { return (typeof API !== 'undefined' && API) ? API : '/api/haruka'; }
  function esc(v) { return (typeof window.esc === 'function') ? window.esc(v) : String(v ?? ''); }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type); }
  function yen(n) { return n == null || n === '' ? '—' : Number(n).toLocaleString('ja-JP'); }
  function can() { return typeof window.hasPermission === 'function' && window.hasPermission('payout.page'); }

  function jstNow() {
    const s = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    return { y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(5, 7), 10) };
  }

  function initPeriod() {
    if (S.year && S.month) return;
    // 振込管理で開いている月（_poYear/_poMonth）があればそれに合わせる。無ければ JST の前月（＝直近の納付対象）
    const py = (typeof _poYear !== 'undefined') ? _poYear : null;
    const pm = (typeof _poMonth !== 'undefined') ? _poMonth : null;
    if (Number.isInteger(py) && Number.isInteger(pm)) { S.year = py; S.month = pm; }
    else {
      const n = jstNow();
      S.year = n.m === 1 ? n.y - 1 : n.y;
      S.month = n.m === 1 ? 12 : n.m - 1;
    }
    S.yearly = S.year;
  }

  function monthOptions() {
    // 直近 24 か月
    const n = jstNow();
    const out = [];
    let y = n.y, m = n.m;
    for (let i = 0; i < 24; i++) {
      out.push({ y, m });
      m -= 1; if (m < 1) { m = 12; y -= 1; }
    }
    if (!out.some(o => o.y === S.year && o.m === S.month)) out.push({ y: S.year, m: S.month });
    return out;
  }

  function yearOptions() {
    const n = jstNow();
    const ys = [];
    for (let y = n.y; y >= n.y - 4; y--) ys.push(y);
    if (!ys.includes(S.yearly)) ys.push(S.yearly);
    return ys;
  }

  function shell() {
    const months = monthOptions().map(o =>
      `<option value="${o.y}-${o.m}" ${o.y === S.year && o.m === S.month ? 'selected' : ''}>${o.y}年${o.m}月</option>`).join('');
    const years = yearOptions().map(y => `<option value="${y}" ${y === S.yearly ? 'selected' : ''}>${y}年</option>`).join('');
    return `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <label style="font-size:13px">対象月
          <select class="form-input" id="wh-month" style="width:auto;margin-left:6px" onchange="window.__whChangeMonth(this.value)">${months}</select>
        </label>
        <button class="btn-sm" id="wh-export-month" onclick="window.__whExport('month')">📊 スプレッドシートに出力</button>
        <span style="font-size:11px;color:var(--text-muted)">納付用＋支払台帳の2タブ</span>
        <button class="btn-sm" style="margin-left:auto" onclick="window.__whReload()">🔄 再読込</button>
      </div>
      <div id="wh-warn"></div>
      <div id="wh-summary" style="margin-bottom:10px"></div>
      <div class="card" style="padding:0;overflow-x:auto"><div id="wh-table"></div></div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;padding-top:10px;border-top:0.5px solid var(--border)">
        <label style="font-size:13px">年間
          <select class="form-input" id="wh-year" style="width:auto;margin-left:6px" onchange="window.__whChangeYear(this.value)">${years}</select>
        </label>
        <button class="btn-sm" id="wh-export-year" onclick="window.__whExport('year')">📊 支払調書用を出力</button>
        <span style="font-size:11px;color:var(--text-muted)">※ マイナンバーは扱いません（支払調書の提出時に税理士側で別管理）。納期の特例の適用可否も税理士に確認してください。</span>
      </div>`;
  }

  function renderSummary(d) {
    const s = d.summary || {};
    const review = s.needs_review_count
      ? `<span style="color:#C0392B;font-weight:700">⚠ 要確認 ${s.needs_review_count}件</span>`
      : '<span style="color:var(--text-muted)">要確認なし</span>';
    return `
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;align-items:baseline">
        <span>人数 <strong>${yen(s.payee_count)}</strong>名（${yen(s.payment_count)}件）</span>
        <span>支払金額(税込) <strong>${yen(s.gross_total)}</strong></span>
        <span>源泉徴収税額 <strong style="font-size:15px">${yen(s.withholding_total)}</strong></span>
        <span>差引支払額 <strong>${yen(s.net_total)}</strong></span>
        <span>${review}</span>
        <span style="color:var(--text-muted);font-size:12px">納付期限 ${esc(d.due_date || '')}</span>
      </div>`;
  }

  function renderTable(rows) {
    if (!rows || !rows.length) {
      return '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">この月に支払日（振込完了）のある記録はありません</div>';
    }
    const th = ['支払日', '氏名', '請求書', '税抜', '消費税', '源泉', '差引', '経路', ''];
    const head = th.map(h => `<th>${h}</th>`).join('');
    const body = rows.map(r => {
      const d = r.paid_date ? r.paid_date.slice(5).replace('-', '/') : '—';
      const inv = r.invoice_number ? esc(r.invoice_number) : '<span style="color:var(--text-muted)">なし</span>';
      const tip = [...(r.review_reasons || []), ...(r.notes || [])].join(' / ');
      const flag = r.needs_review ? `<span title="${esc(tip)}" style="color:#C0392B;font-weight:700;cursor:help">⚠</span>`
        : (tip ? `<span title="${esc(tip)}" style="color:var(--text-muted);cursor:help">ⓘ</span>` : '');
      const via = r.paid_via === 'aozora_api' ? `API${r.apply_no ? `<div style="font-size:10px;color:var(--text-muted)">${esc(r.apply_no)}</div>` : ''}` : '手動';
      const num = (v) => `<td style="text-align:right;font-variant-numeric:tabular-nums">${yen(v)}</td>`;
      return `<tr${r.needs_review ? ' style="background:#fff8e1"' : ''}>
        <td>${esc(d)}</td><td>${esc(r.user_name || '')}</td><td>${inv}</td>
        ${num(r.subtotal)}${num(r.tax)}${num(r.withholding)}${num(r.net)}
        <td>${via}</td><td>${flag}</td></tr>`;
    }).join('');
    return `<table class="po-tbl" style="min-width:760px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderWarnings(ws) {
    if (!ws || !ws.length) return '';
    return `<div style="font-size:12px;color:#8a6d3b;background:#fcf8e3;border:0.5px solid #faebcc;border-radius:6px;padding:6px 10px;margin-bottom:8px">${ws.map(w => `※ ${esc(w)}`).join('<br>')}</div>`;
  }

  async function load() {
    const body = document.getElementById('wh-body');
    if (!body) return;
    if (!can()) {
      body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px">この機能を使う権限がありません</div>';
      return;
    }
    if (!document.getElementById('wh-table')) body.innerHTML = shell();
    const tbl = document.getElementById('wh-table');
    const sum = document.getElementById('wh-summary');
    const warn = document.getElementById('wh-warn');
    if (S.loading) return;
    S.loading = true;
    sum.innerHTML = '<div class="skel-line" style="width:50%"></div>';
    tbl.innerHTML = '<div style="padding:8px 20px 16px">' + [1, 2, 3].map(() => '<div class="skel-row"><span class="skel-circle"></span><span class="skel-line"></span></div>').join('') + '</div>';
    try {
      const res = await window.apiFetch(`${api()}/admin/withholding/ledger?year=${S.year}&month=${S.month}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '源泉徴収の集計に失敗しました');
      S.data = data;
      warn.innerHTML = renderWarnings(data.warnings);
      sum.innerHTML = renderSummary(data);
      tbl.innerHTML = renderTable(data.rows);
    } catch (e) {
      console.error('[withholding]', e);
      sum.innerHTML = '';
      tbl.innerHTML = `<div style="padding:24px;text-align:center;color:#C0392B;font-size:13px">${esc(e.message)}</div>`;
      toast(e.message, 'error');
    } finally {
      S.loading = false;
    }
  }

  async function exportSheet(kind) {
    if (!can()) return;
    const btn = document.getElementById(kind === 'year' ? 'wh-export-year' : 'wh-export-month');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'スプレッドシート作成中…'; }
    try {
      const payload = kind === 'year' ? { year: S.yearly } : { year: S.year, month: S.month };
      const res = await window.apiFetch(`${api()}/admin/withholding/export-sheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '出力に失敗しました');
      if (data.url) {
        window.open(data.url, '_blank', 'noopener');
        toast(`スプレッドシートに出力しました（${(data.tabs || []).join(' / ')}）`, 'success');
      } else {
        toast('スプレッドシートURLを取得できませんでした', 'error');
      }
    } catch (e) {
      toast('出力失敗: ' + (e?.message || e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  function open(initial) {
    if (!can()) { toast('この機能を使う権限がありません', 'error'); return; }
    if (initial && /^\d{4}-\d{1,2}$/.test(initial)) {
      const [y, m] = initial.split('-').map(Number);
      if (y && m >= 1 && m <= 12) { S.year = y; S.month = m; S.yearly = y; }
    }
    initPeriod();
    const body = document.getElementById('wh-body');
    if (body) body.innerHTML = shell();
    if (typeof window.openModal === 'function') window.openModal(MODAL_ID);
    load();
  }

  window.openWithholdingModal = open;
  window.__whChangeMonth = function (v) {
    const [y, m] = String(v).split('-').map(Number);
    if (!y || !m) return;
    S.year = y; S.month = m;
    load();
  };
  window.__whChangeYear = function (v) { S.yearly = Number(v) || S.yearly; };
  window.__whExport = exportSheet;
  window.__whReload = load;

  // ディープリンク: haruka.html?page=payout&withholding=YYYY-MM（月初リマインドの「台帳・出力」から）
  try {
    const q = new URLSearchParams(window.location.search);
    const wh = q.get('withholding');
    if (wh) {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        const ready = typeof window.hasPermission === 'function'
          && (typeof currentUser !== 'undefined' && currentUser)
          && document.getElementById('page-payout')?.classList.contains('active');
        if (ready || tries > 40) {
          clearInterval(t);
          if (ready) open(wh);
        }
      }, 500);
    }
  } catch (_) { /* no-op */ }
})(window, document);

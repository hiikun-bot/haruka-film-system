// public/js/invoice-editor.js
// 🧾 請求書エディタ（ADR 046 Stage 3・税抜＋源泉）。
//   (a) 「＋ 今月の請求書を作成」モーダルの一覧（新方式の月だけ。旧方式の月は haruka.html の従来描画のまま）
//   (b) 全画面エディタ（1 CR × 役割 = 1 行・単価は空欄から・参考単価・自動保存 1.5 秒・提出はサーバー再チェック）
// 計算・判定は utils/invoice-editor.js（/js/invoice-editor-calc.js → window.InvoiceEditorCalc）をサーバーと共有する。
// haruka.html のグローバル（API / apiFetch / showToast / esc / openModal / closeModal / loadMyInvoices /
// notifyInvoiceDrivePdfResult）を使う。本人のデータだけを扱う（issuer_id は送らない＝VIEW AS 中もログイン本人）。
(function () {
  'use strict';

  const C = () => window.InvoiceEditorCalc;
  const THUMB_KEY = 'hfs.invoiceEditor.thumbs';
  const SAVE_DELAY_MS = 1500;
  const PASTE_COLS = ['label', 'price', 'qty', 'reason']; // 貼り付けの列順（Excel の 品目→単価→数量→理由。行に在るものだけ）

  const yen = (n) => (Number(n) || 0).toLocaleString('ja-JP');
  const h = (v) => (typeof esc === 'function' ? esc(v) : String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const slashDate = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : '―');
  const longDate = (d) => (d ? d.replace(/-/g, '/') : '―');
  const jstHm = (iso) => {
    try { return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode 等 */ } }

  // ======================================================================
  // (a) 請求書作成モーダル（新方式の月）
  // ======================================================================
  const cand = { active: false, year: null, month: null, data: null, seq: 0 };

  function thumbsOn() { return lsGet(THUMB_KEY) === '1'; }

  function setFooterMode(exclusive) {
    const totalBox = document.getElementById('gi-total-box');
    const thumbBox = document.getElementById('gi-thumb-toggle-wrap');
    if (totalBox) totalBox.style.display = exclusive ? 'none' : '';
    if (thumbBox) thumbBox.style.display = exclusive ? '' : 'none';
    const sel = document.getElementById('gi-selected-count');
    if (sel) sel.style.display = exclusive ? '' : 'none';
  }

  /**
   * 新方式の月なら一覧を描画して true。旧方式の月なら false（呼び出し側が従来の描画を続ける）。
   * 通信エラーのときも false（従来の画面で作れるように）。
   */
  async function tryRenderCandidates(year, month) {
    const seq = ++cand.seq;
    cand.active = false;
    let data;
    try {
      const res = await apiFetch(`${API}/invoice-editor/candidates?year=${year}&month=${month}${thumbsOn() ? '&with_thumbs=1' : ''}`);
      if (!res.ok) { setFooterMode(false); return false; }
      data = await res.json();
    } catch (_) { setFooterMode(false); return false; }
    if (seq !== cand.seq) return true; // 後から別の月が選ばれた（そちらの描画に任せる）
    if (!data || data.mode !== 'exclusive') { setFooterMode(false); return false; }
    cand.active = true; cand.year = year; cand.month = month; cand.data = data;
    setFooterMode(true);
    const tg = document.getElementById('gi-thumb-toggle');
    if (tg) tg.checked = thumbsOn();
    renderCandidates();
    return true;
  }

  function renderCandidates() {
    const wrap = document.getElementById('gi-table-wrap');
    const d = cand.data;
    if (!wrap || !d) return;
    const showThumb = thumbsOn();
    const billable = d.items.filter(i => i.kind !== 'undelivered');
    const undelivered = d.items.filter(i => i.kind === 'undelivered');
    const total = billable.length + d.hourly.length + d.installments.length;
    if (!total && !undelivered.length) {
      wrap.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px">${d.year}年${d.month}月に請求できるものはありません</div>`;
      updateCandidateCount();
      return;
    }
    const thumbCell = (it) => showThumb
      ? `<td class="ie-c-thumb">${it.thumb_file_id ? `<img loading="lazy" decoding="async" src="${API}/portfolio/thumbnail/${encodeURIComponent(it.thumb_file_id)}?s=120" alt="" onerror="this.style.display='none'">` : ''}</td>`
      : '';
    const roleText = (it) => it.roles.map(r => r.label).join('・');
    const crRow = (it, disabled) => `
      <tr class="${disabled ? 'ie-c-disabled' : ''}">
        <td class="ie-c-check"><input type="checkbox" class="ie-cand-check" data-kind="cr" data-id="${h(it.creative_id)}" ${disabled ? 'disabled' : 'checked'} onchange="HFSInvoiceEditor._updateCandidateCount()"></td>
        <td class="ie-c-date">${disabled ? '―' : slashDate(it.billing_date)}</td>
        ${thumbCell(it)}
        <td>
          <div class="ie-c-sub">${h(it.client_name)}${it.project_name ? ' / ' + h(it.project_name) : ''}${it.kind === 'previous' ? ' <span class="ie-badge-prev">前月・未請求</span>' : ''}${disabled ? ` <span class="ie-badge-status">${h(it.status || '未納品')}</span>` : ''}</div>
          <div class="ie-c-file">${h(it.file_name)} <span class="ie-c-role">${h(roleText(it))}</span></div>
        </td>
        <td class="ie-c-view"><a href="/haruka.html?creative=${encodeURIComponent(it.creative_id)}" target="_blank" rel="noopener" title="クリエイティブ詳細を別タブで開く">🔗</a></td>
      </tr>`;
    const fixedRow = (key, kind, label, amount, tag) => `
      <tr>
        <td class="ie-c-check"><input type="checkbox" class="ie-cand-check" data-kind="${kind}" data-key="${h(key)}" checked onchange="HFSInvoiceEditor._updateCandidateCount()"></td>
        <td class="ie-c-date">―</td>
        ${showThumb ? '<td class="ie-c-thumb"></td>' : ''}
        <td><div class="ie-c-sub">${tag}</div><div class="ie-c-file">${h(label)}（${yen(amount)}円）</div></td>
        <td></td>
      </tr>`;
    wrap.innerHTML = `
      <table class="ie-cand-table">
        <thead><tr>
          <th class="ie-c-check"><input type="checkbox" id="ie-cand-all" checked onchange="HFSInvoiceEditor._toggleAllCandidates(this.checked)"></th>
          <th class="ie-c-date">納品日</th>
          ${showThumb ? '<th class="ie-c-thumb"></th>' : ''}
          <th>ファイル名</th>
          <th class="ie-c-view">見る</th>
        </tr></thead>
        <tbody>
          ${billable.map(it => crRow(it, false)).join('')}
          ${d.hourly.map(x => fixedRow(x.hourly_key, 'hourly', x.label, x.total, `⏱ 作業時間報告（${d.month}月）`)).join('')}
          ${d.installments.map(x => fixedRow(x.installment_key, 'installment', x.label, x.total, '📅 一式（分割支払）')).join('')}
          ${undelivered.length ? `<tr class="ie-c-sep"><td colspan="${showThumb ? 5 : 4}">未納品（請求できません）</td></tr>` + undelivered.map(it => crRow(it, true)).join('') : ''}
        </tbody>
      </table>`;
    if (typeof applyInvoiceSearch === 'function') applyInvoiceSearch();
    updateCandidateCount();
  }

  function updateCandidateCount() {
    const n = document.querySelectorAll('.ie-cand-check:checked:not(:disabled)').length;
    const el = document.getElementById('gi-selected-count');
    if (el) el.textContent = `${n} 件を選択中`;
    const btn = document.getElementById('gi-submit-btn');
    if (btn) { btn.disabled = n === 0; btn.style.opacity = n === 0 ? '0.5' : '1'; btn.title = ''; }
  }

  function toggleAllCandidates(checked) {
    // 絞り込み中は表示されている行だけ（隠れている行のチェックは触らない）
    document.querySelectorAll('.ie-cand-check:not(:disabled)').forEach(cb => {
      if (cb.closest('tr')?.style.display === 'none') return;
      cb.checked = checked;
    });
    updateCandidateCount();
  }

  async function onThumbToggle(on) {
    lsSet(THUMB_KEY, on ? '1' : '0');
    if (!cand.active) return;
    // サムネ ID は ON のときだけサーバーに取りに行く（OFF なら今までどおりの軽さ）
    if (on && cand.data && !cand.data.items.some(i => i.thumb_file_id)) {
      const checked = new Set([...document.querySelectorAll('.ie-cand-check:checked')].map(cb => cb.dataset.id || cb.dataset.key));
      await tryRenderCandidates(cand.year, cand.month);
      document.querySelectorAll('.ie-cand-check:not(:disabled)').forEach(cb => { cb.checked = checked.has(cb.dataset.id || cb.dataset.key); });
      updateCandidateCount();
      return;
    }
    renderCandidates();
  }

  async function createDraftFromModal() {
    const checked = [...document.querySelectorAll('.ie-cand-check:checked:not(:disabled)')];
    if (!checked.length) { showToast('請求するものを 1 件以上選んでください', 'warn'); return; }
    const body = {
      year: cand.year, month: cand.month,
      creative_ids: checked.filter(cb => cb.dataset.kind === 'cr').map(cb => cb.dataset.id),
      hourly_keys: checked.filter(cb => cb.dataset.kind === 'hourly').map(cb => cb.dataset.key),
      installment_keys: checked.filter(cb => cb.dataset.kind === 'installment').map(cb => cb.dataset.key),
      notes: (document.getElementById('gi-notes')?.value || '').trim() || null,
    };
    const btn = document.getElementById('gi-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '作成中...'; }
    let res, data = {};
    try {
      res = await apiFetch(`${API}/invoice-editor/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      data = await res.json().catch(() => ({}));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '請求書を作成する'; }
    }
    if (!res || !res.ok) {
      const detail = Array.isArray(data.problems) && data.problems.length ? `（${data.problems.slice(0, 3).map(p => p.message).join(' / ')}）` : '';
      showToast(`${data.error || '作成に失敗しました'}${detail}`, 'error');
      if (res && res.status === 409) tryRenderCandidates(cand.year, cand.month);
      return;
    }
    closeModal('modal-gen-invoice');
    showToast(`請求書 ${data.invoice_number} を作りました。単価を入れて提出してください`, 'success');
    if (typeof loadMyInvoices === 'function') loadMyInvoices();
    open(data.id);
  }

  // ======================================================================
  // (b) 請求書エディタ（全画面）
  // ======================================================================
  const ed = {
    id: null, state: null, rows: [], updatedAt: null, withholding: true, notes: '',
    timer: null, saving: null, dirty: false, conflict: false, problems: new Map(), keySeq: 0, lastSavedAt: null,
  };

  function overlay() {
    let el = document.getElementById('ie-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ie-overlay';
      el.className = 'ie-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      document.body.appendChild(el);
      el.addEventListener('keydown', onKeyDown);
      el.addEventListener('paste', onPaste);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
    }
    return el;
  }

  async function open(id) {
    const el = overlay();
    el.innerHTML = '<div class="ie-loading">読み込み中…</div>';
    el.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    const res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.style.display = 'none';
      document.body.style.overflow = '';
      showToast(data.error || '請求書の取得に失敗しました', 'error');
      return;
    }
    ed.id = id;
    ed.state = data;
    ed.rows = data.items.map(it => ({ ...it, _key: `k${++ed.keySeq}`, _sel: false }));
    ed.updatedAt = data.invoice.updated_at;
    ed.withholding = !!data.invoice.withholding_enabled;
    ed.notes = data.invoice.notes || '';
    ed.dirty = false; ed.conflict = false; ed.problems = new Map(); ed.lastSavedAt = null;
    render();
    const first = el.querySelector('input.ie-in[data-col="price"]:not([disabled])');
    if (first) first.focus();
  }

  function editable() { return !!(ed.state && ed.state.editable) && !ed.conflict; }

  function totals() { return C().computeTotals(ed.rows, { withholding_enabled: ed.withholding }); }

  function rowIssues(r) {
    const local = C().lineIssues(r, r.kind === 'cr' ? r.ref_price : null);
    const srv = r.id ? (ed.problems.get(r.id) || []) : [];
    const seen = new Set(local.map(i => i.code));
    return local.concat(srv.filter(p => !seen.has(p.code)));
  }

  function statusText() {
    const inv = ed.state.invoice;
    const st = { draft: '下書き', rejected: '差し戻し', submitted: '提出済み', approved: '承認済み' }[inv.status] || inv.status;
    if (ed.conflict) return `${st}・<span class="ie-st-ng">別の画面で更新されています</span>`;
    if (!ed.state.editable) return st;
    if (ed.saving) return `${st}・保存中…`;
    if (ed.dirty) return `${st}・未保存`;
    return `${st}・保存済み${ed.lastSavedAt ? ' ' + jstHm(ed.lastSavedAt) : ''}`;
  }

  function render() {
    const el = overlay();
    const s = ed.state;
    const inv = s.invoice;
    const canEdit = editable();
    const t = totals();
    const dis = canEdit ? '' : 'disabled';
    el.innerHTML = `
      <div class="ie-panel">
        <div class="ie-head">
          <div class="ie-title">請求書 ${h(inv.invoice_number)}<span class="ie-status" id="ie-status">（${statusText()}）</span></div>
          <button type="button" class="ie-close" onclick="HFSInvoiceEditor.close()" title="閉じる（入力中の内容は保存されます）">×</button>
        </div>
        ${ed.conflict ? `<div class="ie-banner">別の画面でこの請求書が更新されました。上書きしないよう保存を止めています。 <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.reload()">再読み込み</button></div>` : ''}
        ${inv.status === 'rejected' && inv.rejection_reason ? `<div class="ie-banner ie-banner-ng">差し戻し理由: ${h(inv.rejection_reason)}</div>` : ''}
        <div class="ie-meta">
          <div><b>${h(s.recipient)}</b></div>
          <div>請求者 ${h(s.issuer.full_name)}${s.issuer.invoice_registration_number ? ` / 登録番号 ${h(s.issuer.invoice_registration_number)}` : ''}</div>
          <div>${inv.year}年${inv.month}月分　請求日 ${longDate(s.invoice_date)}　お支払期限 ${longDate(s.due_date)}</div>
          <label>源泉徴収
            <select id="ie-wh" ${dis}>
              <option value="1" ${ed.withholding ? 'selected' : ''}>あり</option>
              <option value="0" ${ed.withholding ? '' : 'selected'}>なし</option>
            </select>
          </label>
        </div>
        ${canEdit ? `
        <div class="ie-toolbar">
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.fillRef()" title="選んだ行（選んでいなければ単価が空の行全部）に参考単価を入れます">参考単価を入れる</button>
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.bulkPrice()" title="選んだ行に同じ単価を入れます">単価をまとめて入力</button>
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.addManual()">＋ HFS外の行</button>
          <button type="button" class="btn btn-sm ie-btn-del" onclick="HFSInvoiceEditor.removeSelected()">削除</button>
          <span class="ie-hint">Tab・Enter・矢印で移動／Excel から貼り付け可／Ctrl+D で上の値をコピー</span>
        </div>` : ''}
        <div class="ie-body">
          <table class="ie-table">
            <thead><tr>
              <th class="ie-col-sel">${canEdit ? `<input type="checkbox" id="ie-sel-all" ${ed.rows.length && ed.rows.every(r => r._sel) ? 'checked' : ''}>` : ''}</th>
              <th class="ie-col-date">納品日</th>
              <th>CR・品目</th>
              <th class="ie-col-view">見る</th>
              <th class="ie-col-num">参考単価</th>
              <th class="ie-col-price">税抜単価</th>
              <th class="ie-col-qty">数量</th>
              <th class="ie-col-num">金額</th>
            </tr></thead>
            <tbody id="ie-tbody">${ed.rows.map((r, i) => rowHtml(r, i, canEdit)).join('')}</tbody>
          </table>
          ${ed.rows.length ? '' : '<div class="ie-empty">明細がありません。「＋ HFS外の行」で追加できます</div>'}
        </div>
        <div class="ie-foot">
          <div class="ie-notes"><input type="text" id="ie-notes" class="ie-in-notes" maxlength="2000" placeholder="備考（任意）" value="${h(ed.notes)}" ${dis}></div>
          <div class="ie-totals" id="ie-totals">${totalsHtml(t)}</div>
          <div class="ie-actions">
            <button type="button" class="btn" onclick="HFSInvoiceEditor.preview()">PDFを見る</button>
            ${canEdit ? '<button type="button" class="btn-primary" id="ie-submit" onclick="HFSInvoiceEditor.submit()">提出する</button>' : ''}
          </div>
        </div>
      </div>`;
    const wh = el.querySelector('#ie-wh');
    if (wh) wh.addEventListener('change', () => { ed.withholding = wh.value === '1'; refreshTotals(); scheduleSave(); });
    const all = el.querySelector('#ie-sel-all');
    if (all) all.addEventListener('change', () => { ed.rows.forEach(r => { r._sel = all.checked; }); el.querySelectorAll('.ie-sel').forEach(cb => { cb.checked = all.checked; }); });
  }

  function totalsHtml(t) {
    return `
      <div><span>小計（税抜）</span><b>${yen(t.subtotal)}</b></div>
      <div><span>消費税（10%）</span><b>${yen(t.tax)}</b></div>
      <div class="ie-t-main"><span>ご請求金額（税込）</span><b>${yen(t.total)}</b></div>
      <div><span>源泉徴収税額（10.21%）</span><b>${t.withholding ? '-' + yen(t.withholding) : '0'}</b></div>
      <div class="ie-t-main"><span>差引お振込額</span><b>${yen(t.payout)}</b></div>
      ${t.withholding_over_limit ? '<div class="ie-t-warn">小計が100万円を超えています。源泉は10.21%一律で計算しています</div>' : ''}`;
  }

  function rowHtml(r, i, canEdit) {
    const issues = rowIssues(r);
    const isNg = issues.length > 0;
    const dis = canEdit ? '' : 'disabled';
    const cls = ['ie-row', r.kind === 'manual' ? 'ie-row-manual' : '', isNg ? 'ie-row-ng' : ''].join(' ');
    const sel = canEdit ? `<input type="checkbox" class="ie-sel" data-i="${i}" ${r._sel ? 'checked' : ''}>` : '';
    const priceIn = (r.kind === 'fixed')
      ? `<span class="ie-fixed">${yen(r.unit_price)}</span>`
      : `<input class="ie-in ie-in-price" data-i="${i}" data-col="price" inputmode="numeric" value="${r.unit_price == null ? '' : h(r.unit_price)}" placeholder="未入力" ${dis}>`;
    const qty = r.kind === 'manual'
      ? `<input class="ie-in ie-in-qty" data-i="${i}" data-col="qty" inputmode="numeric" value="${h(r.quantity)}" ${dis}>`
      : '1';
    let label;
    if (r.kind === 'cr') {
      const over = issues.some(x => x.code === 'OVER_REFERENCE_NO_REASON') || (r.price_change_reason && r.price_change_reason.trim()) ||
        (r.ref_price > 0 && Number(r.unit_price) > r.ref_price);
      label = `<div class="ie-cr">${h(r.client_name)}${r.client_name ? '｜' : ''}${h(r.creative_label)}<span class="ie-role">（${h(r.label)}）</span></div>
        ${over ? `<div class="ie-reason">理由: <input class="ie-in ie-in-reason" data-i="${i}" data-col="reason" maxlength="500" value="${h(r.price_change_reason)}" placeholder="参考単価より高い理由（必須）" ${dis}></div>` : ''}`;
    } else if (r.kind === 'manual') {
      label = `<div class="ie-manual"><input class="ie-in ie-in-label" data-i="${i}" data-col="label" maxlength="200" value="${h(r.label)}" placeholder="品目（例: 撮影補助 10/12）" ${dis}> <span class="ie-tag-blue">HFS未登録</span></div>
        <div class="ie-reason">理由: <input class="ie-in ie-in-reason" data-i="${i}" data-col="reason" maxlength="500" value="${h(r.manual_reason)}" placeholder="HFSに無い理由（必須）" ${dis}></div>`;
    } else {
      label = `<div class="ie-cr">${h(r.creative_label || r.label)}<span class="ie-role">（${h(r.label)}）</span></div>`;
    }
    const msg = isNg ? `<div class="ie-msg">${issues.map(x => h(x.message)).join(' / ')}</div>` : '';
    return `<tr class="${cls}" data-i="${i}">
      <td class="ie-col-sel">${sel}</td>
      <td class="ie-col-date">${r.kind === 'cr' ? slashDate(r.billing_date) : '―'}</td>
      <td>${label}${msg}</td>
      <td class="ie-col-view">${r.creative_id ? `<a href="/haruka.html?creative=${encodeURIComponent(r.creative_id)}" target="_blank" rel="noopener" title="クリエイティブ詳細を別タブで開く">🔗</a>` : ''}</td>
      <td class="ie-col-num">${r.kind === 'cr' ? (r.ref_price > 0 ? yen(r.ref_price) : '―') : '―'}</td>
      <td class="ie-col-price">${priceIn}</td>
      <td class="ie-col-qty">${qty}</td>
      <td class="ie-col-num ie-amount" data-i="${i}">${r.unit_price == null || r.unit_price === '' ? '' : yen(C().lineAmount(r))}</td>
    </tr>`;
  }

  // 入力中はフォーカスを保つため、行の再描画は「その行だけ」＋合計の差し替えに留める
  function refreshRow(i) {
    const tr = overlay().querySelector(`tr.ie-row[data-i="${i}"]`);
    if (!tr) return;
    const focused = document.activeElement;
    const focusCol = focused && focused.dataset && focused.dataset.i === String(i) ? focused.dataset.col : null;
    const caret = focusCol && typeof focused.selectionStart === 'number' ? focused.selectionStart : null;
    const tmp = document.createElement('tbody');
    tmp.innerHTML = rowHtml(ed.rows[i], i, editable());
    tr.replaceWith(tmp.firstElementChild);
    if (focusCol) {
      const nf = overlay().querySelector(`input.ie-in[data-i="${i}"][data-col="${focusCol}"]`);
      if (nf) { nf.focus(); if (caret != null) try { nf.setSelectionRange(caret, caret); } catch (_) { /* number 等 */ } }
    }
  }
  function refreshTotals() {
    const el = overlay().querySelector('#ie-totals');
    if (el) el.innerHTML = totalsHtml(totals());
  }
  function refreshStatus() {
    const el = overlay().querySelector('#ie-status');
    if (el) el.innerHTML = `（${statusText()}）`;
  }

  function setCell(i, col, raw) {
    const r = ed.rows[i];
    if (!r) return false;
    if (col === 'price') {
      if (r.kind === 'fixed') return false;
      const p = C().parseMoney(raw);
      r.unit_price = p.error ? r.unit_price : p.value;
      if (p.error) return false;
    } else if (col === 'qty') {
      if (r.kind !== 'manual') return false;
      const p = C().parseMoney(raw, { max: C().MAX_QUANTITY });
      if (p.error) return false;
      r.quantity = p.value == null ? 0 : p.value;
    } else if (col === 'label') {
      if (r.kind !== 'manual') return false;
      r.label = String(raw ?? '');
    } else if (col === 'reason') {
      if (r.kind === 'cr') r.price_change_reason = String(raw ?? '');
      else if (r.kind === 'manual') r.manual_reason = String(raw ?? '');
      else return false;
    } else return false;
    if (r.id) ed.problems.delete(r.id);
    return true;
  }

  function onInput(e) {
    const t = e.target;
    if (!t.classList || !t.classList.contains('ie-in') || !editable()) return;
    const i = Number(t.dataset.i);
    const col = t.dataset.col;
    const r = ed.rows[i];
    if (!r) return;
    if (col === 'price' || col === 'qty') {
      const p = C().parseMoney(t.value, col === 'qty' ? { max: C().MAX_QUANTITY } : undefined);
      t.classList.toggle('ie-in-bad', !!p.error);
      if (p.error) return;
    }
    const before = rowIssues(r).map(x => x.code).join();
    const hadReasonBox = !!overlay().querySelector(`input.ie-in[data-i="${i}"][data-col="reason"]`);
    setCell(i, col, t.value);
    const amt = overlay().querySelector(`.ie-amount[data-i="${i}"]`);
    if (amt) amt.textContent = r.unit_price == null ? '' : yen(C().lineAmount(r));
    const after = rowIssues(r).map(x => x.code).join();
    const needReasonBox = r.kind === 'cr' && r.ref_price > 0 && Number(r.unit_price) > r.ref_price;
    if (before !== after || (r.kind === 'cr' && needReasonBox && !hadReasonBox)) refreshRow(i);
    refreshTotals();
    scheduleSave();
  }

  function onChange(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('ie-sel')) {
      const r = ed.rows[Number(t.dataset.i)];
      if (r) r._sel = t.checked;
      return;
    }
    if (t.id === 'ie-notes') { ed.notes = t.value; scheduleSave(); }
    if (t.classList && t.classList.contains('ie-in') && (t.dataset.col === 'price' || t.dataset.col === 'qty')) {
      // 確定時に表示を整える（「12,000」→ 12000）
      const r = ed.rows[Number(t.dataset.i)];
      if (r && !t.classList.contains('ie-in-bad')) t.value = t.dataset.col === 'price' ? (r.unit_price == null ? '' : r.unit_price) : r.quantity;
    }
  }

  // ---------- キーボード ----------
  function cellInputs() { return [...overlay().querySelectorAll('input.ie-in:not([disabled])')]; }
  function focusCell(i, col) {
    const el = overlay().querySelector(`input.ie-in[data-i="${i}"][data-col="${col}"]:not([disabled])`);
    if (el) { el.focus(); el.select && el.select(); return true; }
    return false;
  }
  function moveVert(i, col, dir) {
    for (let k = i + dir; k >= 0 && k < ed.rows.length; k += dir) if (focusCell(k, col)) return true;
    // 同じ列が無い行（例: CR 行の品目）しか無ければ単価列へ
    if (col !== 'price') for (let k = i + dir; k >= 0 && k < ed.rows.length; k += dir) if (focusCell(k, 'price')) return true;
    return false;
  }
  function moveHoriz(target, dir) {
    const list = cellInputs();
    const idx = list.indexOf(target);
    const next = list[idx + dir];
    if (next) { next.focus(); next.select && next.select(); }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const t = e.target;
    if (!t.classList || !t.classList.contains('ie-in')) return;
    const i = Number(t.dataset.i), col = t.dataset.col;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      // Ctrl+D: 上の行の同じ列の値をコピー（ブラウザのブックマークは止める）
      e.preventDefault();
      for (let k = i - 1; k >= 0; k--) {
        const src = overlay().querySelector(`input.ie-in[data-i="${k}"][data-col="${col}"]`);
        if (src) { t.value = src.value; t.dispatchEvent(new Event('input', { bubbles: true })); break; }
      }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); moveVert(i, col, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveVert(i, col, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveVert(i, col, -1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
      const atEnd = t.selectionStart === t.value.length && t.selectionEnd === t.value.length;
      const all = t.selectionStart === 0 && t.selectionEnd === t.value.length;
      if (e.key === 'ArrowLeft' && (atStart || all)) { e.preventDefault(); moveHoriz(t, -1); }
      if (e.key === 'ArrowRight' && (atEnd || all)) { e.preventDefault(); moveHoriz(t, 1); }
    }
  }

  // ---------- 貼り付け（Excel / スプレッドシートのタブ区切り） ----------
  function onPaste(e) {
    const t = e.target;
    if (!t.classList || !t.classList.contains('ie-in') || !editable()) return;
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return; // 1 セルだけなら通常の貼り付け
    e.preventDefault();
    const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    const startI = Number(t.dataset.i);
    // 貼り付け開始列から右へ、この行に存在する入力欄の順で埋める
    const colOrder = (i) => {
      const present = new Set([...overlay().querySelectorAll(`input.ie-in[data-i="${i}"]:not([disabled])`)].map(x => x.dataset.col));
      return PASTE_COLS.filter(c => present.has(c));
    };
    const startCols = colOrder(startI);
    const startIdx = Math.max(0, startCols.indexOf(t.dataset.col));
    let rowI = startI, changed = 0, skipped = 0;
    for (const cells of lines) {
      while (rowI < ed.rows.length && ed.rows[rowI].kind === 'fixed') rowI++;
      if (rowI >= ed.rows.length) break;
      const cols = colOrder(rowI);
      cells.forEach((v, k) => {
        const col = cols[startIdx + k];
        if (!col) return;
        let val = v.trim();
        if (col === 'price' || col === 'qty') {
          val = val.replace(/[^0-9０-９]/g, ''); // 単価列は数字だけ取り込む
          if (!val) { skipped++; return; }
        }
        if (setCell(rowI, col, val)) changed++;
      });
      refreshRow(rowI);
      rowI++;
    }
    refreshTotals();
    if (changed) scheduleSave();
    showToast(`${changed} セルに貼り付けました${skipped ? `（数字でない ${skipped} セルは飛ばしました）` : ''}`, 'success', 2500);
  }

  // ---------- ツールバー ----------
  function selectedIdx() { return ed.rows.map((r, i) => (r._sel ? i : -1)).filter(i => i >= 0); }

  function fillRef() {
    if (!editable()) return;
    let idx = selectedIdx().filter(i => ed.rows[i].kind === 'cr');
    if (!idx.length) idx = ed.rows.map((r, i) => (r.kind === 'cr' && r.unit_price == null ? i : -1)).filter(i => i >= 0);
    let n = 0;
    for (const i of idx) {
      const r = ed.rows[i];
      if (r.ref_price > 0) { r.unit_price = r.ref_price; if (r.id) ed.problems.delete(r.id); n++; }
    }
    if (!n) { showToast('入れられる参考単価がありません（参考単価が無い行は手で入れてください）', 'warn'); return; }
    render(); scheduleSave();
    showToast(`${n} 行に参考単価を入れました`, 'success', 2500);
  }

  function bulkPrice() {
    if (!editable()) return;
    const idx = selectedIdx().filter(i => ed.rows[i].kind !== 'fixed');
    if (!idx.length) { showToast('先に左のチェックで行を選んでください', 'warn'); return; }
    const raw = window.prompt(`選んだ ${idx.length} 行に入れる税抜単価（円）`, '');
    if (raw === null) return;
    const p = C().parseMoney(raw);
    if (p.error || p.value == null) { showToast('単価は0以上の整数で入力してください', 'warn'); return; }
    idx.forEach(i => { ed.rows[i].unit_price = p.value; if (ed.rows[i].id) ed.problems.delete(ed.rows[i].id); });
    render(); scheduleSave();
  }

  function addManual() {
    if (!editable()) return;
    ed.rows.push({
      id: null, _key: `k${++ed.keySeq}`, _sel: false, kind: 'manual', creative_id: null, cost_type: null,
      label: '', creative_label: '', unit_price: null, quantity: 1, ref_price: null, price_change_reason: '', manual_reason: '', billing_date: null,
    });
    render();
    focusCell(ed.rows.length - 1, 'label');
    scheduleSave();
  }

  function removeSelected() {
    if (!editable()) return;
    const idx = selectedIdx();
    if (!idx.length) { showToast('削除する行を左のチェックで選んでください', 'warn'); return; }
    const set = new Set(idx);
    ed.rows = ed.rows.filter((_, i) => !set.has(i));
    render(); scheduleSave();
  }

  // ---------- 自動保存（入力が止まって 1.5 秒・楽観ロック） ----------
  function scheduleSave() {
    if (!editable()) return;
    ed.dirty = true;
    refreshStatus();
    clearTimeout(ed.timer);
    ed.timer = setTimeout(() => { save(); }, SAVE_DELAY_MS);
  }

  async function save() {
    clearTimeout(ed.timer);
    if (!ed.dirty || !editable()) return ed.saving || true;
    if (ed.saving) { await ed.saving; return save(); }
    ed.dirty = false;
    const sentRows = ed.rows.slice();
    const payload = {
      updated_at: ed.updatedAt,
      withholding_enabled: ed.withholding,
      notes: ed.notes,
      items: sentRows.map(r => ({
        id: r.id || undefined,
        client_key: r.id ? undefined : r._key,
        label: r.label,
        unit_price: r.unit_price,
        quantity: r.quantity,
        price_change_reason: r.price_change_reason,
        manual_reason: r.manual_reason,
      })),
    };
    ed.saving = (async () => {
      refreshStatus();
      let res, data = {};
      try {
        res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(ed.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        ed.dirty = true;
        showToast('保存に失敗しました（通信エラー）。少し待って自動でやり直します', 'warn');
        ed.timer = setTimeout(() => save(), SAVE_DELAY_MS * 4);
        return false;
      }
      if (!res.ok) {
        if (data.code === 'CONFLICT') { ed.conflict = true; render(); return false; }
        ed.dirty = true;
        showToast(data.error || '保存に失敗しました', 'error');
        return false;
      }
      ed.updatedAt = data.updated_at;
      ed.lastSavedAt = data.saved_at || new Date().toISOString();
      // 新しく足した HFS外の行に ID を振る
      const idMap = data.id_map || {};
      for (const r of ed.rows) if (!r.id && idMap[r._key]) r.id = idMap[r._key];
      return true;
    })();
    const ok = await ed.saving;
    ed.saving = null;
    refreshStatus();
    if (ok && ed.dirty) scheduleSave();
    return ok;
  }

  async function reload() {
    if (ed.id) await open(ed.id);
  }

  async function close() {
    if (ed.dirty && editable()) await save();
    else if (ed.saving) await ed.saving;
    const el = document.getElementById('ie-overlay');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    document.body.style.overflow = '';
    ed.id = null; ed.state = null;
    if (typeof loadMyInvoices === 'function') loadMyInvoices();
  }

  // ---------- 提出（サーバーで全部やり直して確かめる） ----------
  async function submit() {
    if (!editable()) return;
    const localNg = ed.rows.map((r, i) => ({ i, issues: rowIssues(r) })).filter(x => x.issues.length);
    if (!ed.rows.length) { showToast('明細がありません', 'warn'); return; }
    if (localNg.length) {
      showToast(`赤い行が ${localNg.length} 行あります。直してから提出してください`, 'warn');
      const first = overlay().querySelector(`tr.ie-row[data-i="${localNg[0].i}"]`);
      if (first) first.scrollIntoView({ block: 'center' });
      return;
    }
    const t = totals();
    const ok = typeof window.showConfirmDialog === 'function'
      ? await window.showConfirmDialog({ title: '請求書を提出', message: `ご請求金額（税込）${yen(t.total)}円 / 差引お振込額 ${yen(t.payout)}円 で提出します。提出後は管理者の承認が必要です。`, okLabel: '提出する' })
      : window.confirm(`ご請求金額（税込）${yen(t.total)}円 / 差引お振込額 ${yen(t.payout)}円 で提出します。よろしいですか？`);
    if (!ok) return;
    const btn = overlay().querySelector('#ie-submit');
    if (btn) { btn.disabled = true; btn.textContent = '確認中…'; }
    try {
      const saved = await save();
      if (saved === false || ed.conflict) return;
      const res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(ed.id)}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_total: t.total, expected_payout: t.payout, updated_at: ed.updatedAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'CONFLICT') { ed.conflict = true; render(); return; }
        if (data.code === 'INVOICE_CHECK_FAILED' && Array.isArray(data.problems)) {
          ed.problems = new Map();
          const general = [];
          for (const p of data.problems) {
            if (p.item_id) { if (!ed.problems.has(p.item_id)) ed.problems.set(p.item_id, []); ed.problems.get(p.item_id).push(p); }
            else general.push(p.message);
          }
          render();
          showToast(`${data.error}${general.length ? '（' + general.join(' / ') + '）' : ''}`, 'error', 9000);
          return;
        }
        showToast(data.error || '提出に失敗しました', 'error');
        return;
      }
      (data.warnings || []).forEach(w => showToast(w, 'warn', 9000));
      showToast(`請求書 ${ed.state.invoice.invoice_number} を提出しました`, 'success');
      if (typeof notifyInvoiceDrivePdfResult === 'function') notifyInvoiceDrivePdfResult(data);
      ed.dirty = false;
      await close();
    } finally {
      const b = overlay().querySelector('#ie-submit');
      if (b) { b.disabled = false; b.textContent = '提出する'; }
    }
  }

  // ---------- PDF を見る（新方式のレイアウトで印刷プレビュー。保存すれば PDF になる） ----------
  function preview() {
    if (!ed.state) return;
    const s = ed.state, inv = s.invoice, t = totals();
    const rows = ed.rows.map((r, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td class="c">${r.kind === 'cr' ? slashDate(r.billing_date) : ''}</td>
      <td>${r.kind === 'cr' ? `${h(r.client_name)}${r.client_name ? '｜' : ''}${h(r.creative_label)}（${h(r.label)}）` : h(r.kind === 'fixed' ? (r.creative_label || r.label) : r.label)}</td>
      <td class="r">${r.unit_price == null ? '' : yen(r.unit_price)}</td>
      <td class="c">${r.kind === 'manual' ? h(r.quantity) : 1}</td>
      <td class="r">${r.unit_price == null ? '' : yen(C().lineAmount(r))}</td>
    </tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) { showToast('ポップアップがブロックされました。許可してからもう一度押してください', 'warn'); return; }
    w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>請求書_${inv.year}年${inv.month}月_${h(s.issuer.full_name)}_${h(inv.invoice_number)}</title>
      <style>
        body{font-family:"Noto Sans JP","Hiragino Sans",sans-serif;color:#111;margin:32px;font-size:12px}
        h1{text-align:center;font-size:22px;letter-spacing:.4em;margin:0 0 16px}
        .top{display:flex;justify-content:space-between;gap:24px}
        .to{font-size:16px;font-weight:700;border-bottom:1px solid #111;padding-bottom:4px}
        .box{border:2px solid #111;padding:8px 12px;margin:16px 0;width:300px}
        .box div{display:flex;justify-content:space-between;font-size:14px;margin:2px 0}
        table{width:100%;border-collapse:collapse;margin-top:8px}
        th,td{border:1px solid #999;padding:4px 6px}
        th{background:#f2f2f2}
        .r{text-align:right}.c{text-align:center}
        .sum{margin-left:auto;width:320px;margin-top:8px}
        .sum div{display:flex;justify-content:space-between;padding:2px 0}
        .sum .b{font-weight:700;border-top:1px solid #111}
        .draft{color:#b91c1c;font-weight:700}
        @media print{.noprint{display:none}}
      </style></head><body>
      <div class="noprint" style="margin-bottom:12px"><button onclick="window.print()">印刷 / PDFに保存</button>${['draft', 'rejected'].includes(inv.status) ? ' <span class="draft">※ 下書きのプレビューです（提出時に保存される PDF は別に作られます）</span>' : ''}</div>
      <h1>請求書</h1>
      <div class="top">
        <div><div class="to">${h(s.recipient)}</div><p>件名：${inv.year}年${inv.month}月分 制作費として</p></div>
        <div style="text-align:right">請求日 ${longDate(s.invoice_date)}<br>No. ${h(inv.invoice_number)}<br><b>${h(s.issuer.full_name)}</b><br>${s.issuer.invoice_registration_number ? '登録番号 ' + h(s.issuer.invoice_registration_number) : ''}</div>
      </div>
      <div class="box"><div><span>ご請求金額（税込）</span><b>¥${yen(t.total)}</b></div><div><span>差引お振込額</span><b>¥${yen(t.payout)}</b></div></div>
      <div>お支払期限 ${longDate(s.due_date)}</div>
      <table><thead><tr><th>No</th><th>納品日</th><th>品目</th><th>税抜単価</th><th>数量</th><th>税抜金額</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="sum">
        <div><span>小計（税抜）</span><span>${yen(t.subtotal)}</span></div>
        <div><span>消費税（10%）</span><span>${yen(t.tax)}</span></div>
        <div class="b"><span>ご請求金額（税込）</span><span>${yen(t.total)}</span></div>
        <div><span>源泉徴収税額（10.21%）</span><span>${t.withholding ? '-' + yen(t.withholding) : '0'}</span></div>
        <div class="b"><span>差引お振込額</span><span>${yen(t.payout)}</span></div>
      </div>
      ${ed.notes ? `<p>備考：${h(ed.notes)}</p>` : ''}
      </body></html>`);
    w.document.close();
  }

  window.HFSInvoiceEditor = {
    tryRenderCandidates,
    isCandidateMode: () => cand.active,
    createDraftFromModal,
    onThumbToggle,
    open, close, reload, submit, preview, fillRef, bulkPrice, addManual, removeSelected,
    _updateCandidateCount: updateCandidateCount,
    _toggleAllCandidates: toggleAllCandidates,
  };
})();

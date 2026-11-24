// public/js/invoice-editor.js
// 🧾 請求書エディタ（ADR 046 Stage 3・税抜＋源泉）。
//   (a) 「＋ 今月の請求書を作成」モーダルの一覧（新方式の月だけ。旧方式の月は haruka.html の従来描画のまま）
//   (b) 全画面エディタ（1 CR × 役割 = 1 行・単価は空欄から・参考単価・自動保存 1.5 秒・提出はサーバー再チェック）
// 計算・判定は utils/invoice-editor.js（/js/invoice-editor-calc.js → window.InvoiceEditorCalc）をサーバーと共有する。
// 立替経費の行は日付・支払先・領収書（写真の添付 or 「領収書なし」の理由）も入れる（ADR 046 追補 2026-11-23）。
// haruka.html のグローバル（API / apiFetch / showToast / esc / openModal / closeModal / loadMyInvoices /
// notifyInvoiceDrivePdfResult）を使う。本人のデータだけを扱う（issuer_id は送らない＝VIEW AS 中もログイン本人）。
(function () {
  'use strict';

  const C = () => window.InvoiceEditorCalc;
  const THUMB_KEY = 'hfs.invoiceEditor.thumbs';
  const SORT_KEY = 'hfs.invoiceEditor.candSort';
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

  // 既定 ON（似た名前の CR を見た目で見分けられるように）。OFF にした端末だけ軽い一覧のまま
  function thumbsOn() { return lsGet(THUMB_KEY) !== '0'; }
  function candSort() { const v = lsGet(SORT_KEY); return C().SORT_MODES.includes(v) ? v : 'date_asc'; }

  function setFooterMode(exclusive) {
    const totalBox = document.getElementById('gi-total-box');
    const thumbBox = document.getElementById('gi-thumb-toggle-wrap');
    if (totalBox) totalBox.style.display = exclusive ? 'none' : '';
    if (thumbBox) thumbBox.style.display = exclusive ? '' : 'none';
    const sel = document.getElementById('gi-selected-count');
    if (sel) sel.style.display = exclusive ? '' : 'none';
    const sort = document.getElementById('gi-sort');
    if (sort) { sort.style.display = exclusive ? '' : 'none'; sort.value = candSort(); }
    if (!exclusive) outside.box = null;
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
    // 並び順は選んだもの（既定: 納品日が古い順）。この順のまま請求書の明細になる
    const billable = C().sortRows(d.items.filter(i => i.kind !== 'undelivered'), candSort());
    const undelivered = d.items.filter(i => i.kind === 'undelivered');
    const total = billable.length + d.hourly.length + d.installments.length;
    if (!total && !undelivered.length) {
      wrap.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:40px">${d.year}年${d.month}月に請求できるものはありません<br><span style="font-size:11px">一覧に無いクリエイティブは上の 🔍 にファイル名を入れると探せます</span></div><div id="ie-outside"></div>`;
      outside.box = null;
      if (typeof applyInvoiceSearch === 'function') applyInvoiceSearch();
      updateCandidateCount();
      return;
    }
    const thumbCell = (it) => showThumb
      ? `<td class="ie-c-thumb">${it.thumb_file_id ? `<button type="button" class="ie-thumb ie-c-thumb-btn" onclick="HFSInvoiceEditor.openCandidateMedia('${h(it.creative_id)}')" title="クリックで大きく表示">
          <img loading="lazy" decoding="async" src="${API}/portfolio/thumbnail/${encodeURIComponent(it.thumb_file_id)}?s=160" alt="" onerror="this.style.display='none'">
          ${it.media_is_video ? '<span class="ie-thumb-play">▶</span>' : ''}</button>` : '<span class="ie-thumb ie-c-thumb-btn ie-thumb-none" title="ファイルが登録されていません">―</span>'}</td>`
      : '';
    const roleText = (it) => it.roles.map(r => `<span class="ie-c-role">${h(r.label)}</span>`).join('');
    const crRow = (it, disabled) => `
      <tr class="${disabled ? 'ie-c-disabled' : ''}">
        <td class="ie-c-check"><input type="checkbox" class="ie-cand-check" data-kind="cr" data-id="${h(it.creative_id)}" ${disabled ? 'disabled' : 'checked'} onchange="HFSInvoiceEditor._updateCandidateCount()"></td>
        <td class="ie-c-date">${disabled ? '―' : slashDate(it.billing_date)}</td>
        ${thumbCell(it)}
        <td>
          <div class="ie-c-sub">${h(it.client_name)}${it.project_name ? ' / ' + h(it.project_name) : ''}${it.kind === 'previous' ? ' <span class="ie-badge-prev">前月・未請求</span>' : ''}${it.kind === 'extra' ? ' <span class="ie-badge-prev">検索で追加</span>' : ''}${disabled ? ` <span class="ie-badge-status">${h(it.status || '未納品')}</span>` : ''}</div>
          <div class="ie-c-file">${h(it.file_name)} ${roleText(it)}</div>
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
          ${d.installments.map(x => fixedRow(x.installment_key, 'installment', x.label, x.total, (x.is_monthly_fee ? '📅 月額定額' : '📅 一式（分割支払）')
            + (x.pricing_pending ? ' <span title="金額が管理者の承認待ちです。承認されるまで請求書は作成できません（ADR 037）" style="font-size:10px;padding:1px 6px;border-radius:8px;background:#FEF3C7;color:#92400E;white-space:nowrap">🕓 承認待ち</span>' : ''))).join('')}
          ${undelivered.length ? `<tr class="ie-c-sep"><td colspan="${showThumb ? 5 : 4}">未納品（請求できません）</td></tr>` + undelivered.map(it => crRow(it, true)).join('') : ''}
        </tbody>
      </table>
      <div id="ie-outside"></div>`;
    outside.box = null;
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

  function captureChecks() {
    return new Map([...document.querySelectorAll('.ie-cand-check:not(:disabled)')].map(cb => [cb.dataset.id || cb.dataset.key, cb.checked]));
  }
  function renderKeepingChecks() {
    const prev = captureChecks();
    renderCandidates();
    document.querySelectorAll('.ie-cand-check:not(:disabled)').forEach(cb => {
      const k = cb.dataset.id || cb.dataset.key;
      if (prev.has(k)) cb.checked = prev.get(k);
    });
    updateCandidateCount();
  }

  function onCandidateSort(mode) {
    lsSet(SORT_KEY, mode);
    if (cand.active) renderKeepingChecks();
  }

  // ---------- 一覧に無い CR を探す（GET /invoice-editor/search） ----------
  //   一覧は対象月（＋新方式の開始月以降の前月）の分だけ。納品日の登録ずれ等で漏れた CR を名前で探し、
  //   請求できるものは一覧に足す。できないものは理由（未納品・請求済み・Wチェック等）を出す
  const outside = { seq: 0, timer: null, box: null, lastQuery: null, cache: new Map() };

  async function fetchOutside(query, year, month) {
    const res = await apiFetch(`${API}/invoice-editor/search?q=${encodeURIComponent(query)}&year=${year}&month=${month}${thumbsOn() ? '&with_thumbs=1' : ''}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '検索に失敗しました');
    for (const it of (data.items || [])) outside.cache.set(it.creative_id, it);
    return data.items || [];
  }

  function outsideRowHtml(it, actionHtml) {
    const roles = (it.roles || []).map(r => `<span class="ie-c-role">${h(r.label)}</span>`).join('');
    const thumb = it.thumb_file_id
      ? `<button type="button" class="ie-thumb" onclick="HFSInvoiceEditor.openCandidateMedia('${h(it.creative_id)}')" title="クリックで大きく表示"><img loading="lazy" decoding="async" src="${API}/portfolio/thumbnail/${encodeURIComponent(it.thumb_file_id)}?s=120" alt="" onerror="this.style.display='none'">${it.media_is_video ? '<span class="ie-thumb-play">▶</span>' : ''}</button>`
      : '';
    return `<div class="ie-out-row ${it.state === 'addable' ? '' : 'ie-out-ng'}">
      ${thumb}
      <div class="ie-out-main">
        <div class="ie-c-sub">${it.billing_date ? slashDate(it.billing_date) + ' 納品　' : ''}${h(it.client_name)}${it.project_name ? ' / ' + h(it.project_name) : ''}</div>
        <div class="ie-c-file">${h(it.file_name)} ${roles}</div>
        ${it.note ? `<div class="ie-out-note">${h(it.note)}</div>` : ''}
      </div>
      <a href="/haruka.html?creative=${encodeURIComponent(it.creative_id)}" target="_blank" rel="noopener" title="クリエイティブ詳細を別タブで開く" class="ie-out-link">🔗</a>
      ${actionHtml}
    </div>`;
  }

  /** applyInvoiceSearch から呼ばれる（入力が止まって 0.4 秒で検索） */
  function searchOutside(query, shownInList) {
    clearTimeout(outside.timer);
    const q = String(query || '').trim();
    const box = document.getElementById('ie-outside');
    if (!box) return;
    if (!q) { box.innerHTML = ''; outside.lastQuery = null; return; }
    if (outside.box === box && outside.lastQuery === q) return;
    outside.timer = setTimeout(async () => {
      const seq = ++outside.seq;
      box.innerHTML = '<div class="ie-out-head">一覧に無いクリエイティブを探しています…</div>';
      let items;
      try { items = await fetchOutside(q, cand.year, cand.month); } catch (e) { if (seq === outside.seq) box.innerHTML = `<div class="ie-out-head">${h(e.message)}</div>`; return; }
      if (seq !== outside.seq) return;
      outside.box = box; outside.lastQuery = q;
      const listed = new Set((cand.data ? cand.data.items : []).map(x => x.creative_id));
      // 一覧で見つかっているときは足せるものだけ。一覧で 0 件のときは「なぜ出ないか」が分かるよう全部（請求済み・未納品なども）
      const extra = items.filter(it => !listed.has(it.creative_id) && (!shownInList || it.state === 'addable' || it.state === 'future'));
      if (!extra.length) {
        box.innerHTML = shownInList ? '' : '<div class="ie-out-head">見つかりませんでした（自分が担当・ディレクション・プロデュースしたクリエイティブだけ探せます）</div>';
        return;
      }
      box.innerHTML = `<div class="ie-out-head">一覧に無いクリエイティブ（${extra.length} 件）— 請求できるものは「＋ 一覧に追加」で足せます</div>`
        + extra.map(it => outsideRowHtml(it, it.state === 'addable'
          ? `<button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor._addOutsideToList('${h(it.creative_id)}')">＋ 一覧に追加</button>`
          : '<span class="ie-out-ng-tag">追加できません</span>')).join('');
    }, 400);
  }

  function addOutsideToList(creativeId) {
    const it = outside.cache.get(creativeId);
    if (!it || !cand.data || cand.data.items.some(x => x.creative_id === creativeId)) return;
    cand.data.items.push({ ...it, kind: 'extra' });
    const q = document.getElementById('gi-search');
    if (q) q.value = '';
    renderKeepingChecks();
    const cb = document.querySelector(`.ie-cand-check[data-id="${CSS.escape(creativeId)}"]`);
    if (cb) { cb.checked = true; cb.closest('tr')?.scrollIntoView({ block: 'center' }); }
    updateCandidateCount();
    showToast('一覧に追加しました', 'success', 2000);
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
      const detail = Array.isArray(data.problems) && data.problems.length ? `（${data.problems.slice(0, 3).map(p => p.message).join(' / ')}）`
        : Array.isArray(data.pending_lines) && data.pending_lines.length ? `（${data.pending_lines.slice(0, 3).map(l => `${l.project_name || ''}：${l.line_name || ''}`).join(' / ')}）管理者の承認後にもう一度お試しください` : '';
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
    pickOpen: false, pickTimer: null,
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
    // _baseReceiptFileId: この画面が最後にサーバーと合わせた領収書ファイル（保存時に送って食い違いを見つける）
    ed.rows = data.items.map(it => ({ ...it, _key: `k${++ed.keySeq}`, _sel: false, _baseReceiptFileId: it.receipt_file_id || null }));
    ed.receiptReloadPending = false;
    ed.updatedAt = data.invoice.updated_at;
    ed.withholding = !!data.invoice.withholding_enabled;
    ed.notes = data.invoice.notes || '';
    ed.dirty = false; ed.conflict = false; ed.problems = new Map(); ed.lastSavedAt = null; ed.pickOpen = false;
    render();
    const first = el.querySelector('input.ie-in[data-col="price"]:not([disabled])');
    if (first) first.focus();
  }

  function editable() { return !!(ed.state && ed.state.editable) && !ed.conflict; }

  function totals() { return C().computeTotals(ed.rows, { withholding_enabled: ed.withholding }); }

  // 領収書の列が本番にあるか（無い環境では立替経費の日付・支払先・領収書の欄を出さず、提出時にも見ない）
  function receiptOn() { return !!(ed.state && ed.state.receipt_supported); }

  function rowIssues(r) {
    // 立替経費の日付・支払先・領収書は直せる状態のときだけ見る（提出済みの古い請求書に遡って赤を出さない）
    const local = C().lineIssues(r, r.kind === 'cr' ? r.ref_price : null, { requireReceipt: receiptOn() && editable() });
    const srv = r.id ? (ed.problems.get(r.id) || []) : [];
    const seen = new Set(local.map(i => i.code));
    return local.concat(srv.filter(p => !seen.has(p.code)));
  }

  // 管理者に戻された請求書の見え方（ADR 046 追補 2026-11-22・utils/invoice-unlock.js）。
  // 「不備で差し戻し」は赤で理由、「修正のためロック解除」は落ち着いた色で「修正できる状態です」
  function returnedDisplay(inv) {
    const U = window.InvoiceUnlockUtils;
    if (U) return U.returnedDisplay(inv);
    if (!inv || inv.status !== 'rejected') return null;
    return { kind: 'reject', statusLabel: '差し戻し', heading: '差し戻し理由', note: '', reason: inv.rejection_reason || '' };
  }
  function returnedBannerHtml(inv) {
    const d = returnedDisplay(inv);
    if (!d) return '';
    if (d.kind === 'unlock') {
      return `<div class="ie-banner ie-banner-unlock"><b>🔓 ${h(d.heading)}</b>　${h(d.note)}${d.reason ? `　メモ: ${h(d.reason)}` : ''}</div>`;
    }
    return d.reason ? `<div class="ie-banner ie-banner-ng">${h(d.heading)}: ${h(d.reason)}</div>` : '';
  }

  function statusText() {
    const inv = ed.state.invoice;
    const rd = returnedDisplay(inv);
    const st = (rd && rd.statusLabel) || { draft: '下書き', rejected: '差し戻し', submitted: '提出済み', approved: '承認済み' }[inv.status] || inv.status;
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
        ${returnedBannerHtml(inv)}
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
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.togglePick()" title="作成のときに選び漏れた自分のクリエイティブを名前で探して足します">＋ HFSのCRを追加</button>
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.addManual()">＋ HFS外の行</button>
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.addAdjustment()" title="前の月に多く受け取った分を、この請求書で差し引きます（例: 同じ作業を二重に受け取った）">− 過払いの調整</button>
          <button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor.addExpense()" title="交通費など立て替えた実費を足します。領収書どおりの金額を入れてください（消費税・源泉徴収はかかりません）">＋ 立替経費</button>
          <button type="button" class="btn btn-sm ie-btn-del" onclick="HFSInvoiceEditor.removeSelected()">削除</button>
          <select class="ie-sort" onchange="HFSInvoiceEditor.sortBy(this.value); this.value = ''" title="明細を並べ替えます（この順で PDF にも並びます）">
            <option value="">並び替え…</option>
            <option value="date_desc">納品日が新しい順</option>
            <option value="date_asc">納品日が古い順</option>
            <option value="client">クライアント名順</option>
          </select>
          <span class="ie-hint">Tab・Enter・矢印で移動／Excel から貼り付け可／Ctrl+D で上の値をコピー</span>
        </div>
        <div class="ie-pick" id="ie-pick" ${ed.pickOpen ? '' : 'hidden'}>
          <input type="search" class="ie-pick-q" id="ie-pick-q" placeholder="🔍 足したいクリエイティブのファイル名（一部でOK・ひらがな/カタカナどちらでも）" autocomplete="off" oninput="HFSInvoiceEditor._pickSearch(this.value)">
          <div id="ie-pick-results"></div>
        </div>` : ''}
        <div class="ie-body">
          <table class="ie-table">
            <thead><tr>
              <th class="ie-col-sel">${canEdit ? `<input type="checkbox" id="ie-sel-all" ${ed.rows.length && ed.rows.every(r => r._sel) ? 'checked' : ''}>` : ''}</th>
              <th class="ie-col-date">納品日</th>
              <th>CR・品目</th>
              <th class="ie-col-view">見る</th>
              <th class="ie-col-num">参考単価</th>
              <th class="ie-col-price" title="立替経費の行は領収書どおりの金額（実費）">税抜単価</th>
              <th class="ie-col-qty">数量</th>
              <th class="ie-col-num">金額</th>
            </tr></thead>
            <tbody id="ie-tbody">${ed.rows.map((r, i) => rowHtml(r, i, canEdit)).join('')}</tbody>
          </table>
          ${ed.rows.length ? '' : '<div class="ie-empty">明細がありません。「＋ HFS外の行」「＋ 立替経費」で追加できます</div>'}
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
      ${t.expense ? `<div title="領収書どおりの金額をそのまま足します（消費税・源泉徴収の対象外）"><span>立替経費（実費）</span><b>${yen(t.expense)}</b></div>` : ''}
      <div class="ie-t-main"><span>ご請求金額（税込）</span><b>${yen(t.grand_total)}</b></div>
      <div><span>源泉徴収税額（10.21%）</span><b>${t.withholding ? '-' + yen(t.withholding) : '0'}</b></div>
      <div class="ie-t-main"><span>差引お振込額</span><b>${yen(t.payout)}</b></div>
      ${t.withholding_over_limit ? '<div class="ie-t-warn">小計が100万円を超えています。源泉は10.21%一律で計算しています</div>' : ''}`;
  }

  // 単価が HFS の参考単価そのままか、手で変えたか（確認する人が一目で分かるように）
  function priceOrigin(r) {
    if (r.kind !== 'cr') return null;
    if (r.unit_price == null || r.unit_price === '') return 'empty';
    if (!(r.ref_price > 0)) return 'noref';
    return Number(r.unit_price) === Number(r.ref_price) ? 'system' : 'changed';
  }
  function originTagHtml(r) {
    switch (priceOrigin(r)) {
      case 'system': return '<span class="ie-tag-sys">✓ HFSの単価どおり</span>';
      case 'changed': return `<span class="ie-tag-chg">✏️ 手動で変更（参考 ${yen(r.ref_price)}円 → ${yen(r.unit_price)}円）</span>`;
      case 'noref': return '<span class="ie-tag-chg">✏️ 手動で入力（HFSに参考単価なし）</span>';
      default: return '';
    }
  }

  // 小さいサムネ。押すと提出された最新版を大きく表示する
  function thumbHtml(r, i) {
    if (!r.thumb_file_id) return '<span class="ie-thumb ie-thumb-none" title="ファイルが登録されていません">―</span>';
    return `<button type="button" class="ie-thumb" onclick="HFSInvoiceEditor.openMedia(${i})" title="クリックで大きく表示">
      <img loading="lazy" decoding="async" src="${API}/portfolio/thumbnail/${encodeURIComponent(r.thumb_file_id)}?s=120" alt="" onerror="this.style.display='none'">
      ${r.media_is_video ? '<span class="ie-thumb-play">▶</span>' : ''}</button>`;
  }

  function mediaBox() {
    let el = document.getElementById('ie-media');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ie-media';
      el.className = 'ie-media';
      el.addEventListener('click', (e) => { if (e.target === el) closeMedia(); });
      document.body.appendChild(el);
    }
    return el;
  }
  function onMediaKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMedia(); } }
  function closeMedia() {
    const el = document.getElementById('ie-media');
    if (!el) return;
    el.innerHTML = ''; // 再生を止める
    el.classList.remove('open');
    document.removeEventListener('keydown', onMediaKey, true);
  }
  async function openMedia(i) { return showMedia(ed.rows[i]); }
  // 作成モーダルの一覧から（選ぶ前に中身を確かめる）
  async function openCandidateMedia(creativeId) {
    const it = (cand.data && cand.data.items.find(x => x.creative_id === creativeId)) || outside.cache.get(creativeId);
    if (it) return showMedia({ ...it, creative_label: it.file_name });
  }
  async function showMedia(r) {
    if (!r || !r.thumb_file_id) return;
    const el = mediaBox();
    const title = `${r.client_name ? r.client_name + '｜' : ''}${r.creative_label || ''}`;
    el.innerHTML = `<div class="ie-media-inner"><div class="ie-media-head"><span>${h(title)}</span>
      <button type="button" class="ie-media-close" onclick="HFSInvoiceEditor.closeMedia()" aria-label="閉じる">✕</button></div>
      <div class="ie-media-stage" id="ie-media-stage"><div class="ie-media-msg">読み込み中…</div></div></div>`;
    el.classList.add('open');
    document.addEventListener('keydown', onMediaKey, true);
    const stage = document.getElementById('ie-media-stage');
    const thumbSrc = `${API}/portfolio/thumbnail/${encodeURIComponent(r.thumb_file_id)}`;
    if (!r.media_drive_file_id) { stage.innerHTML = `<img src="${thumbSrc}" alt="">`; return; }
    const streamSrc = `${API}/files/${encodeURIComponent(r.media_drive_file_id)}/stream`;
    if (r.media_is_video) {
      // 作品ギャラリーと同じく Drive 直配信 URL を優先（無ければプロキシ配信）
      const src = typeof pfResolvePlaybackUrl === 'function'
        ? (await pfResolvePlaybackUrl({ drive_file_id: r.media_drive_file_id })) || streamSrc
        : streamSrc;
      if (!stage.isConnected) return; // 読み込み中に閉じた
      stage.innerHTML = `<video src="${h(src)}" controls autoplay playsinline preload="metadata" poster="${thumbSrc}"></video>`;
      const v = stage.querySelector('video');
      v.addEventListener('error', () => { if (v.src.indexOf(streamSrc) === -1) v.src = streamSrc; }, { once: true });
    } else {
      // 静止画は原本（サムネは粗い）。失敗時のみサムネへ退避
      stage.innerHTML = `<img src="${streamSrc}" alt="">`;
      const img = stage.querySelector('img');
      img.addEventListener('error', () => { img.src = thumbSrc; }, { once: true });
    }
  }

  // ---------- 立替経費の日付・支払先・領収書（ADR 046 追補 2026-11-23） ----------
  function receiptUrl(r, download) {
    if (!ed.id || !r.id) return '';
    // ?v= はファイルごとに変わる（差し替え後にブラウザのキャッシュで古い写真が見えないように）
    const v = r.receipt_file_id ? `v=${encodeURIComponent(r.receipt_file_id)}` : '';
    const qs = [v, download ? 'download=1' : ''].filter(Boolean).join('&');
    return `${API}/invoices/${encodeURIComponent(ed.id)}/items/${encodeURIComponent(r.id)}/receipt${qs ? '?' + qs : ''}`;
  }
  function receiptLinkHtml(r) {
    if (!r.receipt_file_id) return '';
    return `<a class="ie-rcpt-link" href="${h(receiptUrl(r))}" target="_blank" rel="noopener" title="領収書を別のタブで開く">📎 ${h(r.receipt_file_name || '領収書')}</a>`;
  }

  /**
   * ＋ 立替経費の枠（合意した画面）
   *   内容   [　　　　　　]
   *   金額   [　　] 円
   *   日付   [2026/10/25]
   *   支払先 [　　　　　　]
   *   領収書  ◉ 写真を添付 [📷 選ぶ] 領収書_….jpg ✓
   *           ○ 領収書なし（理由を書く） [　　　　]
   */
  function expenseBlockHtml(r, i, canEdit, priceInput) {
    const dis = canEdit ? '' : 'disabled';
    const st = r.receipt_status || '';
    const name = `ie-rcpt-${h(r._key)}`;
    const pickBtn = canEdit
      ? `<label class="btn btn-sm ie-rcpt-pick${r._uploading ? ' is-busy' : ''}" title="スマホならカメラで撮る・写真から選ぶ・ファイルから選べます">${r._uploading ? '⏳ 送信中…' : (r.receipt_file_id ? '📷 撮り直す・選び直す' : '📷 選ぶ')}<input type="file" class="ie-rcpt-file" data-i="${i}" accept="image/*,application/pdf" ${r._uploading ? 'disabled' : ''}></label>`
      : '';
    const attachedLine = `${pickBtn} ${r.receipt_file_id ? `${receiptLinkHtml(r)} <span class="ie-rcpt-ok">✓</span>` : (canEdit ? '<span class="ie-rcpt-hint">写真・PDF（10MBまで）</span>' : '<span class="ie-rcpt-none">未添付</span>')}`;
    const receiptRead = !canEdit
      ? (st === 'attached' ? `<div class="ie-rcpt-line">${attachedLine}</div>`
        : st === 'missing' ? `<div class="ie-rcpt-line ie-rcpt-missing">⚠ 領収書なし: ${h(r.receipt_missing_reason || '（理由なし）')}</div>`
          : '<div class="ie-rcpt-line ie-rcpt-none">未入力</div>')
      : `<div class="ie-rcpt-line"><label class="ie-rcpt-opt"><input type="radio" class="ie-rcpt-st" name="${name}" data-i="${i}" value="attached" ${st === 'attached' ? 'checked' : ''}> 写真を添付</label> ${attachedLine}</div>
         <div class="ie-rcpt-line"><label class="ie-rcpt-opt"><input type="radio" class="ie-rcpt-st" name="${name}" data-i="${i}" value="missing" ${st === 'missing' ? 'checked' : ''}> 領収書なし（理由を書く）</label></div>
         ${st === 'missing' ? `<div class="ie-rcpt-line"><input class="ie-in ie-in-rreason" data-i="${i}" data-col="rreason" maxlength="500" value="${h(r.receipt_missing_reason)}" placeholder="例: レシートを紛失したため" ${dis}></div>` : ''}`;
    return `<div class="ie-exp-head"><span class="ie-tag-exp">立替経費（実費）</span><span class="ie-exp-note">領収書どおりの金額を入れてください。消費税・源泉徴収はかからず、そのままの額が振り込まれます</span></div>
      <div class="ie-exp-grid">
        <span class="ie-exp-k">内容</span><span><input class="ie-in ie-in-label ie-in-wide" data-i="${i}" data-col="label" maxlength="200" value="${h(r.label)}" placeholder="例: アートホテル撮影 ガソリン代" ${dis}></span>
        <span class="ie-exp-k">金額</span><span>${priceInput} 円</span>
        <span class="ie-exp-k">日付</span><span><input type="date" class="ie-in ie-in-edate" data-i="${i}" data-col="edate" value="${h(r.expense_date || '')}" ${dis}></span>
        <span class="ie-exp-k">支払先</span><span><input class="ie-in ie-in-wide" data-i="${i}" data-col="payee" maxlength="200" value="${h(r.expense_payee)}" placeholder="例: ENEOS ○○店" ${dis}></span>
        <span class="ie-exp-k">領収書</span><div class="ie-rcpt">${receiptRead}</div>
      </div>`;
  }

  /** 画像は長辺 2000px 程度の JPEG にしてから送る（重い写真をそのまま送らない）。PDF はそのまま */
  const RECEIPT_MAX_EDGE = 2000;
  async function imageToJpeg(file, maxEdge) {
    let src = null, w = 0, hh = 0, cleanup = () => {};
    if (typeof createImageBitmap === 'function') {
      try {
        src = await createImageBitmap(file, { imageOrientation: 'from-image' });
        w = src.width; hh = src.height; const bmp = src; cleanup = () => { try { bmp.close(); } catch (_) { /* noop */ } };
      } catch (_) { src = null; }
    }
    if (!src) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      try {
        await new Promise((ok, ng) => { img.onload = ok; img.onerror = () => ng(new Error('decode')); img.src = url; });
      } catch (e) { URL.revokeObjectURL(url); throw e; }
      src = img; w = img.naturalWidth; hh = img.naturalHeight; cleanup = () => URL.revokeObjectURL(url);
    }
    try {
      if (!w || !hh) throw new Error('decode');
      const scale = Math.min(1, maxEdge / Math.max(w, hh));
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(hh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); // 透過 PNG の背景を白に
      ctx.drawImage(src, 0, 0, cw, ch);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) throw new Error('encode');
      return blob;
    } finally { cleanup(); }
  }
  async function prepareReceiptFile(file) {
    const max = (ed.state && ed.state.receipt_max_bytes) || 10 * 1024 * 1024;
    const tooBig = () => new Error(`ファイルが大きすぎます（${Math.round(max / 1024 / 1024)}MB まで）`);
    const type = String(file.type || '').toLowerCase();
    const fname = String(file.name || '');
    const base = fname.replace(/\.[^.]+$/, '') || 'receipt';
    if (type === 'application/pdf' || /\.pdf$/i.test(fname)) {
      if (file.size > max) throw tooBig();
      return { blob: file, name: fname || 'receipt.pdf' };
    }
    const isHeic = /hei[cf]/.test(type) || /\.hei[cf]$/i.test(fname);
    if (!type.startsWith('image/') && !isHeic) throw new Error('画像（写真）か PDF を選んでください');
    try {
      const jpeg = await imageToJpeg(file, RECEIPT_MAX_EDGE);
      if (jpeg.size > max) throw tooBig();
      return { blob: jpeg, name: `${base}.jpg` };
    } catch (e) {
      if (/大きすぎ/.test(e.message)) throw e;
      // ブラウザが読めない HEIC などは、そのまま送る（サーバーで種類を確かめて保存する）
      if (file.size <= max && (isHeic || type === 'image/jpeg' || type === 'image/png')) return { blob: file, name: fname || `${base}.heic` };
      if (file.size > max) throw tooBig();
      throw new Error('この画像は読み込めませんでした。別の写真か PDF を選んでください');
    }
  }

  async function uploadReceipt(r, file) {
    if (!r || r.kind !== 'expense' || !editable() || r._uploading) return;
    const refresh = () => { const i = ed.rows.indexOf(r); if (i >= 0) refreshRow(i); };
    r._uploading = true;
    const statusBefore = r.receipt_status ?? null; // 失敗したら戻す（「写真を添付」のまま写真なし、にしない）
    r.receipt_status = 'attached';
    refresh();
    let uploaded = false;
    try {
      // 新しい行は先に保存して ID を受け取る（入力途中の値もここで保存される）
      ed.dirty = true;
      const saved = await save();
      if (saved === false || !r.id) throw new Error('先に行を保存できませんでした。少し待ってからもう一度選んでください');
      const prepared = await prepareReceiptFile(file);
      const fd = new FormData();
      fd.append('file', prepared.blob, prepared.name);
      const res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(ed.id)}/items/${encodeURIComponent(r.id)}/receipt`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '領収書を保存できませんでした');
      ['receipt_status', 'receipt_missing_reason', 'receipt_file_id', 'receipt_file_name', 'receipt_mime_type', 'receipt_uploaded_at']
        .forEach(k => { if (k in data) r[k] = data[k] ?? (k === 'receipt_missing_reason' ? '' : data[k]); });
      r._baseReceiptFileId = r.receipt_file_id || null; // サーバーと合わせた領収書（次の保存で送る）
      uploaded = true;
      ed.problems.delete(r.id);
      showToast('領収書を保存しました（本人の請求書フォルダの「領収書」に入ります）', 'success', 3000);
    } catch (e) {
      showToast(e.message || '領収書を保存できませんでした', 'error', 6000);
    } finally {
      r._uploading = false;
      if (!uploaded && ed.rows.includes(r) && !r.receipt_file_id && statusBefore !== 'attached') {
        // 送れなかったので選ぶ前の状態に戻して保存し直す
        r.receipt_status = statusBefore;
        scheduleSave();
      }
      refresh();
    }
  }

  function onReceiptStatus(t) {
    const i = Number(t.dataset.i);
    const r = ed.rows[i];
    if (!r || !editable()) return;
    const v = t.value;
    if (v === 'missing' && r.receipt_file_id) {
      if (!window.confirm('添付した領収書を外して「領収書なし」にしますか？（ファイルはゴミ箱に移ります）')) { refreshRow(i); return; }
      Object.assign(r, { receipt_file_id: null, receipt_file_name: '', receipt_mime_type: '', receipt_uploaded_at: null });
    }
    r.receipt_status = v;
    if (r.id) ed.problems.delete(r.id);
    refreshRow(i);
    if (v === 'missing') focusCell(i, 'rreason');
    scheduleSave();
  }

  function rowHtml(r, i, canEdit) {
    const issues = rowIssues(r);
    const isNg = issues.length > 0;
    const dis = canEdit ? '' : 'disabled';
    const cls = ['ie-row', (r.kind === 'manual' || r.kind === 'adjustment') ? 'ie-row-manual' : '', r.kind === 'expense' ? 'ie-row-expense' : '', isNg ? 'ie-row-ng' : ''].join(' ');
    const sel = canEdit ? `<input type="checkbox" class="ie-sel" data-i="${i}" ${r._sel ? 'checked' : ''}>` : '';
    const priceInput = `<input class="ie-in ie-in-price" data-i="${i}" data-col="price" inputmode="numeric" value="${r.unit_price == null ? '' : h(r.unit_price)}" placeholder="未入力" ${dis}>`;
    // 立替経費（領収書の欄があるとき）は金額も内容・日付・支払先と同じ枠の中で入れる（合意した画面どおり）
    const expenseBlock = r.kind === 'expense' && receiptOn();
    const priceIn = (r.kind === 'fixed')
      ? `<span class="ie-fixed">${yen(r.unit_price)}</span>`
      : (expenseBlock ? '' : priceInput);
    const qty = r.kind === 'manual'
      ? `<input class="ie-in ie-in-qty" data-i="${i}" data-col="qty" inputmode="numeric" value="${h(r.quantity)}" ${dis}>`
      : '1';
    let label;
    if (r.kind === 'cr') {
      const over = issues.some(x => x.code === 'OVER_REFERENCE_NO_REASON') || (r.price_change_reason && r.price_change_reason.trim()) ||
        (r.ref_price > 0 && Number(r.unit_price) > r.ref_price);
      label = `<div class="ie-cr-line">${thumbHtml(r, i)}<div class="ie-cr-main">
        <div class="ie-cr">${h(r.client_name)}${r.client_name ? '｜' : ''}${h(r.creative_label)}<span class="ie-role">（${h(r.label)}）</span></div>
        <div class="ie-origin" data-i="${i}">${originTagHtml(r)}</div></div></div>
        ${over ? `<div class="ie-reason">理由: <input class="ie-in ie-in-reason" data-i="${i}" data-col="reason" maxlength="500" value="${h(r.price_change_reason)}" placeholder="参考単価より高い理由（必須）" ${dis}></div>` : ''}`;
    } else if (r.kind === 'manual') {
      label = `<div class="ie-manual"><input class="ie-in ie-in-label" data-i="${i}" data-col="label" maxlength="200" value="${h(r.label)}" placeholder="品目（例: 撮影補助 10/12）" ${dis}> <span class="ie-tag-blue">HFS未登録</span></div>
        <div class="ie-reason">理由: <input class="ie-in ie-in-reason" data-i="${i}" data-col="reason" maxlength="500" value="${h(r.manual_reason)}" placeholder="HFSに無い理由（必須）" ${dis}></div>`;
    } else if (r.kind === 'adjustment') {
      label = `<div class="ie-manual"><input class="ie-in ie-in-label" data-i="${i}" data-col="label" maxlength="200" value="${h(r.label)}" placeholder="内容（例: 10月分 過払い調整（カット稿））" ${dis}> <span class="ie-tag-adj">− 過払いの調整</span></div>
        <div class="ie-reason">理由: <input class="ie-in ie-in-reason" data-i="${i}" data-col="reason" maxlength="500" value="${h(r.manual_reason)}" placeholder="差し引く理由（必須）（例: 10月分で同じ作業を二重に受け取ったため）" ${dis}></div>
        <div class="ie-exp-note">差し引く金額を正の数で入れてください（例: 4000）。報酬から引いたあとの金額で、消費税・源泉徴収を計算し直します</div>`;
    } else if (expenseBlock) {
      label = expenseBlockHtml(r, i, canEdit, priceInput);
    } else if (r.kind === 'expense') {
      label = `<div class="ie-manual"><input class="ie-in ie-in-label" data-i="${i}" data-col="label" maxlength="200" value="${h(r.label)}" placeholder="立替経費の内容（例: 10/25 撮影 タクシー代）" ${dis}> <span class="ie-tag-exp">立替経費（実費）</span></div>
        <div class="ie-exp-note">領収書どおりの金額を入れてください。消費税・源泉徴収はかからず、そのままの額が振り込まれます（領収書は管理者へ）</div>`;
    } else {
      label = `<div class="ie-cr">${h(r.creative_label || r.label)}<span class="ie-role">（${h(r.label)}）</span>${r.is_expense ? ' <span class="ie-tag-exp" title="消費税・源泉徴収の対象外">実費</span>' : ''}</div>`;
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
      if (r.kind !== 'manual' && r.kind !== 'expense' && r.kind !== 'adjustment') return false;
      r.label = String(raw ?? '');
    } else if (col === 'reason') {
      if (r.kind === 'cr') r.price_change_reason = String(raw ?? '');
      else if (r.kind === 'manual' || r.kind === 'adjustment') r.manual_reason = String(raw ?? '');
      else return false;
    } else if (col === 'edate' || col === 'payee' || col === 'rreason') {
      if (r.kind !== 'expense') return false;
      if (col === 'edate') { const d = C().parseExpenseDate(raw); if (d.error) return false; r.expense_date = d.value; }
      else if (col === 'payee') r.expense_payee = String(raw ?? '');
      else r.receipt_missing_reason = String(raw ?? '');
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
    const origin = overlay().querySelector(`.ie-origin[data-i="${i}"]`);
    if (origin) origin.innerHTML = originTagHtml(r);
    const after = rowIssues(r).map(x => x.code).join();
    const needReasonBox = r.kind === 'cr' && r.ref_price > 0 && Number(r.unit_price) > r.ref_price;
    if (before !== after || (r.kind === 'cr' && needReasonBox && !hadReasonBox)) refreshRow(i);
    refreshTotals();
    scheduleSave();
  }

  function onChange(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('ie-rcpt-st')) { onReceiptStatus(t); return; }
    if (t.classList && t.classList.contains('ie-rcpt-file')) {
      const r = ed.rows[Number(t.dataset.i)];
      const file = t.files && t.files[0];
      t.value = ''; // 同じファイルを選び直しても change が来るように
      if (r && file) uploadReceipt(r, file);
      return;
    }
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
    if (e.key === 'Escape' && e.target && e.target.id === 'ie-pick-q') { e.preventDefault(); togglePick(false); return; }
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
    if (t.type === 'date' && /^Arrow/.test(e.key)) return; // 日付欄の矢印は日付の上げ下げに使う
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
    // 貼り付ける列は開始行で決め、下の行には同じ名前の欄へ入れる（無い欄は飛ばす）。
    // 行ごとに左から詰めると、単価の列が HFS外・立替経費の行では「品目」に入ってしまうため
    const pasteCols = startCols.slice(startIdx);
    let rowI = startI, changed = 0, skipped = 0;
    for (const cells of lines) {
      while (rowI < ed.rows.length && ed.rows[rowI].kind === 'fixed') rowI++;
      if (rowI >= ed.rows.length) break;
      const present = new Set(colOrder(rowI));
      cells.forEach((v, k) => {
        const col = pasteCols[k];
        if (!col) return;
        if (!present.has(col)) { if (v.trim()) skipped++; return; } // この行に無い欄（例: CR 行の品目）
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
    showToast(`${changed} セルに貼り付けました${skipped ? `（入れられない ${skipped} セルは飛ばしました）` : ''}`, 'success', 2500);
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
    // 立替経費は領収書ごとに金額が違うので、まとめ入力の対象にしない
    const idx = selectedIdx().filter(i => ed.rows[i].kind !== 'fixed' && ed.rows[i].kind !== 'expense' && ed.rows[i].kind !== 'adjustment');
    if (!idx.length) { showToast('先に左のチェックで行を選んでください（立替経費・金額固定の行はまとめて入力できません）', 'warn'); return; }
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

  /** 立替経費（実費）の行を足す。品目と金額だけ（数量 1・理由なし）。消費税・源泉の対象外（computeTotals が分ける） */
  function addExpense() {
    if (!editable()) return;
    ed.rows.push({
      id: null, _key: `k${++ed.keySeq}`, _sel: false, kind: 'expense', creative_id: null, cost_type: C().MANUAL_EXPENSE_COST_TYPE, is_expense: true,
      label: '', creative_label: '', unit_price: null, quantity: 1, ref_price: null, price_change_reason: '', manual_reason: '', billing_date: null,
      expense_date: null, expense_payee: '', receipt_status: null, receipt_missing_reason: '', receipt_file_id: null, receipt_file_name: '',
    });
    render();
    focusCell(ed.rows.length - 1, 'label');
    scheduleSave();
  }

  /** 過払いの調整（マイナス）の行を足す。品目・差し引く金額（正の数）・理由。数量 1。報酬から引いて消費税・源泉を計算し直す */
  function addAdjustment() {
    if (!editable()) return;
    ed.rows.push({
      id: null, _key: `k${++ed.keySeq}`, _sel: false, kind: 'adjustment', creative_id: null, cost_type: C().ADJUSTMENT_COST_TYPE,
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

  /** 並び替え（CR 行だけ。作業時間・一式・HFS外の行は後ろに元の順で）。保存すると sort_order＝PDF の順になる */
  function sortBy(mode) {
    if (!editable() || !C().SORT_MODES.includes(mode)) return;
    ed.rows = C().sortRows(ed.rows, mode);
    render(); scheduleSave();
  }

  // ---------- ＋ HFSのCRを追加（作成後に選び漏れに気づいたとき） ----------
  function togglePick(force) {
    ed.pickOpen = typeof force === 'boolean' ? force : !ed.pickOpen;
    const box = overlay().querySelector('#ie-pick');
    if (!box) return;
    box.hidden = !ed.pickOpen;
    if (ed.pickOpen) overlay().querySelector('#ie-pick-q')?.focus();
  }

  function pickSearch(query) {
    clearTimeout(ed.pickTimer);
    const out = overlay().querySelector('#ie-pick-results');
    if (!out) return;
    const q = String(query || '').trim();
    if (!q) { out.innerHTML = ''; return; }
    ed.pickTimer = setTimeout(async () => {
      const seq = ++outside.seq;
      out.innerHTML = '<div class="ie-out-head">探しています…</div>';
      let items;
      try { items = await fetchOutside(q, ed.state.invoice.year, ed.state.invoice.month); } catch (e) { if (seq === outside.seq) out.innerHTML = `<div class="ie-out-head">${h(e.message)}</div>`; return; }
      if (seq !== outside.seq) return;
      if (!items.length) { out.innerHTML = '<div class="ie-out-head">見つかりませんでした（自分が担当・ディレクション・プロデュースしたクリエイティブだけ探せます）</div>'; return; }
      const inThis = (it) => (it.roles || []).length > 0 && it.roles.every(r => ed.rows.some(x => x.creative_id === it.creative_id && x.cost_type === r.cost_type));
      out.innerHTML = items.map(it => {
        if (it.state === 'addable' && inThis(it)) return outsideRowHtml({ ...it, state: 'in', note: 'この請求書にもう入っています' }, '<span class="ie-out-ng-tag">追加済み</span>');
        return outsideRowHtml(it, it.state === 'addable'
          ? `<button type="button" class="btn btn-sm" onclick="HFSInvoiceEditor._addCreative('${h(it.creative_id)}', this)">＋ 追加</button>`
          : '<span class="ie-out-ng-tag">追加できません</span>');
      }).join('');
    }, 400);
  }

  async function addCreative(creativeId, btn) {
    if (!editable()) return;
    if (btn) { btn.disabled = true; btn.textContent = '追加中…'; }
    // 入力途中の単価を先に保存してから足す（楽観ロックの updated_at を最新にする）
    const saved = await save();
    if (saved === false || !editable()) { if (btn) { btn.disabled = false; btn.textContent = '＋ 追加'; } return; }
    let res, data = {};
    try {
      res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(ed.id)}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creative_ids: [creativeId], updated_at: ed.updatedAt }),
      });
      data = await res.json().catch(() => ({}));
    } catch (_) { res = null; }
    if (!res || !res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '＋ 追加'; }
      if (data.code === 'CONFLICT') { ed.conflict = true; render(); return; }
      const detail = Array.isArray(data.problems) && data.problems.length ? `（${data.problems.map(p => p.message).join(' / ')}）` : '';
      showToast(`${data.error || '追加に失敗しました'}${detail}`, 'error');
      return;
    }
    ed.pickOpen = false;
    await open(ed.id);
    showToast(`${data.added} 行を足しました。単価を入れてください`, 'success');
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
        kind: r.id ? undefined : r.kind, // 新しい行だけ（'manual' / 'expense'）。種類は作成時に決まる
        label: r.label,
        unit_price: r.unit_price,
        quantity: r.quantity,
        price_change_reason: r.price_change_reason,
        manual_reason: r.manual_reason,
        // 立替経費の日付・支払先・領収書の状態（写真そのものは別の API で送る）
        ...(r.kind === 'expense' && receiptOn() ? {
          // この画面が知っている領収書ファイル。サーバーは DB と一致するときだけ領収書欄を書く
          // （古いタブの保存で、別の端末が付けた写真を消さないため）
          receipt_file_id: r._baseReceiptFileId || null,
          expense_date: r.expense_date || null,
          expense_payee: r.expense_payee || '',
          receipt_status: r.receipt_status || null,
          receipt_missing_reason: r.receipt_missing_reason || '',
        } : {}),
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
      // 新しく足した HFS外・立替経費の行に ID を振る
      const idMap = data.id_map || {};
      for (const r of ed.rows) if (!r.id && idMap[r._key]) r.id = idMap[r._key];
      // 別の画面で領収書が付け替えられていた行は書かれていない → 知らせて読み直す
      const conflicts = new Set(data.receipt_conflicts || []);
      for (const r of sentRows) {
        if (r.kind === 'expense' && r.id && !conflicts.has(r.id)) r._baseReceiptFileId = r.receipt_file_id || null;
      }
      if (conflicts.size) {
        showToast(data.receipt_conflict_message || '別の画面で領収書が更新されています。再読み込みしてください', 'warn', 8000);
        ed.receiptReloadPending = true;
      }
      return true;
    })();
    const ok = await ed.saving;
    ed.saving = null;
    refreshStatus();
    if (ok && ed.receiptReloadPending) {
      // 領収書の食い違いは画面を読み直して最新にする（入力途中の値は保存してから）
      if (ed.dirty) { scheduleSave(); return ok; }
      ed.receiptReloadPending = false;
      await open(ed.id);
      return false; // 読み直したので、続けて提出・追加などはしない（最新の画面で操作し直してもらう）
    }
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
      ? await window.showConfirmDialog({ title: '請求書を提出', message: `ご請求金額（税込）${yen(t.grand_total)}円${t.expense ? `（うち立替経費 ${yen(t.expense)}円）` : ''} / 差引お振込額 ${yen(t.payout)}円 で提出します。提出後は管理者の承認が必要です。`, okLabel: '提出する' })
      : window.confirm(`ご請求金額（税込）${yen(t.grand_total)}円 / 差引お振込額 ${yen(t.payout)}円 で提出します。よろしいですか？`);
    if (!ok) return;
    const btn = overlay().querySelector('#ie-submit');
    if (btn) { btn.disabled = true; btn.textContent = '確認中…'; }
    try {
      const saved = await save();
      if (saved === false || ed.conflict) return;
      const res = await apiFetch(`${API}/invoice-editor/${encodeURIComponent(ed.id)}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_total: t.grand_total, expected_payout: t.payout, updated_at: ed.updatedAt }),
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
      <td>${r.kind === 'cr' ? h(C().crItemLabel(r.client_name, r.creative_label, r.cost_type, r.label)) : h(r.is_expense ? C().expenseItemLabel(r) + C().receiptNoteOf(r) : (r.kind === 'fixed' ? (r.creative_label || r.label) : r.label))}</td>
      <td class="r">${r.unit_price == null ? '' : yen(r.kind === 'adjustment' ? C().lineAmount(r) : r.unit_price)}</td>
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
      <div class="box"><div><span>ご請求金額（税込）</span><b>¥${yen(t.grand_total)}</b></div><div><span>差引お振込額</span><b>¥${yen(t.payout)}</b></div></div>
      <div>お支払期限 ${longDate(s.due_date)}</div>
      <table><thead><tr><th>No</th><th>納品日</th><th>品目</th><th>税抜単価</th><th>数量</th><th>税抜金額</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="sum">
        <div><span>小計（税抜）</span><span>${yen(t.subtotal)}</span></div>
        <div><span>消費税（10%）</span><span>${yen(t.tax)}</span></div>
        ${t.expense ? `<div><span>立替経費（実費）</span><span>${yen(t.expense)}</span></div>` : ''}
        <div class="b"><span>ご請求金額（税込）</span><span>${yen(t.grand_total)}</span></div>
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
    open, close, reload, submit, preview, fillRef, bulkPrice, addManual, addExpense, addAdjustment, removeSelected, sortBy, togglePick,
    openMedia, openCandidateMedia, closeMedia,
    onCandidateSort, searchOutside,
    _updateCandidateCount: updateCandidateCount,
    _toggleAllCandidates: toggleAllCandidates,
    _addOutsideToList: addOutsideToList,
    _pickSearch: pickSearch,
    _addCreative: addCreative,
  };
})();

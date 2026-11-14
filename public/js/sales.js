/* ============================================================
 * sales.js — 🤝 営業・名刺（#page-sales）
 *   ADR 056（docs/design/decisions/056-sales-crm-business-cards.md）。
 *
 *   公開 API（window）:
 *     loadSalesPage()      ページ入口（showPage('sales') から呼ぶ）
 *     Sales.openContact(id) / Sales.reload()
 *
 *   API は haruka.html の apiFetch() 経由で /api/haruka/sales/...。時刻表示はすべて JST。
 *   met_on などの DATE は 'YYYY-MM-DD' の文字列のまま扱う（new Date() に通さない）。
 *   メールは「下書き保存 → サーバーの最終文面を確認 → 送信」の順でしか送らない。
 * ============================================================ */
(function (window, document) {
  'use strict';

  const BASE = '/api/haruka/sales';
  const JST = 'Asia/Tokyo';
  const VIEW_LS_KEY = 'hfs_sales_view';
  const RESUME_SS_KEY = 'hfs_sales_resume';
  const AI_OFF_MSG = 'AIは今使えません。手入力してください';
  const MAIN_STAGES = ['met', 'approach', 'negotiating', 'proposal', 'won'];
  const CLOSED_STAGES = ['hold', 'lost'];
  const DEFAULT_STAGES = [
    { code: 'met', label: '出会い', emoji: '🤝' },
    { code: 'approach', label: 'アプローチ中', emoji: '✉' },
    { code: 'negotiating', label: '商談中', emoji: '💬' },
    { code: 'proposal', label: '提案・見積', emoji: '📄' },
    { code: 'won', label: '受注', emoji: '🎉' },
    { code: 'lost', label: '失注', emoji: '' },
    { code: 'hold', label: '保留', emoji: '' },
  ];
  const CONTACT_FIELDS = ['name', 'name_kana', 'company', 'department', 'job_title', 'email', 'phone',
    'postal_code', 'address', 'website', 'business_summary', 'met_on', 'met_place', 'met_event', 'shared_note'];
  const SCAN_FIELDS = ['name', 'name_kana', 'company', 'department', 'job_title', 'email', 'phone',
    'postal_code', 'address', 'website', 'business_summary'];

  const state = {
    inited: false,
    boot: null,
    contacts: [],
    view: 'kanban',        // 'kanban' | 'list'
    q: '',
    owner: '',
    archived: false,
    mobileStage: 'met',
    closedOpen: false,
    dragId: null,
    loadSeq: 0,
    videos: null,          // プロモ動画（必要になったとき取得）
    detail: null,          // 開いている詳細 { id, modal, data, flushNote }
  };

  // ───────────────── 小道具 ─────────────────
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }
  async function api(path, opts) {
    const res = await window.apiFetch(BASE + path, { credentials: 'include', ...(opts || {}) });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `通信に失敗しました (${res.status})`);
      err.status = res.status;
      err.code = (data && data.code) || '';
      throw err;
    }
    return data || {};
  }
  function send(method, path, body) {
    return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function isAiOff(e) { return e && e.status === 503 && (e.code === 'ai_disabled' || e.code === 'ai_budget'); }

  // サーバーは整形済みの名前（ニックネーム（名前））を返す。オブジェクトで来たときだけ NameDisplay に通す
  function nameOf(v) {
    if (v && typeof v === 'object') {
      return window.NameDisplay ? window.NameDisplay.full(v) : String(v.nickname || v.full_name || v.name || '');
    }
    return String(v == null ? '' : v);
  }
  function todayJst() { return new Date().toLocaleDateString('sv-SE', { timeZone: JST }); }
  function ymd(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[0] : ''; }
  function fmtYmd(v, withYear) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    return withYear ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : `${Number(m[2])}/${Number(m[3])}`;
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ja-JP', { timeZone: JST, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function isDue(v) { const d = ymd(v); return !!d && d <= todayJst(); }
  function safeUrl(u) { const s = String(u || '').trim(); return /^https?:\/\//i.test(s) ? s : ''; }
  function isSingleEmail(s) { return /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/.test(String(s || '')); }
  function sameIds(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
  function stages() { return (state.boot && Array.isArray(state.boot.stages) && state.boot.stages.length) ? state.boot.stages : DEFAULT_STAGES; }
  function stageOf(code) { return stages().find((s) => s.code === code) || { code, label: code, emoji: '' }; }
  function stageLabel(code) { const s = stageOf(code); return `${s.emoji ? s.emoji + ' ' : ''}${s.label}`; }
  function meId() { return state.boot && state.boot.me ? state.boot.me.id : null; }
  function viewAs() { return !!(state.boot && state.boot.view_as); }

  async function confirmDlg(opts) {
    if (typeof window.showConfirmDialog === 'function') return window.showConfirmDialog(opts);
    return askModal({ title: opts.title || '確認', html: `<div class="sl-d-text">${esc(opts.message || '')}</div>`, okLabel: opts.okLabel || 'OK' });
  }
  async function withBusy(btn, fn) {
    if (!btn || btn.disabled) return undefined;
    btn.disabled = true;
    try { return await fn(); } finally { if (btn.isConnected) btn.disabled = false; }
  }

  // ───────────────── モーダル（body 直下に積む） ─────────────────
  const modalStack = [];
  function openModal(o) {
    const ov = document.createElement('div');
    ov.className = 'sl-overlay';
    ov.style.zIndex = String(2100 + modalStack.length * 10);   // 確認ダイアログ(10500)・トースト(99999)より下
    ov.innerHTML = `
      <div class="sl-modal" role="dialog" aria-modal="true" style="--sl-w:${Number(o.width) || 640}px">
        <div class="sl-modal-head">
          <div class="sl-modal-title"></div>
          <div class="sl-modal-head-actions"></div>
          <button type="button" class="sl-modal-x" aria-label="閉じる">×</button>
        </div>
        <div class="sl-modal-body"></div>
        <div class="sl-modal-foot"></div>
      </div>`;
    const m = {
      el: ov,
      titleEl: ov.querySelector('.sl-modal-title'),
      headActions: ov.querySelector('.sl-modal-head-actions'),
      body: ov.querySelector('.sl-modal-body'),
      foot: ov.querySelector('.sl-modal-foot'),
      guard: o.guard || null,      // () => true なら「破棄しますか？」を挟む
      onClose: o.onClose || null,
      closed: false,
      close() {
        if (m.closed) return;
        m.closed = true;
        const i = modalStack.indexOf(m);
        if (i >= 0) modalStack.splice(i, 1);
        ov.remove();
        if (!modalStack.length) document.body.style.overflow = '';
        if (m.onClose) { try { m.onClose(); } catch (e) { console.warn('[sales] onClose', e); } }
      },
      async requestClose() {
        if (m.guard && m.guard()) {
          const ok = await confirmDlg({ title: '閉じる', message: '入力中の内容は保存されません。閉じますか？', okLabel: '閉じる', okVariant: 'danger' });
          if (!ok) return;
        }
        m.close();
      },
    };
    m.titleEl.textContent = o.title || '';
    ov.querySelector('.sl-modal-x').addEventListener('click', () => m.requestClose());
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="modal-close"]')) m.requestClose();
    });
    modalStack.push(m);
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    return m;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !modalStack.length) return;
    if (document.querySelector('.haruka-confirm-overlay')) return;   // 確認ダイアログが前面のときはそちらに任せる
    modalStack[modalStack.length - 1].requestClose();
  });
  function closeAllModals() { while (modalStack.length) modalStack[modalStack.length - 1].close(); }

  // OK / キャンセルを返す汎用モーダル（html は呼び出し側でエスケープ済みのものを渡す）
  function askModal(o) {
    return new Promise((resolve) => {
      let ok = false;
      const m = openModal({ title: o.title, width: o.width || 520, onClose: () => resolve(ok) });
      m.body.innerHTML = o.html || '';
      m.foot.innerHTML = `<button type="button" class="btn" data-act="modal-close">${esc(o.cancelLabel || 'キャンセル')}</button>
        <button type="button" class="${o.okClass || 'btn-primary'}" data-k="ok">${esc(o.okLabel || 'OK')}</button>`;
      m.foot.querySelector('[data-k="ok"]').addEventListener('click', () => { ok = true; m.close(); });
    });
  }

  // ───────────────── 画面の骨組み ─────────────────
  function renderShell() {
    const page = $('page-sales');
    if (!page || state.inited) return;
    state.inited = true;
    try { if (localStorage.getItem(VIEW_LS_KEY) === 'list') state.view = 'list'; } catch (_) {}
    page.innerHTML = `
      <div class="sl-wrap">
        <div class="sl-head"><h2>🤝 営業・名刺</h2></div>
        <div class="sl-toolbar">
          <button type="button" class="btn-primary" data-act="new">＋ 名刺を登録</button>
          <input type="search" id="sl-q" class="sl-search" placeholder="🔍 名前・会社で検索" aria-label="名前・会社で検索">
          <label class="sl-owner-label">担当<select id="sl-owner" class="sl-select" aria-label="担当で絞り込む"><option value="">全員</option></select></label>
          <span class="sl-seg" role="group" aria-label="表示の切り替え">
            <button type="button" data-act="view" data-view="kanban">かんばん</button>
            <button type="button" data-act="view" data-view="list">一覧</button>
          </span>
          <span class="sl-spacer"></span>
          <button type="button" class="btn-sm" data-act="videos">🎬 プロモ動画</button>
          <button type="button" class="btn-sm" data-act="settings">⚙ メール設定</button>
        </div>
        <div id="sl-notes"></div>
        <div id="sl-body"><div class="sl-empty">読み込み中…</div></div>
        <div class="sl-foot-links"><button type="button" class="sl-linkbtn" data-act="archived" id="sl-archived-toggle"></button></div>
      </div>`;

    page.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'new') openContactForm(null);
        else if (act === 'videos') openVideos();
        else if (act === 'settings') openSettings();
        else if (act === 'view') setView(a.dataset.view);
        else if (act === 'tab') { state.mobileStage = a.dataset.stage; renderBody(); }
        else if (act === 'closed-toggle') { state.closedOpen = !state.closedOpen; renderBody(); }
        else if (act === 'archived') { state.archived = !state.archived; loadContacts(); }
        return;
      }
      const card = e.target.closest('[data-contact-id]');
      if (card) openDetail(card.dataset.contactId);
    });
    page.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('[data-contact-id]');
      if (card && e.target === card) openDetail(card.dataset.contactId);
    });

    let qTimer = null;
    $('sl-q').addEventListener('input', (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { state.q = e.target.value.trim(); loadContacts(); }, 300);
    });
    $('sl-owner').addEventListener('change', (e) => { state.owner = e.target.value; loadContacts(); });

    // ドラッグ＆ドロップで進み具合を変える（can_edit のカードだけ draggable）
    const body = $('sl-body');
    body.addEventListener('dragstart', (e) => {
      const card = e.target.closest && e.target.closest('.sl-card[draggable="true"]');
      if (!card) return;
      state.dragId = card.dataset.contactId;
      card.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', state.dragId); } catch (_) {}
    });
    body.addEventListener('dragend', () => {
      state.dragId = null;
      body.querySelectorAll('.is-dragging,.is-over').forEach((el) => el.classList.remove('is-dragging', 'is-over'));
    });
    body.addEventListener('dragover', (e) => {
      if (!state.dragId) return;
      const zone = e.target.closest('[data-drop-stage]');
      if (!zone) return;
      e.preventDefault();
      body.querySelectorAll('.is-over').forEach((el) => { if (el !== zone) el.classList.remove('is-over'); });
      zone.classList.add('is-over');
    });
    body.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop-stage]');
      const id = state.dragId;
      state.dragId = null;
      if (!zone || !id) return;
      e.preventDefault();
      moveStage(id, zone.dataset.dropStage);
    });
    syncToolbar();
  }

  function setView(v) {
    state.view = v === 'list' ? 'list' : 'kanban';
    try { localStorage.setItem(VIEW_LS_KEY, state.view); } catch (_) {}
    syncToolbar();
    renderBody();
  }
  function syncToolbar() {
    const page = $('page-sales');
    if (!page) return;
    page.querySelectorAll('[data-act="view"]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === state.view));
    const t = $('sl-archived-toggle');
    if (t) t.textContent = state.archived ? '← 進行中の一覧に戻る' : '🗄 アーカイブ済みを見る';
  }
  function renderOwnerOptions() {
    const sel = $('sl-owner');
    if (!sel || !state.boot) return;
    const me = meId();
    const members = (state.boot.members || []).filter((m) => m.id !== me);
    sel.innerHTML = `<option value="">全員</option>${me ? `<option value="${esc(me)}">自分</option>` : ''}`
      + members.map((m) => `<option value="${esc(m.id)}">${esc(nameOf(m.name))}</option>`).join('');
    sel.value = state.owner;
    if (sel.value !== state.owner) { state.owner = ''; sel.value = ''; }
  }
  function renderNotes() {
    const box = $('sl-notes');
    if (!box || !state.boot) return;
    const notes = [];
    if (viewAs()) notes.push('<div class="sl-note">VIEW AS 中です。メールの送信はできません（自分用メモは常にログイン本人のものです）。</div>');
    if (state.archived) notes.push('<div class="sl-note is-info">🗄 アーカイブ済みの名刺を表示しています。</div>');
    box.innerHTML = notes.join('');
  }

  // ───────────────── 一覧の取得・描画 ─────────────────
  async function loadBootstrap() {
    state.boot = await api('/bootstrap');
    renderOwnerOptions();
    renderNotes();
  }
  async function loadContacts() {
    const seq = ++state.loadSeq;
    syncToolbar();
    renderNotes();
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.owner) p.set('owner', state.owner);
    p.set('archived', state.archived ? '1' : '0');
    try {
      const data = await api('/contacts?' + p.toString());
      if (seq !== state.loadSeq) return;
      state.contacts = data.contacts || [];
      renderBody();
    } catch (e) {
      if (seq !== state.loadSeq) return;
      $('sl-body').innerHTML = `<div class="sl-empty">読み込めませんでした：${esc(e.message)}</div>`;
    }
  }

  function mailBadge(c) {
    const parts = [];
    if (Number(c.mail_sent_count) > 0) parts.push(`✉${Number(c.mail_sent_count)}通`);
    if (c.promo_viewed) parts.push('👀開封');
    return parts.join(' ');
  }
  function nextHtml(c) {
    if (!c.next_action_on && !c.next_action) return '';
    const d = fmtYmd(c.next_action_on);
    const dHtml = d ? `<span class="${isDue(c.next_action_on) ? 'sl-due' : ''}">${esc(d)}</span> ` : '';
    return `${dHtml}${esc(c.next_action || '')}`;
  }
  function metText(c, withYear) {
    return [fmtYmd(c.met_on, withYear), c.met_place, c.met_event].filter(Boolean).join(' ');
  }
  function cardHtml(c) {
    const drag = c.can_edit && !state.archived;
    const mail = mailBadge(c);
    const next = nextHtml(c);
    const met = metText(c);
    return `<div class="sl-card${drag ? ' is-draggable' : ''}" data-contact-id="${esc(c.id)}"${drag ? ' draggable="true"' : ''} tabindex="0" role="button">
      <div class="sl-card-name">${esc(c.name)}${c.do_not_email ? ' <span title="今後メールを送らない">🚫</span>' : ''}</div>
      ${c.company ? `<div>${esc(c.company)}</div>` : ''}
      ${met ? `<div class="sl-muted">${esc(met)}</div>` : ''}
      ${mail ? `<div>${esc(mail)}</div>` : ''}
      ${next ? `<div>次: ${next}</div>` : ''}
      <div class="sl-card-owner">担当: ${esc(nameOf(c.owner_name))}</div>
    </div>`;
  }
  function colHtml(code, rows) {
    return `<section class="sl-col${state.mobileStage === code ? ' is-active' : ''}" data-drop-stage="${esc(code)}">
      <div class="sl-col-head"><span>${esc(stageLabel(code))}</span><span class="sl-n">${rows.length}</span></div>
      ${rows.length ? rows.map(cardHtml).join('') : '<div class="sl-col-empty">まだありません</div>'}
    </section>`;
  }
  function renderBody() {
    const body = $('sl-body');
    if (!body) return;
    if (state.archived || state.view === 'list') { body.innerHTML = listHtml(); return; }
    const by = {};
    stages().forEach((s) => { by[s.code] = []; });
    state.contacts.forEach((c) => { (by[c.stage] || (by[c.stage] = [])).push(c); });
    const order = [...MAIN_STAGES, ...CLOSED_STAGES];
    if (!order.includes(state.mobileStage)) state.mobileStage = 'met';
    const tabs = order.map((code) => `<button type="button" class="sl-tab${state.mobileStage === code ? ' is-active' : ''}" data-act="tab" data-stage="${esc(code)}">${esc(stageLabel(code))}<span class="sl-n">${(by[code] || []).length}</span></button>`).join('');
    const closedN = CLOSED_STAGES.reduce((n, code) => n + (by[code] || []).length, 0);
    const empty = !state.contacts.length
      ? `<div class="sl-note is-info">${state.q || state.owner ? '条件に合う名刺はありません。' : 'まだ名刺がありません。「＋ 名刺を登録」から最初の1枚をどうぞ。'}</div>` : '';
    body.innerHTML = `${empty}
      <div class="sl-tabs">${tabs}</div>
      <div class="sl-kanban">${MAIN_STAGES.map((code) => colHtml(code, by[code] || [])).join('')}</div>
      <div class="sl-closed${state.closedOpen ? ' is-open' : ''}">
        <div class="sl-closed-head">
          <button type="button" class="sl-closed-toggle" data-act="closed-toggle" aria-expanded="${state.closedOpen ? 'true' : 'false'}">${state.closedOpen ? '▾' : '▸'} 保留・失注（${closedN}）</button>
          ${CLOSED_STAGES.map((code) => `<span class="sl-dropchip" data-drop-stage="${esc(code)}">${esc(stageLabel(code))} ${(by[code] || []).length}</span>`).join('')}
        </div>
        <div class="sl-closed-cols">${CLOSED_STAGES.map((code) => colHtml(code, by[code] || [])).join('')}</div>
      </div>`;
  }
  function listHtml() {
    if (!state.contacts.length) {
      return `<div class="sl-empty">${state.archived ? 'アーカイブ済みの名刺はありません' : (state.q || state.owner ? '条件に合う名刺はありません' : 'まだ名刺がありません。「＋ 名刺を登録」から最初の1枚をどうぞ。')}</div>`;
    }
    return `<table class="sl-table">
      <thead><tr><th class="c-name">名前</th><th class="c-co">会社</th><th class="c-met">出会った日・場所</th><th class="c-stage">進み具合</th><th class="c-owner">担当</th><th class="c-next">次の予定</th><th class="c-mail">メール</th></tr></thead>
      <tbody>${state.contacts.map((c) => `<tr data-contact-id="${esc(c.id)}" tabindex="0">
        <td class="c-name">${esc(c.name)}${c.do_not_email ? ' 🚫' : ''}</td>
        <td class="c-co">${esc(c.company || '')}</td>
        <td class="c-met" data-label="出会い">${esc(metText(c, true))}</td>
        <td class="c-stage" data-label="進み具合">${esc(stageLabel(c.stage))}</td>
        <td class="c-owner" data-label="担当">${esc(nameOf(c.owner_name))}</td>
        <td class="c-next" data-label="次の予定">${nextHtml(c)}</td>
        <td class="c-mail" data-label="メール">${esc(mailBadge(c))}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function mergeContact(contact) {
    if (!contact || !contact.id) return;
    const c = state.contacts.find((x) => x.id === contact.id);
    if (c) Object.assign(c, contact);
  }
  async function moveStage(id, stage) {
    const c = state.contacts.find((x) => x.id === id);
    if (!c || c.stage === stage) { renderBody(); return; }
    if (!c.can_edit) { toast('進み具合を変えられるのは担当と管理者だけです', 'error'); renderBody(); return; }
    const prev = c.stage;
    c.stage = stage;                      // 先に動かして見せる。失敗したら戻す
    renderBody();
    try {
      const r = await send('POST', `/contacts/${encodeURIComponent(id)}/stage`, { stage });
      mergeContact(r.contact);
      renderBody();
    } catch (e) {
      c.stage = prev;
      renderBody();
      toast(e.message, 'error');
    }
  }

  // ───────────────── 名刺画像 ─────────────────
  function isHeic(file) { return /image\/hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || ''); }
  // 長辺 1600px・JPEG 品質 0.85 に縮小して data URL にする
  function fileToCardDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) throw new Error('この画像は読み込めませんでした');
          const r = Math.min(1, 1600 / Math.max(w, h));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * r));
          cv.height = Math.max(1, Math.round(h * r));
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('この画像は読み込めませんでした（JPEG・PNG をお使いください）')); };
      img.src = url;
    });
  }
  function isImageDataUrl(s) { return /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(String(s || '')); }

  // ───────────────── 名刺を登録／編集 ─────────────────
  function field(name, label, o) {
    o = o || {};
    const v = esc(o.value == null ? '' : o.value);
    const attrs = `name="${name}" class="form-input"${o.required ? ' required' : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.inputmode ? ` inputmode="${o.inputmode}"` : ''}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ' autocomplete="off"'}`;
    const ctl = o.textarea
      ? `<textarea ${attrs} rows="${o.rows || 2}">${v}</textarea>`
      : `<input type="${o.type || 'text'}" ${attrs} value="${v}">`;
    return `<label class="sl-field"><span>${label}</span>${ctl}</label>`;
  }

  function openContactForm(contact) {
    const isEdit = !!contact;
    const c = contact || { met_on: todayJst() };
    const ctx = { image: null, aiResult: null, dirty: false, dups: [] };
    const m = openModal({ title: isEdit ? '✏ 名刺の内容を編集' : '📇 名刺を登録', width: 680, guard: () => ctx.dirty, onClose: () => document.removeEventListener('paste', onPaste) });
    const ai = (state.boot && state.boot.ai) || {};
    const aiUsable = !!(ai.enabled && ai.available);
    m.body.innerHTML = `
      <form id="sl-form" novalidate>
        ${isEdit ? '' : `<div class="sl-cardbox">
          <div class="sl-cardprev" data-k="prev">名刺の画像<br>（ここへドラッグ・貼り付けもできます）</div>
          <div class="sl-cardactions">
            <label class="btn-sm sl-filebtn">📷 名刺の画像を選ぶ / 貼り付け<input type="file" accept="image/*" data-k="file"></label>
            <button type="button" class="btn-sm" data-k="scan" disabled>✨ AIで読み取る</button>
            <div class="sl-hint" data-k="scan-note">${aiUsable ? '※読み取り結果は必ず確認してください' : esc(AI_OFF_MSG) + '（画像は保存できます）'}</div>
          </div>
        </div>`}
        <div class="sl-grid c2">${field('name', '氏名 *', { value: c.name, required: true })}${field('name_kana', 'フリガナ', { value: c.name_kana })}</div>
        <div class="sl-grid c3">${field('company', '会社', { value: c.company })}${field('department', '部署', { value: c.department })}${field('job_title', '役職', { value: c.job_title })}</div>
        <div class="sl-grid c2">${field('email', 'メール', { value: c.email, type: 'email', inputmode: 'email' })}${field('phone', '電話', { value: c.phone, type: 'tel', inputmode: 'tel' })}</div>
        <div class="sl-grid c13">${field('postal_code', '〒', { value: c.postal_code, inputmode: 'numeric' })}${field('address', '住所', { value: c.address })}</div>
        <div class="sl-grid">${field('website', 'Web', { value: c.website, inputmode: 'url', placeholder: 'https://' })}</div>
        <div class="sl-grid">${field('business_summary', '事業内容', { value: c.business_summary, textarea: true })}</div>
        <div class="sl-sec">出会いの記録</div>
        <div class="sl-grid c3">${field('met_on', '日付', { value: ymd(c.met_on), type: 'date' })}${field('met_place', '場所', { value: c.met_place, placeholder: '例: 神戸' })}${field('met_event', '会・イベント', { value: c.met_event, placeholder: '例: ○○交流会' })}</div>
        ${isEdit ? '' : `<div class="sl-grid">${field('private_note', '🔒 自分用メモ（自分だけに見えます）', { textarea: true })}</div>`}
        <div class="sl-grid">${field('shared_note', '共有メモ（全員に見えます）', { value: c.shared_note, textarea: true })}</div>
        <div class="sl-dups" data-k="dups"></div>
      </form>`;
    m.foot.innerHTML = `<button type="button" class="btn" data-act="modal-close">キャンセル</button>
      <button type="button" class="btn-primary" data-k="save">${isEdit ? '保存する' : '登録する'}</button>`;

    const form = m.body.querySelector('#sl-form');
    const q = (k) => m.el.querySelector(`[data-k="${k}"]`);
    const val = (n) => String((form.elements[n] && form.elements[n].value) || '').trim();
    form.addEventListener('input', () => { ctx.dirty = true; });
    form.addEventListener('submit', (e) => e.preventDefault());

    function renderDups() {
      const email = val('email').toLowerCase();
      const local = email ? state.contacts.filter((x) => x.id !== c.id && String(x.email || '').toLowerCase() === email) : [];
      const seen = new Set();
      const all = [...ctx.dups, ...local].filter((d) => d && d.id && d.id !== c.id && !seen.has(d.id) && seen.add(d.id));
      q('dups').innerHTML = all.map((d) => `<div class="sl-note">⚠ 同じ方が登録済みかもしれません: ${esc(d.name)}${d.company ? `（${esc(d.company)}）` : ''}${d.owner_name ? `　担当: ${esc(nameOf(d.owner_name))}` : ''}
        <button type="button" class="btn-sm" data-dup="${esc(d.id)}">開く</button></div>`).join('');
    }
    q('dups').addEventListener('click', (e) => { const b = e.target.closest('[data-dup]'); if (b) openDetail(b.dataset.dup); });
    form.elements.email.addEventListener('change', renderDups);

    async function setImage(file) {
      if (!file) return;
      if (isHeic(file)) { toast('HEIC 形式は読み込めません。スクリーンショットか JPEG・PNG でお願いします', 'error'); return; }
      if (!/^image\//.test(file.type || '')) { toast('画像ファイルを選んでください', 'error'); return; }
      try {
        ctx.image = await fileToCardDataUrl(file);
        ctx.dirty = true;
        const prev = q('prev');
        prev.textContent = '';
        const img = document.createElement('img');
        img.alt = '名刺のプレビュー';
        img.src = ctx.image;
        prev.appendChild(img);
        q('scan').disabled = !aiUsable;
      } catch (e) { toast(e.message, 'error'); }
    }
    function onPaste(e) {
      if (modalStack[modalStack.length - 1] !== m) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) { e.preventDefault(); setImage(it.getAsFile()); return; }
      }
    }

    if (!isEdit) {
      document.addEventListener('paste', onPaste);
      q('file').addEventListener('change', (e) => { setImage(e.target.files && e.target.files[0]); e.target.value = ''; });
      const prev = q('prev');
      ['dragenter', 'dragover'].forEach((t) => prev.addEventListener(t, (e) => { e.preventDefault(); prev.classList.add('is-over'); }));
      ['dragleave', 'drop'].forEach((t) => prev.addEventListener(t, (e) => { e.preventDefault(); prev.classList.remove('is-over'); }));
      prev.addEventListener('drop', (e) => setImage(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
      q('scan').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
        if (!ctx.image) return;
        const note = q('scan-note');
        note.textContent = '読み取り中…（10秒ほどかかります）';
        try {
          const r = await send('POST', '/cards/scan', { image: ctx.image });
          const f = r.fields || {};
          ctx.aiResult = f;
          SCAN_FIELDS.forEach((k) => {
            const v = f[k] == null ? '' : String(f[k]).trim();
            if (v && form.elements[k]) form.elements[k].value = v;   // 読み取れた欄だけ入れる（空で上書きしない）
          });
          ctx.dups = Array.isArray(r.duplicates) ? r.duplicates : [];
          ctx.dirty = true;
          renderDups();
          note.textContent = '✅ 読み取りました。内容を必ず確認して、違うところは直してください';
        } catch (err) {
          if (isAiOff(err)) { note.textContent = `${AI_OFF_MSG}（画像は保存できます）`; toast(AI_OFF_MSG, 'info'); } else { note.textContent = '読み取れませんでした。手入力してください'; toast(err.message, 'error'); }
        }
      }));
    }

    q('save').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      if (!val('name')) { toast('氏名を入力してください', 'error'); form.elements.name.focus(); return; }
      const email = val('email');
      if (email && !isSingleEmail(email)) { toast('メールアドレスの形を確認してください（1件だけ入れられます）', 'error'); form.elements.email.focus(); return; }
      const payload = {};
      CONTACT_FIELDS.forEach((k) => { payload[k] = val(k) || null; });
      try {
        if (isEdit) {
          await send('PATCH', `/contacts/${encodeURIComponent(c.id)}`, payload);
          ctx.dirty = false;
          m.close();
          toast('保存しました', 'success');
        } else {
          if (ctx.image) payload.card_image = ctx.image;
          if (ctx.aiResult) payload.ai_result = ctx.aiResult;
          const r = await send('POST', '/contacts', payload);
          const note = val('private_note');
          ctx.dirty = false;
          m.close();
          if (note && r.contact && r.contact.id) {
            try { await send('PUT', `/contacts/${encodeURIComponent(r.contact.id)}/private-note`, { body: note }); } catch (err) { toast(`名刺は登録しましたが、自分用メモを保存できませんでした：${err.message}`, 'error'); }
          }
          toast(`${r.contact && r.contact.name ? r.contact.name + ' さんを' : '名刺を'}登録しました`, 'success');
        }
        await loadContacts();
        if (isEdit && state.detail && state.detail.id === c.id) await refreshDetail();
      } catch (err) { toast(err.message, 'error'); }
    }));
    if (!isEdit) renderDups();
    setTimeout(() => { try { if (isEdit || window.innerWidth > 768) form.elements.name.focus(); } catch (_) {} }, 0);
  }

  // ───────────────── 詳細 ─────────────────
  async function openDetail(id) {
    if (state.detail) { const old = state.detail; state.detail = null; old.modal.close(); }
    const d = { id, data: null, flushNote: null, modal: null };
    d.modal = openModal({
      title: '読み込み中…', width: 720,
      onClose: () => { if (d.flushNote) d.flushNote(); if (state.detail === d) state.detail = null; },
    });
    state.detail = d;
    d.modal.body.innerHTML = '<div class="sl-empty">読み込み中…</div>';
    bindDetail(d);
    await refreshDetail();
  }

  async function refreshDetail() {
    const d = state.detail;
    if (!d) return;
    if (d.flushNote) { try { await d.flushNote(); } catch (_) {} }
    try {
      const data = await api(`/contacts/${encodeURIComponent(d.id)}`);
      if (state.detail !== d || d.modal.closed) return;
      d.data = data;
      renderDetail(d);
    } catch (e) {
      if (state.detail !== d || d.modal.closed) return;
      d.modal.titleEl.textContent = '読み込めませんでした';
      d.modal.body.innerHTML = `<div class="sl-empty">${esc(e.message)}</div>`;
    }
  }

  function renderDetail(d) {
    const c = d.data.contact || {};
    const m = d.modal;
    const can = !!c.can_edit && !c.archived_at;
    const dis = can ? '' : ' disabled';
    const sub = [c.company, c.department, c.job_title].filter(Boolean).join(' ');
    m.titleEl.innerHTML = `${esc(c.name || '')}${sub ? ` <small>（${esc(sub)}）</small>` : ''}`;
    m.headActions.innerHTML = can ? '<button type="button" class="btn-sm" data-d="edit">編集</button>' : '';
    const web = safeUrl(c.website);
    const contactLine = [
      c.email ? `<span>✉ <a href="mailto:${encodeURIComponent(c.email).replace(/%40/g, '@')}">${esc(c.email)}</a></span>` : '',
      c.phone ? `<span>☎ ${/^[0-9+\-() ]+$/.test(c.phone) ? `<a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ''))}">${esc(c.phone)}</a>` : esc(c.phone)}</span>` : '',
      c.website ? `<span>🌐 ${web ? `<a href="${esc(web)}" target="_blank" rel="noopener noreferrer">${esc(c.website)}</a>` : esc(c.website)}</span>` : '',
    ].filter(Boolean).join('');
    const addr = [c.postal_code ? `〒${c.postal_code}` : '', c.address].filter(Boolean).join(' ');
    const met = [fmtYmd(c.met_on, true), [c.met_place, c.met_event].filter(Boolean).join('・')].filter(Boolean).join(' ');
    const stageOpts = stages().map((s) => `<option value="${esc(s.code)}"${s.code === c.stage ? ' selected' : ''}>${esc(stageLabel(s.code))}</option>`).join('');
    const mails = Array.isArray(d.data.mails) ? d.data.mails : [];
    const noMail = c.do_not_email || !!c.archived_at;
    m.body.innerHTML = `
      ${c.archived_at ? '<div class="sl-note is-info">🗄 アーカイブ済みです（内容は変更できません）。</div>' : ''}
      <div class="sl-d-row">
        <label>進み具合 <select class="sl-select" data-d="stage"${dis}>${stageOpts}</select></label>
        <span>担当: ${esc(nameOf(c.owner_name))}</span>
        ${c.has_card_image ? '<button type="button" class="btn-sm" data-d="card">🪪 名刺画像を見る</button>' : ''}
      </div>
      ${contactLine ? `<div class="sl-d-row">${contactLine}</div>` : ''}
      ${addr ? `<div class="sl-d-text"><b>住所</b>${esc(addr)}</div>` : ''}
      ${c.business_summary ? `<div class="sl-d-text"><b>事業内容</b>${esc(c.business_summary)}</div>` : ''}
      ${met ? `<div class="sl-d-text"><b>出会い</b>${esc(met)}</div>` : ''}
      ${c.client_name ? `<div class="sl-d-text"><b>クライアント</b>${esc(c.client_name)}</div>` : ''}
      <div class="sl-d-next">
        <label class="sl-field"><span>次の予定${isDue(c.next_action_on) ? ' <b class="sl-due">（期日を過ぎています）</b>' : ''}</span><input type="date" class="form-input" data-f="next_action_on" value="${esc(ymd(c.next_action_on))}"${dis}></label>
        <label class="sl-field"><span>やること</span><input type="text" class="form-input" data-f="next_action" value="${esc(c.next_action || '')}" placeholder="例: 電話でフォロー"${dis}></label>
        <label class="sl-field"><span>見込み（円・税抜）</span><input type="number" class="form-input" data-f="expected_amount" min="0" step="1" inputmode="numeric" value="${c.expected_amount == null ? '' : esc(c.expected_amount)}"${dis}></label>
      </div>
      <label class="sl-field" style="margin-bottom:10px"><span>共有メモ（全員に見えます）</span><textarea class="form-input" rows="2" data-f="shared_note"${dis}>${esc(c.shared_note || '')}</textarea></label>
      <label class="sl-field" style="margin-bottom:10px"><span>🔒 自分用メモ（自分だけに見えます・入力後に自動保存） <em class="sl-muted" data-d="note-status" style="font-style:normal"></em></span><textarea class="form-input" rows="3" data-d="private-note">${esc(d.data.private_note || '')}</textarea></label>
      <label class="sl-check"><input type="checkbox" data-f="do_not_email"${c.do_not_email ? ' checked' : ''}${dis}> 今後メールを送らない</label>
      <div class="sl-sec">✉ メール</div>
      <div class="sl-d-row">
        <button type="button" class="btn-sm" data-d="new-mail"${noMail ? ' disabled' : ''}>＋ メールを作る</button>
        ${c.do_not_email ? '<span class="sl-muted">「今後メールを送らない」の方です</span>' : ''}
      </div>
      <div class="sl-mails">${mails.length ? mails.map((x) => mailItemHtml(x, d.data)).join('') : '<div class="sl-muted" style="font-size:12px">まだメールはありません</div>'}</div>`;
    m.foot.innerHTML = can ? '<button type="button" class="btn-danger sl-left" data-d="archive">🗄 アーカイブ</button><button type="button" class="btn" data-act="modal-close">閉じる</button>'
      : '<button type="button" class="btn" data-act="modal-close">閉じる</button>';

    // 自分用メモの自動保存（本人だけ。担当でなくても書ける）
    const ta = m.body.querySelector('[data-d="private-note"]');
    const st = m.body.querySelector('[data-d="note-status"]');
    let timer = null;
    let last = ta.value;
    const save = async () => {
      clearTimeout(timer); timer = null;
      const v = ta.value;
      if (v === last) return;
      st.textContent = '保存中…';
      try {
        await send('PUT', `/contacts/${encodeURIComponent(d.id)}/private-note`, { body: v });
        last = v;
        st.textContent = '✓ 保存しました';
      } catch (e) { st.textContent = '⚠ 保存できませんでした'; toast(e.message, 'error'); }
    };
    ta.addEventListener('input', () => { st.textContent = '入力中…'; clearTimeout(timer); timer = setTimeout(save, 900); });
    ta.addEventListener('blur', save);
    d.flushNote = save;
  }

  function pageOf(data, id) { return id ? (data.promo_pages || []).find((p) => p.id === id) : null; }
  function mailItemHtml(x, data) {
    const pg = pageOf(data, x.promo_page_id);
    let badge, when, btn;
    if (x.status === 'sent') { badge = '<span class="sl-badge is-sent">送信済み</span>'; when = fmtDateTime(x.sent_at); btn = '見る'; }
    else if (x.status === 'sending') { badge = '<span class="sl-badge">送信中</span>'; when = fmtDateTime(x.created_at); btn = '見る'; }
    else if (x.status === 'failed') { badge = '<span class="sl-badge is-failed">送信失敗</span>'; when = fmtDateTime(x.created_at); btn = '開く'; }
    else { badge = '<span class="sl-badge">下書き</span>'; when = fmtDateTime(x.created_at); btn = '開く'; }
    const proxy = x.status === 'sent' && x.sent_by_name && x.sent_by_name !== x.sender_name ? `（代理送信: ${esc(nameOf(x.sent_by_name))}）` : '';
    let pgLine = '';
    if (pg) {
      const url = safeUrl(pg.url);
      const viewed = Number(pg.view_count) > 0
        ? `👀 紹介ページ 開封 ${Number(pg.view_count)}回（初回 ${esc(fmtDateTime(pg.first_viewed_at))}）`
        : '🎬 紹介ページ 未開封';
      pgLine = `<div class="sl-mail-meta">${viewed}${pg.revoked_at ? '　⛔ 公開停止中' : ''}
        ${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">ページを見る</a>` : ''}
        ${pg.can_revoke && !pg.revoked_at ? ` <button type="button" class="sl-linkbtn" data-d="revoke" data-id="${esc(pg.id)}">公開を止める</button>` : ''}</div>`;
    }
    return `<div class="sl-mail-item">
      <div class="sl-mail-top">${badge}<span class="sl-mail-subj">${esc(x.subject || '（件名なし）')}</span>
        <button type="button" class="btn-sm" data-d="open-mail" data-id="${esc(x.id)}">${btn}</button></div>
      <div class="sl-mail-meta">${esc(when)}　差出人: ${esc(nameOf(x.sender_name))}${proxy}　宛先: ${esc(x.to_email || '')}${x.ai_generated ? '　✨AI下書き' : ''}</div>
      ${x.status === 'failed' && x.error_message ? `<div class="sl-mail-meta sl-due">⚠ ${esc(x.error_message)}</div>` : ''}
      ${pgLine}</div>`;
  }

  // 詳細モーダルのイベント（モーダル 1 つにつき 1 回だけ張る。中身は renderDetail で差し替わる）
  function bindDetail(d) {
    const el = d.modal.el;
    const idPath = `/contacts/${encodeURIComponent(d.id)}`;
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-d]');
      if (!b || !d.data) return;
      const act = b.dataset.d;
      const c = d.data.contact;
      if (act === 'edit') openContactForm(c);
      else if (act === 'card') withBusy(b, () => showCardImage(d.id));
      else if (act === 'new-mail') openComposer(d, null);
      else if (act === 'open-mail') { const x = (d.data.mails || []).find((y) => y.id === b.dataset.id); if (x) openComposer(d, x); }
      else if (act === 'revoke') {
        const ok = await confirmDlg({ title: '紹介ページの公開を止める', message: 'このURLを開いても動画が見られなくなります。止めますか？', okLabel: '公開を止める', okVariant: 'danger' });
        if (!ok) return;
        try { await send('POST', `/promo-pages/${encodeURIComponent(b.dataset.id)}/revoke`, {}); toast('公開を止めました', 'success'); await refreshDetail(); } catch (err) { toast(err.message, 'error'); }
      } else if (act === 'archive') {
        const ok = await confirmDlg({ title: 'アーカイブ', message: `${c.name} さんの名刺をアーカイブしますか？\n一覧から外れます（「🗄 アーカイブ済みを見る」で確認できます）。`, okLabel: 'アーカイブする', okVariant: 'danger' });
        if (!ok) return;
        try { await api(idPath, { method: 'DELETE' }); d.modal.close(); toast('アーカイブしました', 'success'); await loadContacts(); } catch (err) { toast(err.message, 'error'); }
      }
    });
    el.addEventListener('change', async (e) => {
      const t = e.target;
      if (!d.data) return;
      try {
        if (t.matches('[data-d="stage"]')) {
          const r = await send('POST', `${idPath}/stage`, { stage: t.value });
          Object.assign(d.data.contact, r.contact || {});
          mergeContact(r.contact);
          renderBody();
          toast(`進み具合を「${stageOf(t.value).label}」にしました`, 'success');
          return;
        }
        const f = t.dataset && t.dataset.f;
        if (!f) return;
        let v;
        if (f === 'do_not_email') v = t.checked;
        else if (f === 'expected_amount') {
          const s = t.value.trim();
          v = s === '' ? null : Math.floor(Number(s));
          if (v !== null && (!Number.isFinite(v) || v < 0)) { toast('見込み金額は 0 以上の数字で入れてください', 'error'); await refreshDetail(); return; }
        } else v = t.value.trim() || null;
        const r = await send('PATCH', idPath, { [f]: v });
        Object.assign(d.data.contact, r.contact || {});
        mergeContact(r.contact);
        renderBody();
        if (f === 'do_not_email' || f === 'next_action_on') await refreshDetail();
      } catch (err) {
        toast(err.message, 'error');
        await refreshDetail();     // 失敗したら画面をサーバーの値に戻す
      }
    });
  }

  async function showCardImage(id) {
    try {
      const r = await api(`/contacts/${encodeURIComponent(id)}/card`);
      if (!isImageDataUrl(r.image_data)) throw new Error('名刺画像を表示できませんでした');
      const m = openModal({ title: '🪪 名刺画像', width: 760 });
      const img = document.createElement('img');
      img.className = 'sl-cardview';
      img.alt = '名刺画像';
      img.src = r.image_data;
      m.body.appendChild(img);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ───────────────── プロモ動画 ─────────────────
  async function ensureVideos(force) {
    if (!state.videos || force) {
      const r = await api('/videos');
      state.videos = r.videos || [];
    }
    return state.videos;
  }

  async function openVideos() {
    const m = openModal({ title: '🎬 プロモ動画', width: 660 });
    const ctx = { editId: null };
    m.body.innerHTML = '<div class="sl-empty">読み込み中…</div>';
    m.foot.innerHTML = '<button type="button" class="btn" data-act="modal-close">閉じる</button>';
    function render() {
      const vs = state.videos || [];
      const ed = ctx.editId ? vs.find((v) => v.id === ctx.editId) : null;
      m.body.innerHTML = `
        <div class="sl-hint" style="margin:0 0 10px">YouTube / Vimeo のURLを登録すると、メールに付ける紹介ページでまとめて見せられます。</div>
        <div class="sl-grid c2">${field('v_title', 'タイトル *', { value: ed ? ed.title : '' })}${field('v_url', 'URL（YouTube / Vimeo）*', { value: ed ? ed.url : '', inputmode: 'url', placeholder: 'https://' })}</div>
        <div class="sl-grid">${field('v_desc', '説明', { value: ed ? ed.description : '' })}</div>
        <div class="sl-d-row"><button type="button" class="btn-primary" data-v="save">${ed ? '更新する' : '追加する'}</button>${ed ? '<button type="button" class="btn" data-v="cancel">やめる</button>' : ''}</div>
        <div>${vs.length ? vs.map((v) => {
          const thumb = safeUrl(v.thumbnail_url);
          const url = safeUrl(v.url);
          return `<div class="sl-vrow${v.is_active === false ? ' is-off' : ''}">
            ${thumb ? `<img class="sl-vthumb" src="${esc(thumb)}" alt="" loading="lazy">` : '<span class="sl-vthumb">🎬</span>'}
            <div class="sl-vmain"><b>${esc(v.title)}</b>${v.is_active === false ? ' <span class="sl-badge">非表示中</span>' : ''}
              <div>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(v.url)}</a>` : esc(v.url || '')}</div>
              ${v.description ? `<div class="sl-muted">${esc(v.description)}</div>` : ''}</div>
            <div class="sl-vacts"><button type="button" class="btn-sm" data-v="edit" data-id="${esc(v.id)}">編集</button>
              <button type="button" class="btn-sm" data-v="toggle" data-id="${esc(v.id)}">${v.is_active === false ? '再表示' : '非表示'}</button></div>
          </div>`;
        }).join('') : '<div class="sl-empty">まだ動画がありません</div>'}</div>`;
    }
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const act = b.dataset.v;
      const get = (n) => String(m.body.querySelector(`[name="${n}"]`).value || '').trim();
      try {
        if (act === 'edit') { ctx.editId = b.dataset.id; render(); m.el.scrollTop = 0; }
        else if (act === 'cancel') { ctx.editId = null; render(); }
        else if (act === 'toggle') {
          const v = (state.videos || []).find((x) => x.id === b.dataset.id);
          if (!v) return;
          await withBusy(b, () => send('PATCH', `/videos/${encodeURIComponent(v.id)}`, { is_active: v.is_active === false }));
          await ensureVideos(true); render();
        } else if (act === 'save') {
          const body = { title: get('v_title'), url: get('v_url'), description: get('v_desc') || null };
          if (!body.title) { toast('タイトルを入力してください', 'error'); return; }
          if (!safeUrl(body.url)) { toast('URL は https:// から始まる形で入れてください', 'error'); return; }
          await withBusy(b, () => (ctx.editId ? send('PATCH', `/videos/${encodeURIComponent(ctx.editId)}`, body) : send('POST', '/videos', body)));
          toast(ctx.editId ? '更新しました' : '追加しました', 'success');
          ctx.editId = null;
          await ensureVideos(true); render();
        }
      } catch (err) { toast(err.message, 'error'); }
    });
    try { await ensureVideos(true); render(); } catch (e) { m.body.innerHTML = `<div class="sl-empty">読み込めませんでした：${esc(e.message)}</div>`; }
  }

  // ───────────────── メール設定（Gmail 連携・代理・AI・署名） ─────────────────
  function goGmailConnect(resume) {
    try {
      if (resume) sessionStorage.setItem(RESUME_SS_KEY, JSON.stringify(resume));
      else sessionStorage.removeItem(RESUME_SS_KEY);
    } catch (_) {}
    window.location.href = '/oauth/google/start?purpose=gmail&next=' + encodeURIComponent('/haruka.html?page=sales');
  }

  function openSettings() {
    const m = openModal({ title: '⚙ メール設定', width: 600 });
    m.foot.innerHTML = '<button type="button" class="btn" data-act="modal-close">閉じる</button>';
    function render() {
      const b = state.boot || {};
      const g = b.gmail || {};
      const ai = b.ai || {};
      const dl = b.delegates || {};
      const iAllow = dl.i_allow || [];
      const allowedBy = dl.allowed_by || [];
      const taken = new Set([meId(), ...iAllow.map((x) => x.user_id)]);
      const cands = (b.members || []).filter((x) => !taken.has(x.id));
      const gmailHtml = !g.configured
        ? '<span>Gmail連携はまだ準備中です（管理者の設定待ち）。</span>'
        : g.connected
          ? '<span>✅ 連携済み</span> <button type="button" class="btn-sm" data-s="disconnect">解除</button>'
          : `<span>未連携</span> <button type="button" class="btn-primary" data-s="connect"${viewAs() ? ' disabled' : ''}>Gmailと連携する</button>`;
      m.body.innerHTML = `
        <div class="sl-set-block"><h4>Gmail連携${b.me && b.me.email ? ` <small class="sl-muted">（${esc(b.me.email)}）</small>` : ''}</h4>
          <div class="sl-set-line">${gmailHtml}</div>
          <div class="sl-hint">メールはあなた自身のGmailから送られ、返信もあなたの受信箱に届きます。HFSが使うのは「送信」だけで、受信箱は読みません。</div></div>
        <div class="sl-set-block"><h4>代理送信を認める人</h4>
          <div class="sl-hint">ここに追加した人は、あなたの名前（あなたのGmail）でメールを作って送れます。</div>
          <div class="sl-set-line"><select class="sl-select" data-s="pick"><option value="">メンバーを選ぶ</option>${cands.map((x) => `<option value="${esc(x.id)}">${esc(nameOf(x.name))}</option>`).join('')}</select>
            <button type="button" class="btn-sm" data-s="add">追加</button></div>
          ${iAllow.length ? iAllow.map((x) => `<div class="sl-set-line"><span>・${esc(nameOf(x.name))}</span><button type="button" class="btn-sm" data-s="remove" data-id="${esc(x.user_id)}">取り消す</button></div>`).join('') : '<div class="sl-set-line sl-muted">まだ誰にも認めていません</div>'}</div>
        <div class="sl-set-block"><h4>あなたに代理を認めている人</h4>
          ${allowedBy.length ? allowedBy.map((x) => `<div class="sl-set-line"><span>・${esc(nameOf(x.name))}</span></div>`).join('') : '<div class="sl-set-line sl-muted">いません</div>'}</div>
        <div class="sl-set-block"><h4>AI（名刺の読み取り・メールの下書き）</h4>
          <div>${ai.enabled ? `今月 ¥${Number(ai.used_jpy || 0).toLocaleString('ja-JP')} / 上限 ¥${Number(ai.budget_jpy || 0).toLocaleString('ja-JP')}${ai.available ? '' : '　<span class="sl-due">上限に達したため今月は手入力になります</span>'}` : '今は使えません（手入力でお使いください）'}</div></div>
        <div class="sl-set-block"><h4>署名（自動で付きます）</h4>
          <div class="sl-footer-text">${esc(b.mail_footer || '')}</div>
          <div class="sl-hint">1通につき宛先は1件・1日 ${Number(b.daily_send_limit || 50)} 通まで送れます。</div></div>`;
    }
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-s]');
      if (!b || b.tagName === 'SELECT') return;
      const act = b.dataset.s;
      try {
        if (act === 'connect') goGmailConnect(null);
        else if (act === 'disconnect') {
          const ok = await confirmDlg({ title: 'Gmail連携を解除', message: '解除すると、もう一度連携するまでメールを送れません。解除しますか？', okLabel: '解除する', okVariant: 'danger' });
          if (!ok) return;
          await withBusy(b, () => send('POST', '/gmail/disconnect', {}));
          await loadBootstrap(); render(); toast('Gmail連携を解除しました', 'success');
        } else if (act === 'add') {
          const id = m.body.querySelector('[data-s="pick"]').value;
          if (!id) { toast('メンバーを選んでください', 'error'); return; }
          const r = await withBusy(b, () => send('POST', '/delegates', { delegate_user_id: id }));
          if (r && r.delegates) state.boot.delegates = r.delegates;
          render(); toast('代理送信を認めました', 'success');
        } else if (act === 'remove') {
          const ok = await confirmDlg({ title: '代理の取り消し', message: 'この人はあなたの名前でメールを送れなくなります。取り消しますか？', okLabel: '取り消す', okVariant: 'danger' });
          if (!ok) return;
          const r = await withBusy(b, () => send('DELETE', `/delegates/${encodeURIComponent(b.dataset.id)}`, {}));
          if (r && r.delegates) state.boot.delegates = r.delegates;
          render(); toast('取り消しました', 'success');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
    render();
  }

  // ───────────────── メール作成 ─────────────────
  async function openComposer(d, mail) {
    const contact = d.data.contact;
    const me = (state.boot && state.boot.me) || {};
    const isSent = !!mail && (mail.status === 'sent' || mail.status === 'sending');
    const readOnly = isSent || (!!mail && !mail.can_send);
    const page = mail ? pageOf(d.data, mail.promo_page_id) : null;
    const ctx = {
      mailId: mail ? mail.id : null,
      promoPageId: page ? page.id : null,
      promoVideoIds: page ? (page.video_ids || []).slice() : [],
      promoUrl: page ? safeUrl(page.url) : '',
      aiGenerated: !!(mail && mail.ai_generated),
      dirty: false,
    };
    const m = openModal({
      title: `✉ ${readOnly ? 'メール' : 'メールを作る'} ─ ${contact.name} 様`, width: 700,
      guard: () => !readOnly && ctx.dirty,
    });
    m.body.innerHTML = '<div class="sl-empty">読み込み中…</div>';
    let videos = [];
    try { videos = await ensureVideos(false); } catch (e) { toast(`動画一覧を読み込めませんでした：${e.message}`, 'error'); }
    if (m.closed) return;

    // 差出人 = 自分 ＋ 自分に代理を認めてくれた人だけ
    const senders = [{ id: me.id, label: `${nameOf(me.name)}（本人）` }]
      .concat(((state.boot.delegates || {}).allowed_by || []).map((x) => ({ id: x.user_id, label: `${nameOf(x.name)}（代理）` })));
    const senderId = mail ? mail.sender_user_id : me.id;
    if (!senders.some((s) => s.id === senderId)) senders.push({ id: senderId, label: nameOf(mail && mail.sender_name) });
    const ro = readOnly ? ' disabled' : '';
    const shown = videos.filter((v) => v.is_active !== false || ctx.promoVideoIds.includes(v.id));
    const ai = (state.boot && state.boot.ai) || {};
    const aiUsable = !!(ai.enabled && ai.available);

    m.body.innerHTML = `
      <div data-k="banner"></div>
      <div class="sl-grid c2">
        <label class="sl-field"><span>差出人</span><select class="form-input" data-k="sender"${ro}>${senders.map((s) => `<option value="${esc(s.id)}"${s.id === senderId ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
        <label class="sl-field"><span>宛先（1件だけ）</span><input type="email" class="form-input" data-k="to" inputmode="email" autocomplete="off" value="${esc(mail ? mail.to_email : (contact.email || ''))}"${ro}></label>
      </div>
      <label class="sl-field" style="margin-bottom:10px"><span>件名</span><input type="text" class="form-input" data-k="subject" value="${esc(mail ? mail.subject : '')}"${ro}></label>
      <label class="sl-field" style="margin-bottom:10px"><span>本文</span><textarea class="form-input" rows="10" data-k="body"${ro}>${esc(mail ? mail.body : '')}</textarea></label>
      ${readOnly ? '' : `<div class="sl-ai-row">
        <button type="button" class="btn-sm" data-k="ai"${aiUsable ? '' : ' disabled'}>✨ AIで下書き</button>
        <input type="text" class="form-input" data-k="inst" placeholder="追加の指示（例: 採用動画の話を入れて）"${aiUsable ? '' : ' disabled'}>
        ${aiUsable ? '' : `<span class="sl-hint">${esc(AI_OFF_MSG)}</span>`}
      </div>`}
      <div class="sl-field" style="margin-bottom:10px"><span>🎬 付ける動画（選ぶと紹介ページのURLを発行して本文に付けます）</span>
        <div class="sl-videos" data-k="videos">${shown.length ? shown.map((v) => `<label class="sl-check"><input type="checkbox" value="${esc(v.id)}"${ctx.promoVideoIds.includes(v.id) ? ' checked' : ''}${ro}> ${esc(v.title)}</label>`).join('') : '<span class="sl-muted">動画はまだ登録されていません（一覧の「🎬 プロモ動画」から登録できます）</span>'}</div>
      </div>
      <div class="sl-sec">${isSent ? '送った文面' : '送られる文面のイメージ（署名つき）'}</div>
      <div class="sl-preview" data-k="preview"></div>
      ${isSent ? '' : '<div class="sl-hint">最終の文面は、送信前の確認画面でもう一度表示します。</div>'}`;

    const q = (k) => m.body.querySelector(`[data-k="${k}"]`);
    const selectedVideoIds = () => shown.filter((v) => { const cb = q('videos').querySelector(`input[value="${CSS.escape(String(v.id))}"]`); return cb && cb.checked; }).map((v) => v.id);
    const cur = () => ({ sender: q('sender').value, to: q('to').value.trim(), subject: q('subject').value.trim(), body: q('body').value });

    function localPreview() {
      const v = cur();
      const sel = selectedVideoIds();
      let text = v.body.replace(/\s+$/, '');
      if (sel.length) {
        const url = (ctx.promoUrl && sameIds(sel, ctx.promoVideoIds)) ? ctx.promoUrl : '（保存すると紹介ページのURLが入ります）';
        text += `\n\n▼ 作品のご紹介\n${url}`;
      }
      const footer = (state.boot && state.boot.mail_footer) || '';
      if (footer) text += `\n\n${footer}`;
      q('preview').textContent = text;
    }
    function renderBanner() {
      const g = (state.boot && state.boot.gmail) || {};
      const notes = [];
      const mine = cur().sender === me.id;
      if (readOnly) {
        if (mail.status === 'sent') notes.push(`<div class="sl-note is-info">送信済み（${esc(fmtDateTime(mail.sent_at))}${mail.sent_by_name ? `・送信: ${esc(nameOf(mail.sent_by_name))}` : ''}）。内容は変更できません。</div>`);
        else if (mail.status === 'sending') notes.push('<div class="sl-note is-info">送信中です。</div>');
        else notes.push('<div class="sl-note is-info">この下書きは差出人本人か、本人が代理に認めた人だけが編集・送信できます（閲覧のみ）。</div>');
      } else {
        if (viewAs()) notes.push('<div class="sl-note">VIEW AS 中は送信できません。</div>');
        if (contact.do_not_email) notes.push('<div class="sl-note is-danger">「今後メールを送らない」の方です。送信できません。</div>');
        if (mail && mail.status === 'failed') notes.push(`<div class="sl-note is-danger">前回の送信は失敗しました${mail.error_message ? `：${esc(mail.error_message)}` : ''}</div>`);
        if (!mine) notes.push('<div class="sl-note is-info">代理で送ります。差出人本人がGmail連携を済ませている必要があります（未連携だと送信時にお知らせします）。</div>');
        else if (!g.configured) notes.push('<div class="sl-note">Gmail連携がまだ準備中のため、送信はできません（下書きは保存できます）。</div>');
        else if (!g.connected) notes.push('<div class="sl-note">Gmailと連携すると送信できます。 <button type="button" class="btn-sm" data-k="connect">Gmailと連携する</button>（下書きを保存してから移動します）</div>');
      }
      q('banner').innerHTML = notes.join('');
    }
    function syncButtons() {
      const sendBtn = m.foot.querySelector('[data-k="send"]');
      if (!sendBtn) return;
      const g = (state.boot && state.boot.gmail) || {};
      const mine = cur().sender === me.id;
      const blocked = viewAs() ? 'VIEW AS 中は送信できません'
        : contact.do_not_email ? '「今後メールを送らない」の方です'
          : (mine && !g.configured) ? 'Gmail連携が準備中です' : '';
      sendBtn.disabled = !!blocked;
      sendBtn.title = blocked;
    }

    if (readOnly) {
      m.foot.innerHTML = '<button type="button" class="btn" data-act="modal-close">閉じる</button>';
      if (isSent) {
        q('preview').textContent = mail.body || '';
        // 実際に送った文面（署名・紹介ページURLつき）をサーバーから取れたら差し替える
        api(`/mails/${encodeURIComponent(mail.id)}/preview`).then((pv) => { if (!m.closed && pv && pv.final_body) q('preview').textContent = pv.final_body; }).catch(() => {});
      } else localPreview();
      renderBanner();
      return;
    }

    m.foot.innerHTML = `${ctx.mailId ? '<button type="button" class="btn-danger sl-left" data-k="delete">削除</button>' : ''}
      <button type="button" class="btn" data-k="save">下書き保存</button>
      <button type="button" class="sl-btn-send" data-k="send">確認して送信</button>`;
    renderBanner(); syncButtons(); localPreview();

    m.body.addEventListener('input', () => { ctx.dirty = true; localPreview(); });
    m.body.addEventListener('change', (e) => {
      if (e.target.matches('[data-k="sender"]')) { renderBanner(); syncButtons(); }
      ctx.dirty = true;
      localPreview();
    });

    function validate(forSend) {
      const v = cur();
      if (!v.to) { toast('宛先のメールアドレスを入力してください', 'error'); q('to').focus(); return null; }
      if (!isSingleEmail(v.to)) { toast('宛先は1件だけ、正しいメールアドレスで入れてください（カンマ・空白は使えません）', 'error'); q('to').focus(); return null; }
      if (forSend && !v.subject) { toast('件名を入力してください', 'error'); q('subject').focus(); return null; }
      if (forSend && !v.body.trim()) { toast('本文を入力してください', 'error'); q('body').focus(); return null; }
      return v;
    }
    // 下書き保存。動画が選ばれていて未発行（または選び直した）なら紹介ページを発行して付ける
    async function saveDraft(v) {
      const sel = selectedVideoIds();
      if (!sel.length) { ctx.promoPageId = null; ctx.promoVideoIds = []; ctx.promoUrl = ''; }
      else if (!ctx.promoPageId || !sameIds(sel, ctx.promoVideoIds)) {
        const r = await send('POST', '/promo-pages', { contact_id: contact.id, video_ids: sel });
        ctx.promoPageId = r.page.id; ctx.promoVideoIds = sel; ctx.promoUrl = safeUrl(r.page.url);
      }
      const payload = { contact_id: contact.id, sender_user_id: v.sender, to_email: v.to, subject: v.subject, body: v.body, promo_page_id: ctx.promoPageId, ai_generated: ctx.aiGenerated };
      const r = ctx.mailId ? await send('PATCH', `/mails/${encodeURIComponent(ctx.mailId)}`, payload) : await send('POST', '/mails', payload);
      ctx.mailId = r.mail.id;
      ctx.dirty = false;
      localPreview();
    }
    async function afterChange(close) {
      if (close) { ctx.dirty = false; m.close(); }
      await Promise.all([refreshDetail(), loadContacts()]);
    }

    m.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      if (b.dataset.k === 'connect') {
        const v = validate(false);
        if (!v) return;
        try { await withBusy(b, () => saveDraft(v)); goGmailConnect({ contactId: contact.id, mailId: ctx.mailId }); } catch (err) { toast(err.message, 'error'); }
      } else if (b.dataset.k === 'ai') {
        const v = cur();
        if (v.subject || v.body.trim()) {
          const ok = await confirmDlg({ title: 'AIで下書き', message: '今の件名・本文をAIの下書きで置き換えます。よろしいですか？', okLabel: '置き換える' });
          if (!ok) return;
        }
        await withBusy(b, async () => {
          const label = b.textContent;
          b.textContent = '✨ 作成中…';
          try {
            const r = await send('POST', '/mails/ai-draft', { contact_id: contact.id, sender_user_id: v.sender, video_ids: selectedVideoIds(), instructions: q('inst').value.trim() });
            q('subject').value = r.subject || '';
            q('body').value = r.body || '';
            ctx.aiGenerated = true; ctx.dirty = true;
            localPreview();
            toast('下書きを入れました。内容を必ず確認して直してください', 'success');
          } catch (err) { toast(isAiOff(err) ? AI_OFF_MSG : err.message, isAiOff(err) ? 'info' : 'error'); } finally { b.textContent = label; }
        });
      }
    });

    m.foot.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const k = b.dataset.k;
      if (k === 'save') {
        const v = validate(false);
        if (!v) return;
        try { await withBusy(b, () => saveDraft(v)); toast('下書きを保存しました', 'success'); await afterChange(true); } catch (err) { toast(err.message, 'error'); }
      } else if (k === 'delete') {
        const ok = await confirmDlg({ title: '下書きを削除', message: 'この下書きを削除しますか？', okLabel: '削除する', okVariant: 'danger' });
        if (!ok) return;
        try { await withBusy(b, () => api(`/mails/${encodeURIComponent(ctx.mailId)}`, { method: 'DELETE' })); toast('削除しました', 'success'); await afterChange(true); } catch (err) { toast(err.message, 'error'); }
      } else if (k === 'send') {
        const v = validate(true);
        if (!v) return;
        await withBusy(b, async () => {
          let pv;
          try {
            await saveDraft(v);
            pv = await api(`/mails/${encodeURIComponent(ctx.mailId)}/preview`);
          } catch (err) { toast(err.message, 'error'); return; }
          if (!m.foot.querySelector('[data-k="delete"]')) m.foot.insertAdjacentHTML('afterbegin', '<button type="button" class="btn-danger sl-left" data-k="delete">削除</button>');
          const ok = await askModal({
            title: '✉ 送信前の確認', width: 600, okLabel: 'この宛先に送信する', cancelLabel: '戻って直す', okClass: 'sl-btn-send',
            html: `<div class="sl-hint" style="margin:0">宛先（送信すると取り消せません）</div>
              <div class="sl-confirm-to">${esc(pv.to_email || '')}</div>
              <dl class="sl-confirm-dl"><dt>差出人</dt><dd>${esc(nameOf(pv.from_name))}${pv.from_email ? ` &lt;${esc(pv.from_email)}&gt;` : ''}</dd>
                <dt>お相手</dt><dd>${esc(contact.name)}${contact.company ? `（${esc(contact.company)}）` : ''}</dd>
                <dt>件名</dt><dd>${esc(pv.subject || '')}</dd></dl>
              <div class="sl-preview">${esc(pv.final_body || '')}</div>`,
          });
          if (!ok) return;
          try {
            await send('POST', `/mails/${encodeURIComponent(ctx.mailId)}/send`, { confirm_to_email: pv.to_email });
            toast(`${pv.to_email} に送信しました`, 'success');
            await afterChange(true);
          } catch (err) {
            if (err.code === 'gmail_not_connected') {
              if (v.sender === me.id) {
                const go = await confirmDlg({ title: 'Gmail連携が必要です', message: 'メールを送るには、あなたのGmailとの連携が必要です。\n下書きは保存済みです。連携の画面へ進みますか？', okLabel: 'Gmailと連携する' });
                if (go) goGmailConnect({ contactId: contact.id, mailId: ctx.mailId });
              } else toast('差出人ご本人のGmail連携がまだです。ご本人に「⚙ メール設定」から連携してもらってください（下書きは保存済みです）', 'error');
            } else if (err.code === 'recipient_mismatch') {
              toast('確認した宛先と下書きの宛先が一致しませんでした。開き直してもう一度確認してください', 'error');
              await afterChange(true);
            } else if (err.code === 'already_sent') {
              toast('このメールはすでに送信済みです', 'info');
              await afterChange(true);
            } else {
              toast(err.message, 'error');      // not_allowed / view_as / daily_limit / do_not_email など
              await afterChange(false);
            }
          }
        });
      }
    });
  }

  // ───────────────── 入口 ─────────────────
  function consumeReturnParams() {
    let result = null;
    try {
      const u = new URL(window.location.href);
      result = u.searchParams.get('gmail_oauth');
      if (result) {
        u.searchParams.delete('gmail_oauth');
        window.history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash);
      }
    } catch (_) {}
    return result;
  }
  async function resumeAfterOauth() {
    let resume = null;
    try { resume = JSON.parse(sessionStorage.getItem(RESUME_SS_KEY) || 'null'); sessionStorage.removeItem(RESUME_SS_KEY); } catch (_) {}
    if (!resume || !resume.contactId) return;
    await openDetail(resume.contactId);
    const d = state.detail;
    const mail = d && d.data && (d.data.mails || []).find((x) => x.id === resume.mailId);
    if (mail) openComposer(d, mail);
  }

  async function loadSalesPage() {
    renderShell();
    if (!$('sl-body')) return;
    const oauth = consumeReturnParams();
    try {
      await loadBootstrap();
      await loadContacts();
    } catch (e) {
      $('sl-body').innerHTML = `<div class="sl-empty">読み込めませんでした：${esc(e.message)}</div>`;
      return;
    }
    if (oauth) {
      if (oauth === 'connected') { toast('Gmailと連携しました。メールを送れます', 'success'); await resumeAfterOauth(); }
      else { toast('Gmailと連携できませんでした。もう一度お試しください', 'error'); try { sessionStorage.removeItem(RESUME_SS_KEY); } catch (_) {} }
    }
  }

  window.loadSalesPage = loadSalesPage;
  window.Sales = {
    openContact: openDetail,
    reload: loadContacts,
    closeAll: closeAllModals,
  };
})(window, document);

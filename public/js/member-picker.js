/**
 * MemberPicker — メンバー選択 UI の共通部品（ADR 014）
 *
 * 公開 API:
 *   MemberPicker.open(triggerEl, options)         任意トリガーから開く
 *   MemberPicker.bindSelect(selectEl, options)    既存 <select> を picker に置き換え
 *   MemberPicker.loadMembers()                    /members を取得（キャッシュ）
 *   MemberPicker.invalidateCache()                キャッシュ破棄（メンバー変更時に呼ぶ）
 *   MemberPicker.memberLabel(member)              "nickname（full_name）" 形式の表示文字列
 *
 * options:
 *   mode:          'single' | 'multi'             既定 'single'
 *   value:         id | id[] | null
 *   allowedRoles:  ['producer', ...] | null       null なら全ロール
 *   showInactive:  boolean                        既定 false
 *   emptyLabel:    string | null                  null 許容の選択肢ラベル
 *   onChange:      (value) => void
 *   title:         string                         モーダルのタイトル
 */
(function () {
  'use strict';

  // ───────── ロール定義（ADR 003 / users.role の正準形）─────────
  const ROLE_DEFS = [
    { value: 'admin',             short: '管理',     order: 1 },
    { value: 'secretary',         short: '事務',     order: 2 },
    { value: 'producer',          short: 'P',        order: 3 },
    { value: 'producer_director', short: 'P/D',      order: 4 },
    { value: 'director',          short: 'D',        order: 5 },
    { value: 'editor',            short: '編集',     order: 6 },
    { value: 'designer',          short: 'デザイン', order: 7 },
  ];
  const ROLE_BY_VALUE = Object.fromEntries(ROLE_DEFS.map(r => [r.value, r]));

  // ───────── 共有キャッシュ ─────────
  let cachedMembers = null;
  let cachedFetchPromise = null;

  function loadMembers() {
    if (cachedMembers) return Promise.resolve(cachedMembers);
    if (cachedFetchPromise) return cachedFetchPromise;
    // routes/haruka.js は /api/haruka 配下にマウントされている
    cachedFetchPromise = fetch('/api/haruka/members', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        cachedMembers = Array.isArray(data) ? data : [];
        cachedFetchPromise = null;
        return cachedMembers;
      })
      .catch(err => {
        cachedFetchPromise = null;
        console.error('[MemberPicker] /members 取得失敗:', err);
        return [];
      });
    return cachedFetchPromise;
  }
  function invalidateCache() {
    cachedMembers = null;
    cachedFetchPromise = null;
  }

  // ───────── ユーティリティ ─────────
  function memberLabel(m) {
    if (!m) return '';
    const nick = (m.nickname || '').trim();
    const full = (m.full_name || '').trim();
    if (nick && full && nick !== full) return `${nick}（${full}）`;
    return nick || full || '(名前未設定)';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function matchSearch(m, q) {
    if (!q) return true;
    const k = q.toLowerCase();
    return (m.full_name || '').toLowerCase().includes(k)
        || (m.nickname  || '').toLowerCase().includes(k);
  }

  // ───────── CSS 注入（一度だけ）─────────
  function ensureStyles() {
    if (document.getElementById('mp-styles')) return;
    const css = `
      .mp-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 10020; display: flex; align-items: center; justify-content: center; padding: 16px; }
      .mp-backdrop.hidden { display: none; }
      .mp-modal { background: #fff; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.25); width: min(520px, 100%); max-height: min(80vh, 640px); display: flex; flex-direction: column; overflow: hidden; }
      .mp-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #E5E7EB; }
      .mp-title { font-weight: 600; font-size: 15px; color: #0F172A; }
      .mp-close { background: transparent; border: none; font-size: 22px; line-height: 1; color: #64748B; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
      .mp-close:hover { background: #F1F5F9; color: #0F172A; }
      .mp-search { padding: 10px 16px 6px; }
      .mp-search-input { width: 100%; padding: 8px 12px; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.15s; box-sizing: border-box; }
      .mp-search-input:focus { border-color: #0EA5A5; box-shadow: 0 0 0 3px rgba(14,165,165,0.12); }
      .mp-roles { padding: 4px 16px 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .mp-roles-label { font-size: 11px; color: #64748B; margin-right: 4px; }
      .mp-role-chip { font-size: 11px; padding: 3px 10px; border-radius: 999px; border: 1px solid #CBD5E1; background: transparent; color: #64748B; cursor: pointer; line-height: 1.5; }
      .mp-role-chip:hover { background: #F1F5F9; }
      .mp-role-chip.mp-role-active { background: #0EA5A5; border-color: #0EA5A5; color: #fff; }
      .mp-list { flex: 1 1 auto; overflow-y: auto; padding: 4px 8px 8px; min-height: 120px; }
      .mp-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; user-select: none; }
      .mp-item:hover { background: #F8FAFC; }
      .mp-item.mp-item-selected { background: #ECFEFF; }
      .mp-item input { margin: 0; flex: 0 0 auto; cursor: pointer; }
      .mp-item-name { flex: 1 1 auto; font-size: 13.5px; color: #0F172A; }
      .mp-item-role { flex: 0 0 auto; font-size: 11px; color: #64748B; padding: 2px 8px; border-radius: 999px; background: #F1F5F9; }
      .mp-divider { padding: 6px 12px; font-size: 11px; color: #94A3B8; border-top: 1px dashed #E5E7EB; margin-top: 6px; }
      .mp-empty { padding: 24px 16px; text-align: center; color: #94A3B8; font-size: 13px; }
      .mp-footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid #E5E7EB; gap: 8px; }
      .mp-count { font-size: 12px; color: #64748B; }
      .mp-actions { display: flex; gap: 6px; }
      .mp-btn { padding: 6px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
      .mp-btn-secondary { background: #fff; border-color: #CBD5E1; color: #475569; }
      .mp-btn-secondary:hover { background: #F1F5F9; }
      .mp-btn-primary { background: #0EA5A5; border-color: #0EA5A5; color: #fff; font-weight: 600; }
      .mp-btn-primary:hover { background: #0D9488; }
      .mp-btn-link { background: transparent; border: none; color: #0EA5A5; font-size: 12px; cursor: pointer; padding: 4px 8px; }
      .mp-btn-link:hover { text-decoration: underline; }

      /* トリガー（旧 <select> 置き換え用ボタン）*/
      .mp-trigger { display: inline-flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; padding: 8px 12px; border: 1px solid #CBD5E1; border-radius: 8px; background: #fff; cursor: pointer; font-size: 14px; color: #0F172A; line-height: 1.4; box-sizing: border-box; text-align: left; min-height: 38px; }
      .mp-trigger:hover { border-color: #94A3B8; }
      .mp-trigger:focus { outline: none; border-color: #0EA5A5; box-shadow: 0 0 0 3px rgba(14,165,165,0.12); }
      .mp-trigger-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mp-trigger-placeholder { color: #94A3B8; }
      .mp-trigger-caret { flex: 0 0 auto; color: #94A3B8; font-size: 10px; }

      @media (max-width: 768px) {
        .mp-modal { max-height: 90vh; width: 100%; border-radius: 12px 12px 0 0; align-self: flex-end; }
        .mp-backdrop { align-items: flex-end; padding: 0; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'mp-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ───────── モーダル DOM（一度だけ生成）─────────
  function ensureModal() {
    let el = document.getElementById('mp-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mp-modal';
    el.className = 'mp-backdrop hidden';
    el.innerHTML = `
      <div class="mp-modal" role="dialog" aria-modal="true">
        <div class="mp-header">
          <span class="mp-title">メンバーを選択</span>
          <button type="button" class="mp-close" data-mp-action="cancel" aria-label="閉じる">×</button>
        </div>
        <div class="mp-search">
          <input type="text" class="mp-search-input" placeholder="名前・ニックネームで検索..." />
        </div>
        <div class="mp-roles"></div>
        <div class="mp-list"></div>
        <div class="mp-footer">
          <span class="mp-count"></span>
          <span class="mp-actions">
            <button type="button" class="mp-btn-link" data-mp-action="clear">全解除</button>
            <button type="button" class="mp-btn mp-btn-secondary" data-mp-action="cancel">キャンセル</button>
            <button type="button" class="mp-btn mp-btn-primary" data-mp-action="apply">選択</button>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.classList.contains('hidden')) close();
    });
    return el;
  }

  function close() {
    const el = document.getElementById('mp-modal');
    if (el) el.classList.add('hidden');
  }

  // ───────── open() ─────────
  async function open(triggerEl, options) {
    ensureStyles();
    const el = ensureModal();

    const opts = Object.assign({
      mode: 'single',
      value: null,
      allowedRoles: null,
      showInactive: false,
      emptyLabel: null,
      emptyValue: null, // emptyLabel が選ばれたときに返す sentinel 値（null 既定）
      onChange: () => {},
      title: 'メンバーを選択',
    }, options || {});

    el.classList.remove('hidden');
    el.querySelector('.mp-title').textContent = opts.title;
    const searchInput = el.querySelector('.mp-search-input');
    searchInput.value = '';

    const session = {
      query: '',
      activeRoles: new Set(),
      selectedIds: new Set(),
      includeEmpty: false,
    };
    const emptyValueStr = opts.emptyValue == null ? null : String(opts.emptyValue);
    if (opts.mode === 'multi' && Array.isArray(opts.value)) {
      opts.value.forEach(v => {
        if (v == null) return;
        if (emptyValueStr != null && String(v) === emptyValueStr) session.includeEmpty = true;
        else session.selectedIds.add(String(v));
      });
    } else if (opts.value != null && opts.value !== '') {
      if (emptyValueStr != null && String(opts.value) === emptyValueStr) session.includeEmpty = true;
      else session.selectedIds.add(String(opts.value));
    }

    const members = await loadMembers();
    const allowedRoles = Array.isArray(opts.allowedRoles) ? opts.allowedRoles : null;

    // ロール chip
    const roleHost = el.querySelector('.mp-roles');
    const visibleRoles = ROLE_DEFS.filter(r => !allowedRoles || allowedRoles.includes(r.value));
    roleHost.innerHTML = `<span class="mp-roles-label">ロール:</span>
      <button type="button" class="mp-role-chip" data-role="">全て</button>
      ${visibleRoles.map(r => `<button type="button" class="mp-role-chip" data-role="${r.value}">${escapeHtml(r.short)}</button>`).join('')}`;
    roleHost.querySelectorAll('.mp-role-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.role;
        if (v === '') session.activeRoles.clear();
        else if (session.activeRoles.has(v)) session.activeRoles.delete(v);
        else session.activeRoles.add(v);
        renderList();
      });
    });

    // 検索
    searchInput.oninput = (e) => { session.query = e.target.value; renderList(); };

    // ボタン
    el.querySelectorAll('[data-mp-action="cancel"]').forEach(b => b.onclick = close);
    el.querySelector('[data-mp-action="apply"]').onclick = () => commit();
    el.querySelector('[data-mp-action="clear"]').onclick = () => {
      session.selectedIds.clear();
      session.includeEmpty = false;
      renderList();
    };

    // 単一選択は apply ボタン非表示（即時確定）
    const applyBtn = el.querySelector('[data-mp-action="apply"]');
    const clearBtn = el.querySelector('[data-mp-action="clear"]');
    if (opts.mode === 'single') {
      applyBtn.style.display = 'none';
      clearBtn.style.display = 'none';
    } else {
      applyBtn.style.display = '';
      clearBtn.style.display = '';
    }

    function commit() {
      let value;
      if (opts.mode === 'multi') {
        value = Array.from(session.selectedIds);
        if (session.includeEmpty && opts.emptyValue != null) value.unshift(opts.emptyValue);
      } else if (session.includeEmpty) {
        value = opts.emptyValue;
      } else {
        value = session.selectedIds.size ? Array.from(session.selectedIds)[0] : null;
      }
      try { opts.onChange(value); } catch (e) { console.error('[MemberPicker] onChange threw:', e); }
      close();
    }

    function renderList() {
      const filtered = members
        .filter(m => opts.showInactive || m.is_active !== false)
        .filter(m => !allowedRoles || allowedRoles.includes(m.role))
        .filter(m => session.activeRoles.size === 0 || session.activeRoles.has(m.role))
        .filter(m => matchSearch(m, session.query));

      // chip selected state
      roleHost.querySelectorAll('.mp-role-chip').forEach(b => {
        const v = b.dataset.role;
        const active = (v === '' && session.activeRoles.size === 0) || (v !== '' && session.activeRoles.has(v));
        b.classList.toggle('mp-role-active', active);
      });

      const activeMembers = filtered.filter(m => m.is_active !== false);
      const inactiveMembers = filtered.filter(m => m.is_active === false);

      const renderItem = (m) => {
        const sel = session.selectedIds.has(String(m.id));
        const inputType = opts.mode === 'multi' ? 'checkbox' : 'radio';
        const roleDef = ROLE_BY_VALUE[m.role];
        const roleShort = roleDef ? roleDef.short : (m.role || '');
        return `<label class="mp-item${sel ? ' mp-item-selected' : ''}" data-id="${escapeHtml(m.id)}">
          <input type="${inputType}" name="mp-pick" ${sel ? 'checked' : ''} />
          <span class="mp-item-name">${escapeHtml(memberLabel(m))}</span>
          ${roleShort ? `<span class="mp-item-role">${escapeHtml(roleShort)}</span>` : ''}
        </label>`;
      };

      const listEl = el.querySelector('.mp-list');
      let html = '';
      if (opts.emptyLabel != null) {
        const sel = session.includeEmpty;
        html += `<label class="mp-item${sel ? ' mp-item-selected' : ''}" data-empty="1">
          <input type="${opts.mode === 'multi' ? 'checkbox' : 'radio'}" name="mp-pick" ${sel ? 'checked' : ''} />
          <span class="mp-item-name" style="color:#64748B">${escapeHtml(opts.emptyLabel)}</span>
        </label>`;
      }
      html += activeMembers.map(renderItem).join('');
      if (opts.showInactive && inactiveMembers.length) {
        html += `<div class="mp-divider">非アクティブ</div>` + inactiveMembers.map(renderItem).join('');
      }
      if (!html) html = '<div class="mp-empty">該当するメンバーがいません</div>';
      listEl.innerHTML = html;

      listEl.querySelectorAll('.mp-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          if (item.dataset.empty === '1') {
            if (opts.mode === 'multi') {
              session.includeEmpty = !session.includeEmpty;
            } else {
              session.selectedIds.clear();
              session.includeEmpty = true;
              commit();
              return;
            }
          } else {
            const id = String(item.dataset.id);
            if (opts.mode === 'multi') {
              if (session.selectedIds.has(id)) session.selectedIds.delete(id);
              else session.selectedIds.add(id);
              session.includeEmpty = false;
            } else {
              session.selectedIds.clear();
              session.selectedIds.add(id);
              session.includeEmpty = false;
              commit();
              return;
            }
          }
          renderList();
        });
      });

      const countEl = el.querySelector('.mp-count');
      countEl.textContent = opts.mode === 'multi' ? `選択中: ${session.selectedIds.size + (session.includeEmpty ? 1 : 0)}件` : '';
    }

    renderList();
    setTimeout(() => searchInput.focus(), 50);
  }

  // ───────── bindSelect() — 既存 <select> を置き換え ─────────
  function bindSelect(selectEl, options) {
    if (!selectEl) return null;
    if (selectEl.dataset && selectEl.dataset.mpBound === '1') return selectEl._mpTrigger || null;
    ensureStyles();

    const opts = Object.assign({
      mode: 'single',
      allowedRoles: null,
      showInactive: false,
      emptyLabel: null,
      onChange: null,
    }, options || {});

    // 既存属性を継承
    const id = selectEl.id;
    const name = selectEl.name || '';
    const className = selectEl.className || '';
    const styleAttr = selectEl.getAttribute('style') || '';
    const required = selectEl.required;
    const initial = selectEl.value || '';

    // hidden を作って form 互換にする
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    if (name) hidden.name = name;
    hidden.value = initial;
    if (required) hidden.setAttribute('data-required', '1');

    // トリガー要素
    const trigger = document.createElement('button');
    trigger.type = 'button';
    if (id) trigger.id = id;
    trigger.className = 'mp-trigger ' + className;
    if (styleAttr) trigger.setAttribute('style', styleAttr);
    trigger.dataset.mpBound = '1';
    trigger._mpHidden = hidden;
    trigger._mpOpts = opts;

    function refreshTriggerLabel() {
      const value = hidden.value;
      const placeholder = opts.placeholder || 'メンバーを選択';
      if (!value) {
        trigger.innerHTML = `<span class="mp-trigger-text mp-trigger-placeholder">${escapeHtml(placeholder)}</span><span class="mp-trigger-caret">▼</span>`;
        return;
      }
      // emptyValue（sentinel）にマッチしたら emptyLabel を表示
      if (opts.emptyValue != null && String(value) === String(opts.emptyValue)) {
        const lbl = opts.emptyLabel || placeholder;
        trigger.innerHTML = `<span class="mp-trigger-text">${escapeHtml(lbl)}</span><span class="mp-trigger-caret">▼</span>`;
        return;
      }
      loadMembers().then(members => {
        const m = members.find(x => String(x.id) === String(value));
        const label = m ? memberLabel(m) : '(不明なメンバー)';
        trigger.innerHTML = `<span class="mp-trigger-text">${escapeHtml(label)}</span><span class="mp-trigger-caret">▼</span>`;
      });
    }

    trigger.addEventListener('click', () => {
      open(trigger, Object.assign({}, opts, {
        value: hidden.value || null,
        onChange: (v) => {
          hidden.value = v == null ? '' : String(v);
          refreshTriggerLabel();
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
          if (typeof opts.onChange === 'function') opts.onChange(v);
        },
      }));
    });

    // 旧 <select> を入れ替え
    const parent = selectEl.parentNode;
    parent.replaceChild(trigger, selectEl);
    parent.insertBefore(hidden, trigger.nextSibling);
    refreshTriggerLabel();

    // 既存コードが selectEl.value で読み書きしている可能性があるので、
    // trigger に value プロパティを生やしておく
    Object.defineProperty(trigger, 'value', {
      get() { return hidden.value; },
      set(v) {
        const newVal = v == null ? '' : String(v);
        if (hidden.value !== newVal) {
          hidden.value = newVal;
          refreshTriggerLabel();
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },
      configurable: true,
    });
    // setOptions（実行時に allowedRoles を変えたい場合用）
    trigger.setMemberPickerOptions = (newOpts) => { Object.assign(opts, newOpts || {}); };

    selectEl._mpTrigger = trigger;
    return trigger;
  }

  window.MemberPicker = {
    open,
    bindSelect,
    loadMembers,
    invalidateCache,
    memberLabel,
    ROLE_DEFS,
  };
})();

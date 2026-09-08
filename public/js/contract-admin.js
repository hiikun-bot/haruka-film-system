/* ============================================================
 * contract-admin.js — 📝 契約管理（管理者用ページ #page-contract-admin）
 *   ADR 035（docs/design/decisions/035-contract-management.md）Stage 3。
 *   contract-wizard.js の window.HFSContract（API ラッパ・整形ヘルパー）に依存する。
 *
 *   公開 API（window）:
 *     loadContractAdminPage()                 ページ入口（contract.page / contract.view）
 *     openContractRequestModal(preset)        依頼URL発行モーダル（オンボーディング詳細からも呼ぶ）
 *     openContractDetail(memberContractId)    詳細モーダル
 *
 *   権限（ADR 015）: 判定はすべて hasPermission() 経由。contract.view のみのユーザーは参照専用
 *   （操作ボタン非表示・個人情報欄非表示）。サーバー側も実効ロールで列を絞る前提。
 * ============================================================ */
(function (window, document) {
  'use strict';

  function H() { return window.HFSContract; }
  const ROOT_ID = 'contract-admin-root';

  const S = {
    tab: 'list', rows: [], parties: [], documents: [], settings: null, events: [],
    filter: { status: '', party: '', doc: '', q: '', tile: '' },
    canManage: false, canView: false, loaded: false, notReady: false,
    detail: null,
    reqModal: { userIds: [], users: new Map(), preset: null },
  };

  // contract_events.action（routes/contracts.js の logEvent 呼び出し）→ 表示ラベル
  const ACTION_LABELS = {
    requested: '依頼を発行', sent: '依頼を送信', viewed: '初回閲覧', view_completed: '最終ページまで閲覧',
    draft_saved: '下書き保存', submitted: '同意・署名', approved: '承認（締結済み）',
    revision_requested: '修正依頼', reminded: '催促', cancelled: '依頼を取消', ended: '終了', ending_set: '終了予定を設定',
    bank_revealed: '口座番号を全桁表示', pdf_downloaded: 'PDF ダウンロード', external_registered: '既存契約を登録',
    version_published: '版を公開', version_created: '版を作成', document_created: '文書を作成', reconsent_requested: '再同意が必要に',
    renewed: '自動更新', expiry_notice: '期限のお知らせ', renew_notice: '更新拒絶期限のお知らせ', due_notice: '回答期限のお知らせ',
    settings_updated: '設定を変更', party_updated: '契約主体を更新',
  };
  const ADMIN_ACTIONS = new Set(['requested', 'sent', 'approved', 'revision_requested', 'reminded', 'cancelled', 'ended', 'ending_set', 'bank_revealed', 'external_registered', 'version_published', 'version_created', 'document_created', 'settings_updated', 'party_updated', 'reconsent_requested']);
  const BIZ_LABELS = { individual: '個人', sole_proprietor: '個人事業主', corporation: '法人' };
  const CHANNEL_LABELS = { chatwork_direct: 'Chatwork 個別チャット', chatwork_room: 'Chatwork ルーム（To 付き）', slack_dm: 'Slack DM', none: '未送信' };

  function root() { return document.getElementById(ROOT_ID); }
  function esc(v) { return H().esc(v); }
  function toast(m, t) { H().toast(m, t); }

  // ───────────────── 入口 ─────────────────
  async function loadContractAdminPage() {
    const el = root();
    if (!el) return;
    const h = H();
    if (!h) { el.innerHTML = '<div class="c-empty">contract-wizard.js が読み込まれていません</div>'; return; }
    S.canManage = h.permission('contract.page');
    S.canView = S.canManage || h.permission('contract.view');
    if (!S.canView) {
      el.innerHTML = '<div class="c-wrap"><div class="c-bar"><h2>📝 契約管理</h2></div><div class="c-notice bad">このページを表示する権限がありません。</div></div>';
      return;
    }
    if (!S.canManage && !['list', 'docs'].includes(S.tab)) S.tab = 'list';
    renderShell();
    // マスタ類は並行で取得（未適用なら静かにスキップ）
    await Promise.all([loadParties(), loadDocuments()]);
    await renderTab();
  }

  function renderShell() {
    const el = root();
    const tabs = [
      { key: 'list', label: '👥 メンバー一覧' },
      { key: 'docs', label: '📄 文書バージョン' },
      ...(S.canManage ? [
        { key: 'external', label: '📥 既存契約の登録' },
        { key: 'events', label: '🕘 操作履歴' },
        { key: 'settings', label: '⚙️ 設定' },
        { key: 'parties', label: '🏢 契約主体' },
      ] : []),
    ];
    el.innerHTML = `<div class="c-wrap-wide">
      <div class="c-bar">
        <h2>📝 契約管理</h2>
        ${S.canManage ? '' : '<span class="c-readonly-note" title="状態・契約相手・文書/版・日付のみ表示します">👁 参照のみ</span>'}
        <span class="sp"></span>
        ${S.canManage ? '<button class="btn-primary" onclick="openContractRequestModal()">＋ 依頼URLを発行</button>' : ''}
      </div>
      <div class="c-tabs">${tabs.map(t => `<button class="c-tab ${S.tab === t.key ? 'active' : ''}" onclick="HFSContractAdmin.tab('${t.key}')">${t.label}</button>`).join('')}</div>
      <div id="ca-body"><div class="c-loading">読み込み中…</div></div>
    </div>`;
  }

  async function setTab(key) {
    S.tab = key;
    renderShell();
    await renderTab();
  }

  async function renderTab() {
    const body = document.getElementById('ca-body');
    if (!body) return;
    switch (S.tab) {
      case 'list': return renderList();
      case 'docs': return renderDocs();
      case 'external': return renderExternal();
      case 'events': return renderEvents();
      case 'settings': return renderSettings();
      case 'parties': return renderParties();
    }
  }

  async function loadParties() {
    const r = await H().api('/parties');
    if (r.ok && Array.isArray(r.data)) S.parties = r.data;
    else if (r.ok && r.data && Array.isArray(r.data.parties)) S.parties = r.data.parties;
    if (r.notReady) S.notReady = true;
  }
  async function loadDocuments() {
    const r = await H().api('/documents');
    if (r.ok && Array.isArray(r.data)) S.documents = r.data;
    else if (r.ok && r.data && Array.isArray(r.data.documents)) S.documents = r.data.documents;
    if (r.notReady) S.notReady = true;
  }
  function partyByCode(code) { return S.parties.find(p => p.code === code) || null; }
  function partyLabelByCode(code) { return H().partyLabel(partyByCode(code) || code); }
  function partyOptions(sel) {
    const list = S.parties.length ? S.parties : Object.keys(H().PARTY_LABELS).map(code => ({ code }));
    return list.map(p => `<option value="${esc(p.code)}" ${sel === p.code ? 'selected' : ''}>${esc(H().partyLabel(p))}</option>`).join('');
  }
  function versionsOf(doc) { return Array.isArray(doc.versions) ? doc.versions : []; }
  function latestPublished(doc) {
    return versionsOf(doc).filter(v => v.status === 'published').sort((a, b) => (b.version_no || 0) - (a.version_no || 0))[0] || null;
  }
  function docOptions(sel, onlyPublished) {
    return S.documents
      .filter(d => !onlyPublished || latestPublished(d))
      .map(d => `<option value="${esc(d.id)}" ${String(sel) === String(d.id) ? 'selected' : ''}>${esc(H().docTitle(d))}${d.party_code ? `（${esc(partyLabelByCode(d.party_code))}）` : ''}</option>`).join('');
  }

  // ───────────────── メンバー一覧 ─────────────────
  // GET /requests の1行（routes/contracts.js: メンバー単位に集約）を表示用に正規化。
  // row = { user{id,full_name,nickname,is_active,email?,has_chatwork?,has_slack?}, summary_status, latest_request(requestToJson),
  //         contracts[](contractToJson), effective_count, pending_count, reconsent_required, next_end_date, days_to_end, overdue, unattended }
  function normRow(r) {
    const h = H();
    const user = r.user || { id: r.user_id };
    const req = r.latest_request || null;
    const all = Array.isArray(r.contracts) ? r.contracts : [];
    const effective = all.filter(c => ['active', 'ending', 'reconsent_required'].includes(c.status));
    const pendingish = all.filter(c => ['requested', 'revision_requested', 'submitted'].includes(c.status));
    // 一覧に出す文書: 進行中の依頼があればその文書、無ければ有効契約、それも無ければ最新の契約
    const docs = pendingish.length ? pendingish : (effective.length ? effective : all.slice(0, 1));
    const primary = all.find(c => c.status === 'submitted') || pendingish[0] || effective[0] || all[0] || null;
    const status = r.summary_status || (primary ? primary.status : 'none');
    const endDate = r.next_end_date || (effective[0] && effective[0].end_date) || null;
    const daysLeft = r.days_to_end != null ? r.days_to_end : (endDate ? h.daysDiff(h.todayJst(), h.fmtD(endDate)) : null);
    const viewedAll = docs.length && docs.every(c => c.viewed_completed_at);
    return {
      raw: r, user, user_id: user.id, req, ct: primary, docs, status,
      partyCode: (primary && primary.party_code) || (req && req.party_code) || null,
      request_id: req ? req.id : null,
      member_contract_id: primary ? primary.id : null,
      first_viewed_at: (req && req.first_viewed_at) || (primary && primary.first_viewed_at) || null,
      viewed_completed_at: viewedAll ? docs.map(c => c.viewed_completed_at).sort().slice(-1)[0] : null,
      consented_at: (primary && (primary.submitted_at || primary.signed_at)) || (req && req.submitted_at) || null,
      sent_at: req ? (req.sent_at || req.requested_at) : null,
      due_date: req ? req.due_date : null,
      start_date: (effective[0] && effective[0].start_date) || (primary && primary.start_date) || null,
      end_date: endDate,
      auto_renew: effective[0] ? effective[0].auto_renew : (primary ? primary.auto_renew : null),
      execution_method: primary ? primary.execution_method : null,
      reconsent: !!r.reconsent_required,
      has_draft: !!(req && req.has_draft),
      overdue: !!r.overdue, unattended: !!r.unattended,
      daysLeft,
    };
  }

  // 一覧の状態チップ（画面モック①⑥の凡例に対応）
  function adminStatus(row) {
    const h = H();
    if (row.reconsent && !['submitted', 'requested', 'revision_requested'].includes(row.status)) return { cls: 'c-info', label: '再同意が必要', key: 'reconsent', order: 1 };
    switch (row.status) {
      case 'requested': {
        if (row.overdue) return { cls: 'c-bad', label: `回答期限切れ ${h.fmtD(row.due_date)}`, key: 'pending', order: 1 };
        if (row.has_draft) return { cls: 'c-info', label: '入力中', key: 'pending', order: 3 };
        if (row.first_viewed_at) return { cls: 'c-info', label: '閲覧済み・同意待ち', key: 'pending', order: 3 };
        const d = h.daysSince(row.sent_at);
        return { cls: 'c-warn', label: `依頼済み・未閲覧${d != null && d > 0 ? ` ${d}日` : ''}`, key: 'pending', order: 2 };
      }
      case 'submitted': return { cls: 'c-pend', label: '確認待ち', key: 'submitted', order: 2 };
      case 'revision_requested': return { cls: 'c-warn', label: '修正依頼中', key: 'pending', order: 3 };
      case 'active':
      case 'ending': {
        if (row.daysLeft != null && row.daysLeft < 0) return { cls: 'c-bad', label: `期限切れ ${h.fmtD(row.end_date)}`, key: 'expiry', order: 0 };
        if (row.daysLeft != null && row.daysLeft <= 30) return { cls: 'c-warn', label: `期限まで${row.daysLeft}日`, key: 'expiry', order: 1 };
        return row.status === 'ending' ? { cls: 'c-warn', label: '終了予定', key: 'active', order: 5 } : { cls: 'c-ok', label: '締結済み', key: 'active', order: 6 };
      }
      case 'ended': return { cls: 'c-gray', label: '終了', key: 'ended', order: 8 };
      case 'cancelled': return { cls: 'c-gray', label: '取消', key: 'ended', order: 8 };
      case 'reconsent_required': return { cls: 'c-info', label: '再同意が必要', key: 'reconsent', order: 1 };
      default: return { cls: 'c-gray', label: '未着手', key: 'none', order: 7 };
    }
  }

  // サーバーが解釈する status= の値（それ以外はフロントで絞る）
  const SERVER_STATUS = new Set(['requested', 'submitted', 'revision_requested', 'active', 'ending', 'ended', 'cancelled', 'reconsent_required', 'overdue', 'unattended', 'expiring']);
  async function fetchRows() {
    const q = new URLSearchParams();
    if (S.filter.status && SERVER_STATUS.has(S.filter.status)) q.set('status', S.filter.status);
    if (S.filter.party) q.set('party', S.filter.party);
    if (S.filter.doc) q.set('doc', S.filter.doc);
    if (S.filter.q) q.set('q', S.filter.q);
    if (S.filter.includeAll) q.set('include_all', '1');
    const r = await H().api('/requests' + (q.toString() ? `?${q}` : ''));
    if (!r.ok) return r;
    const d = r.data || {};
    const arr = Array.isArray(d) ? d : (Array.isArray(d.rows) ? d.rows : []);
    S.rows = arr.map(normRow);
    if (!S.parties.length && Array.isArray(d.parties)) S.parties = d.parties;
    if (!S.documents.length && Array.isArray(d.documents)) S.documents = d.documents;
    S.loaded = true;
    return r;
  }

  async function renderList() {
    const body = document.getElementById('ca-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    const r = await fetchRows();
    if (!r.ok) {
      body.innerHTML = `<div class="c-notice ${r.notReady ? '' : 'bad'}">${esc(r.error)}</div>`;
      return;
    }
    drawList();
  }

  function drawList() {
    const h = H();
    const body = document.getElementById('ca-body');
    const rows = S.rows.map(row => Object.assign(row, { st: adminStatus(row) }));
    const cnt = {
      pending: rows.filter(x => x.st.key === 'pending').length,
      submitted: rows.filter(x => x.st.key === 'submitted').length,
      expiry: rows.filter(x => x.st.key === 'expiry').length,
      reconsent: rows.filter(x => x.st.key === 'reconsent').length,
    };
    const tile = S.filter.tile;
    let shown = rows.filter(x => !tile || x.st.key === tile);
    // 一覧での絞り込み（サーバーが未対応でもフロントで効かせる）
    if (S.filter.status && !SERVER_STATUS.has(S.filter.status)) shown = shown.filter(x => x.status === S.filter.status || x.st.key === S.filter.status);
    shown.sort((a, b) => a.st.order - b.st.order || h.nameOf(a.user).localeCompare(h.nameOf(b.user), 'ja'));

    const tiles = `<div class="ca-tiles">
      <div class="ca-tile warn ${tile === 'pending' ? 'on' : ''}" onclick="HFSContractAdmin.tile('pending')"><div class="k">未対応（依頼済み・未同意）</div><div class="v">${cnt.pending}</div></div>
      <div class="ca-tile pend ${tile === 'submitted' ? 'on' : ''}" onclick="HFSContractAdmin.tile('submitted')"><div class="k">確認待ち（同意済み・未承認）</div><div class="v">${cnt.submitted}</div></div>
      <div class="ca-tile bad ${tile === 'expiry' ? 'on' : ''}" onclick="HFSContractAdmin.tile('expiry')"><div class="k">期限切れ／30日以内に切れる</div><div class="v">${cnt.expiry}</div></div>
      <div class="ca-tile info ${tile === 'reconsent' ? 'on' : ''}" onclick="HFSContractAdmin.tile('reconsent')"><div class="k">再同意が必要（文書改訂）</div><div class="v">${cnt.reconsent}</div></div>
    </div>`;
    const filters = `<div class="ca-filters">
      <select id="ca-f-status" onchange="HFSContractAdmin.filter()">
        <option value="">状態: すべて</option>
        <option value="requested" ${S.filter.status === 'requested' ? 'selected' : ''}>未対応（依頼中）</option>
        <option value="unattended" ${S.filter.status === 'unattended' ? 'selected' : ''}>未対応・3日以上未閲覧</option>
        <option value="overdue" ${S.filter.status === 'overdue' ? 'selected' : ''}>回答期限切れ</option>
        <option value="submitted" ${S.filter.status === 'submitted' ? 'selected' : ''}>確認待ち</option>
        <option value="revision_requested" ${S.filter.status === 'revision_requested' ? 'selected' : ''}>修正依頼中</option>
        <option value="active" ${S.filter.status === 'active' ? 'selected' : ''}>締結済み</option>
        <option value="expiring" ${S.filter.status === 'expiring' ? 'selected' : ''}>30日以内に切れる</option>
        <option value="expiry" ${S.filter.status === 'expiry' ? 'selected' : ''}>期限切れ／間近（画面判定）</option>
        <option value="reconsent_required" ${S.filter.status === 'reconsent_required' ? 'selected' : ''}>再同意が必要</option>
        <option value="ending" ${S.filter.status === 'ending' ? 'selected' : ''}>終了予定</option>
        <option value="ended" ${S.filter.status === 'ended' ? 'selected' : ''}>終了</option>
        <option value="none" ${S.filter.status === 'none' ? 'selected' : ''}>未着手</option>
      </select>
      <select id="ca-f-party" onchange="HFSContractAdmin.filter()"><option value="">契約相手: すべて</option>${partyOptions(S.filter.party)}</select>
      <select id="ca-f-doc" onchange="HFSContractAdmin.filter()"><option value="">文書: すべて</option>${docOptions(S.filter.doc, false)}</select>
      <input id="ca-f-q" placeholder="氏名で検索" value="${esc(S.filter.q)}" onkeydown="if(event.key==='Enter')HFSContractAdmin.filter()">
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted)"><input type="checkbox" id="ca-f-all" ${S.filter.includeAll ? 'checked' : ''} onchange="HFSContractAdmin.filter()"> 契約なしのメンバーも表示</label>
      <button class="btn-sm" onclick="HFSContractAdmin.filter()">絞り込む</button>
      <button class="btn-sm" onclick="HFSContractAdmin.reload()">🔄 更新</button>
      <span class="c-mini" style="margin-left:auto">${shown.length} / ${rows.length} 件</span>
    </div>`;

    const tr = shown.map(row => {
      const docsTxt = (row.docs.map(d => `${h.docTitle(d)} ${h.verLabel(d.version || d)}`.trim()).join(' ／ ') || '—') + (row.execution_method && row.execution_method !== 'hfs' ? `（${h.EXEC_LABELS[row.execution_method] || row.execution_method}）` : '');
      const viewed = row.viewed_completed_at ? `✓ ${h.fmtMD(row.viewed_completed_at)}` : (row.first_viewed_at ? `👁 ${h.fmtMD(row.first_viewed_at)}` : (row.status === 'requested' && row.sent_at ? `— ${h.daysSince(row.sent_at) || 0}日経過` : '—'));
      const period = row.start_date ? `${h.fmtD(row.start_date)} 〜 ${row.end_date ? h.fmtD(row.end_date) : (row.auto_renew ? '自動更新' : '—')}` : (row.due_date ? `回答期限 ${h.fmtD(row.due_date)}` : '—');
      const partyChip = row.partyCode ? h.chip(row.partyCode === 'haruka_film_inc' ? 'c-em' : 'c-gray', (row.ct && row.ct.party_name) || partyLabelByCode(row.partyCode)) : '—';
      const acts = [];
      if (S.canManage) {
        if (row.status === 'submitted' && row.member_contract_id) acts.push(`<button class="btn-sm" onclick="event.stopPropagation();openContractDetail('${esc(row.member_contract_id)}')">確認</button>`);
        if (['requested', 'revision_requested'].includes(row.status) && row.request_id) acts.push(`<button class="btn-sm" onclick="event.stopPropagation();HFSContractAdmin.remind('${esc(row.request_id)}')">催促</button>`);
        if (row.st.key === 'reconsent') acts.push(`<button class="btn-sm" onclick="event.stopPropagation();openContractRequestModal({user_ids:['${esc(row.user_id)}'],party_code:'${esc(row.partyCode || '')}',reconsent:true})">再同意を依頼</button>`);
        if ((row.st.key === 'expiry' || row.partyCode === 'individual_takahashi') && row.status !== 'requested' && row.status !== 'submitted') acts.push(`<button class="btn-sm" onclick="event.stopPropagation();openContractRequestModal({user_ids:['${esc(row.user_id)}'],party_code:'haruka_film_inc'})">法人契約を依頼</button>`);
        if (row.status === 'none') acts.push(`<button class="btn-sm" onclick="event.stopPropagation();openContractRequestModal({user_ids:['${esc(row.user_id)}']})">依頼を発行</button>`);
      }
      if (row.member_contract_id && !(row.status === 'submitted' && S.canManage)) acts.push(`<button class="btn-sm" onclick="event.stopPropagation();openContractDetail('${esc(row.member_contract_id)}')">詳細</button>`);
      const clickable = row.member_contract_id ? 'clickable' : '';
      return `<tr class="${row.st.key === 'expiry' ? 'hl' : ''} ${clickable}" ${row.member_contract_id ? `onclick="openContractDetail('${esc(row.member_contract_id)}')"` : ''}>
        <td class="name">${h.nameHtml(row.user)}${row.user && row.user.is_active === false ? ' ' + h.chip('c-gray', '無効') : ''}${S.canManage && row.user && row.user.has_chatwork === false && row.user.has_slack === false ? ' <span class="c-mini" title="Chatwork DM / Slack DM のどちらも未登録">📵 DM先なし</span>' : ''}</td>
        <td>${partyChip}</td>
        <td class="wrap">${esc(docsTxt)}</td>
        <td>${h.chip(row.st.cls, row.st.label)}</td>
        <td>${esc(viewed)}</td>
        <td class="num">${esc(row.consented_at ? h.fmtMD(row.consented_at) : '—')}</td>
        <td class="num">${esc(period)}</td>
        <td><div class="acts">${acts.join('')}</div></td>
      </tr>`;
    }).join('');

    body.innerHTML = `${tiles}${filters}
      <div class="ca-tblwrap"><table class="ca-tbl">
        <thead><tr><th>メンバー</th><th>契約相手</th><th>文書 / 版</th><th>状態</th><th>閲覧</th><th class="num">同意日時</th><th class="num">契約期間</th><th></th></tr></thead>
        <tbody>${tr || `<tr><td colspan="8" class="c-empty">${rows.length ? '条件に合うメンバーがいません' : 'まだ契約依頼がありません。「＋ 依頼URLを発行」から始めてください。'}</td></tr>`}</tbody>
      </table></div>
      <div class="c-mini" style="margin-top:8px">「期限切れ」「再同意が必要」は一覧の先頭に固定表示されます。${S.canManage ? '' : '参照専用のため、住所・口座・同意記録の本文は表示されません。'}</div>`;
  }

  function applyFilter() {
    S.filter.status = document.getElementById('ca-f-status')?.value || '';
    S.filter.party = document.getElementById('ca-f-party')?.value || '';
    S.filter.doc = document.getElementById('ca-f-doc')?.value || '';
    S.filter.q = (document.getElementById('ca-f-q')?.value || '').trim();
    S.filter.includeAll = !!document.getElementById('ca-f-all')?.checked;
    renderList();
  }
  function setTile(key) {
    S.filter.tile = S.filter.tile === key ? '' : key;
    drawList();
  }

  async function remind(requestId) {
    const ok = await confirmDlg({ title: '催促を送信', message: '本人へ催促メッセージ（Chatwork／Slack DM）を送信します。よろしいですか？', okLabel: '送信する' });
    if (!ok) return;
    const r = await H().api(`/requests/${encodeURIComponent(requestId)}/remind`, { method: 'POST', json: {} });
    if (!r.ok) { toast(r.error, 'error'); return; }
    if (r.data && r.data.sent) toast(`催促を送信しました（${CHANNEL_LABELS[r.data.channel] || r.data.channel}）`, 'success');
    else toast(`催促を送信できませんでした：${(r.data && r.data.reason) || 'DM 先が未登録の可能性があります'}`, 'warn');
    renderList();
  }
  async function cancelRequest(requestId) {
    const ok = await confirmDlg({ title: '依頼を取り消す', message: 'この依頼を取り消します（本人の依頼URLは無効になります）。よろしいですか？', okLabel: '取り消す', okVariant: 'danger' });
    if (!ok) return;
    const r = await H().api(`/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', json: {} });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('依頼を取り消しました', 'success');
    closeDetail();
    renderList();
  }

  function confirmDlg(opts) {
    if (typeof window.showConfirmDialog === 'function') return window.showConfirmDialog(opts);
    return Promise.resolve(window.confirm(opts.message));
  }

  // ───────────────── モーダル土台（動的生成） ─────────────────
  function ensureModal(id, title, wide) {
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = id;
    el.style.zIndex = '320';
    el.innerHTML = `<div class="modal-card ${wide ? 'ca-modal-wide' : ''}" style="max-height:90vh;overflow-y:auto">
      <div class="modal-title"><span id="${id}-title">${esc(title)}</span><button class="modal-close" onclick="closeModal('${id}')">×</button></div>
      <div id="${id}-body"></div>
    </div>`;
    document.body.appendChild(el);
    return el;
  }
  function openModalId(id) { if (typeof window.openModal === 'function') window.openModal(id); else document.getElementById(id)?.classList.add('open'); }
  function closeModalId(id) { if (typeof window.closeModal === 'function') window.closeModal(id); else document.getElementById(id)?.classList.remove('open'); }

  // ───────────────── 依頼URL発行モーダル ─────────────────
  // preset: { user_ids:[], party_code, version_ids:[], onboarding_record_id, reconsent }
  async function openContractRequestModal(preset) {
    const h = H();
    if (!h.permission('contract.page')) { toast('依頼を発行する権限がありません', 'warn'); return; }
    const p = preset || {};
    S.reqModal = { userIds: (p.user_ids || []).map(String), users: new Map(), preset: p, result: null };
    ensureModal('modal-contract-request', '📝 依頼URLを発行', true);
    openModalId('modal-contract-request');
    const body = document.getElementById('modal-contract-request-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    if (!S.parties.length || !S.documents.length) await Promise.all([loadParties(), loadDocuments()]);
    // メンバー名解決（MemberPicker のキャッシュを利用）
    try {
      const members = window.MemberPicker ? await window.MemberPicker.loadMembers() : [];
      members.forEach(m => S.reqModal.users.set(String(m.id), m));
    } catch (_) {}
    drawRequestModal();
  }

  function drawRequestModal() {
    const h = H();
    const body = document.getElementById('modal-contract-request-body');
    const m = S.reqModal;
    const p = m.preset || {};
    const partyCode = m.partyCode || p.party_code || 'haruka_film_inc';
    m.partyCode = partyCode;
    const party = partyByCode(partyCode);
    const docs = S.documents.filter(d => latestPublished(d) && (!d.party_code || d.party_code === partyCode));
    if (!m.versionIds) {
      m.versionIds = new Set(p.version_ids ? p.version_ids.map(String) : docs.filter(d => ['basic_agreement', 'rules_confirmation'].includes(d.doc_type)).map(d => String(latestPublished(d).id)));
    }
    if (!m.due) m.due = h.addDaysJst(14);
    if (!m.start) m.start = h.todayJst();
    if (m.autoRenew == null) m.autoRenew = true;
    if (m.renewDays == null) m.renewDays = 30;

    const pills = m.userIds.map(id => {
      const u = m.users.get(String(id)) || { id, full_name: `ID:${id}` };
      return `<span class="ca-pill">${h.nameHtml(u)}<button title="外す" onclick="HFSContractAdmin.reqRemoveUser('${esc(id)}')">✕</button></span>`;
    }).join('');
    const docChecks = docs.map(d => {
      const v = latestPublished(d);
      const on = m.versionIds.has(String(v.id));
      return `<label><input type="checkbox" ${on ? 'checked' : ''} onchange="HFSContractAdmin.reqToggleVersion('${esc(v.id)}', this.checked)"> ${esc(h.docTitle(d))} ${h.chip('c-em', `${h.verLabel(v)}${v.effective_from ? `・${h.fmtD(v.effective_from)}〜` : ''}`)} ${v.requires_reconsent ? '<span class="c-mini">再同意対象</span>' : ''}</label>`;
    }).join('');

    if (m.result) {
      const rows = m.result.map(x => {
        const u = m.users.get(String(x.user_id)) || { id: x.user_id, full_name: `ID:${x.user_id}` };
        return `<div class="cw-list-item"><div class="t"><b>${h.nameHtml(u)}</b>${x.resent ? ' ' + h.chip('c-info', '既存の依頼を再送') : ''}<div class="ca-urlbox"><div class="u">${esc(x.url || '（URL なし）')}</div></div></div>
          ${x.sent ? h.chip('c-ok', `送信済み（${CHANNEL_LABELS[x.channel] || x.channel || 'DM'}）`) : h.chip(x.reason && x.reason !== '送信しない指定' ? 'c-bad' : 'c-gray', x.reason ? `未送信：${x.reason}` : '未送信')}
          ${x.url ? `<button class="btn-sm" onclick="HFSContractAdmin.copyText('${esc(x.url)}')">URLをコピー</button>` : ''}</div>`;
      }).join('');
      body.innerHTML = `<div class="c-notice" style="margin-bottom:10px">依頼を発行しました。URL はメンバーごとに別トークンで、ログイン必須・90日で失効します。すでに同じ文書を依頼中のメンバーには既存の URL を再送しています。</div>
        ${rows || '<div class="c-empty">結果がありません</div>'}
        <div class="c-actions"><button class="btn-sm" onclick="HFSContractAdmin.copyText(${esc(JSON.stringify(m.result.map(x => `${h.nameOf(m.users.get(String(x.user_id)) || {})}: ${x.url || ''}`).join('\n')))})">すべてコピー</button><button class="btn-primary" onclick="closeModal('modal-contract-request');HFSContractAdmin.reload()">閉じる</button></div>`;
      return;
    }

    body.innerHTML = `
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">対象メンバー（複数可）</label>
        <div id="ca-req-pills">${pills || '<span class="c-mini">まだ選択されていません</span>'} <button class="btn-sm" id="ca-req-add" onclick="HFSContractAdmin.reqPickUsers(this)">＋ 追加</button></div>
        ${p.reconsent ? '<div class="c-mini" style="margin-top:4px">再同意の依頼です。改訂後の版を選んで発行してください（同意までは現在の版が有効のままです）。</div>' : ''}
      </div>
      <div class="c-row2">
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">契約相手</label>
          <select class="form-select" id="ca-req-party" onchange="HFSContractAdmin.reqPartyChange(this.value)">${partyOptions(partyCode)}</select>
          ${party && h.partyRep(party) ? `<div class="c-mini" style="margin-top:3px">${esc(h.partyRep(party))}</div>` : ''}
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">回答期限</label>
          <input class="form-input" type="date" id="ca-req-due" value="${esc(m.due)}" onchange="HFSContractAdmin.reqField('due', this.value);HFSContractAdmin.reqRegenMessage()">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">依頼する文書（公開済みの最新版だけ選べます）</label>
        <div class="c-checks">${docChecks || '<span class="c-mini">この契約相手で公開済みの文書がありません。「文書バージョン」タブで PDF を登録・公開してください。</span>'}</div>
      </div>
      <div class="c-row3">
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">契約開始日</label>
          <input class="form-input" type="date" id="ca-req-start" value="${esc(m.start)}" onchange="HFSContractAdmin.reqField('start', this.value)">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">期間・更新</label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px"><input type="checkbox" ${m.autoRenew ? 'checked' : ''} onchange="HFSContractAdmin.reqField('autoRenew', this.checked)"> 1年・自動更新</label>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">更新拒絶の期限（終了日の何日前）</label>
          <input class="form-input" type="number" min="0" value="${esc(m.renewDays)}" onchange="HFSContractAdmin.reqField('renewDays', this.value)">
        </div>
      </div>
      ${p.onboarding_record_id ? `<div class="c-notice" style="margin-bottom:12px">🚀 オンボーディングと連携します（承認時に「HARUKA FILM契約書の提出」が自動でチェックされます）。</div>` : ''}
      <div class="ca-urlbox" style="margin-bottom:12px"><div class="c-mini" style="margin-bottom:4px">発行されるURL（メンバーごとに別トークン・ログイン必須・90日で失効）</div><div class="u">${esc(location.origin)}/haruka.html?contract_req=&lt;token&gt;</div></div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">送信メッセージのプレビュー（Chatwork個別チャット → 無ければ Slack DM）</label>
        <div class="ca-msgprev" style="min-height:auto;background:var(--surface)" id="ca-req-preview">${esc(buildRequestMessage())}</div>
        <div class="c-mini" style="margin-top:3px">文面はシステムが生成します（宛名・URL・期限はメンバーごとに差し込み）。下の追記文は文末に添えられます。</div>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">追記メッセージ（任意）</label>
        <textarea class="ca-msgprev" id="ca-req-msg" style="min-height:64px" placeholder="例) ご不明点は Chatwork でお気軽にどうぞ。" oninput="HFSContractAdmin.reqRegenMessage()">${esc(m.message || '')}</textarea>
      </div>
      <div class="c-actions">
        <button class="btn-sm" onclick="HFSContractAdmin.reqSubmit(false)">URLだけコピー（送信しない）</button>
        <button class="btn-primary" id="ca-req-send" onclick="HFSContractAdmin.reqSubmit(true)">発行して送信</button>
      </div>`;
  }

  // utils/contract-messages.js buildRequestMessage() と同じ組み立てのプレビュー（送信文そのものはサーバーが生成）
  function buildRequestMessage() {
    const h = H();
    const m = S.reqModal;
    const party = partyByCode(m.partyCode);
    const titles = S.documents.filter(d => { const v = latestPublished(d); return v && m.versionIds.has(String(v.id)); }).map(d => `『${h.docTitle(d)}』`);
    const joined = titles.length <= 1 ? (titles[0] || '『（文書未選択）』') : (titles.length === 2 ? `${titles[0]}と${titles[1]}` : titles.join(''));
    const fmtJa = (ymd) => { const x = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return x ? `${+x[1]}年${+x[2]}月${+x[3]}日` : '未設定'; };
    const first = m.userIds[0] ? h.nameOf(m.users.get(String(m.userIds[0])) || {}) : '';
    const lines = [
      `${first ? `${first}さん` : 'お疲れさまです'}、お疲れさまです。`,
      `${h.partyLabel(party || m.partyCode)}としての${joined}のご確認・ご同意をお願いします。`,
      '下記URLからHARUKA FILM SYSTEMにログインして進めてください（所要 約10分）。',
      `${location.origin}/haruka.html?contract_req=<token>`,
    ];
    if (m.due) lines.push(`回答期限：${fmtJa(m.due)}`);
    const extra = (document.getElementById('ca-req-msg')?.value || m.message || '').trim();
    if (extra) lines.push('', extra);
    return `【契約書のご確認・ご同意のお願い】\n${lines.join('\n')}`;
  }

  function reqPickUsers(btn) {
    const m = S.reqModal;
    if (!window.MemberPicker) { toast('MemberPicker が読み込まれていません', 'error'); return; }
    window.MemberPicker.open(btn, {
      mode: 'multi', value: m.userIds.slice(), title: '契約依頼の対象メンバー', showInactive: false,
      onChange: async (ids) => {
        m.userIds = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
        try { const members = await window.MemberPicker.loadMembers(); members.forEach(x => m.users.set(String(x.id), x)); } catch (_) {}
        m.message = document.getElementById('ca-req-msg')?.value;
        drawRequestModal();
      },
    });
  }
  function reqRemoveUser(id) {
    S.reqModal.userIds = S.reqModal.userIds.filter(x => x !== String(id));
    S.reqModal.message = document.getElementById('ca-req-msg')?.value;
    drawRequestModal();
  }
  function reqToggleVersion(id, on) {
    const m = S.reqModal;
    if (on) m.versionIds.add(String(id)); else m.versionIds.delete(String(id));
    m.message = document.getElementById('ca-req-msg')?.value || m.message;
    drawRequestModal();
  }
  function reqPartyChange(code) {
    const m = S.reqModal;
    m.partyCode = code;
    m.versionIds = null;
    m.message = document.getElementById('ca-req-msg')?.value || m.message;
    drawRequestModal();
  }
  function reqField(k, v) {
    const m = S.reqModal;
    if (k === 'autoRenew') m.autoRenew = !!v;
    else if (k === 'renewDays') m.renewDays = Number(v) || 0;
    else m[k] = v;
  }
  function reqRegenMessage() {
    const pv = document.getElementById('ca-req-preview');
    if (pv) pv.textContent = buildRequestMessage();
  }

  async function reqSubmit(send) {
    const h = H();
    const m = S.reqModal;
    if (!m.userIds.length) { toast('対象メンバーを選択してください', 'warn'); return; }
    if (!m.versionIds.size) { toast('依頼する文書を選択してください', 'warn'); return; }
    if (!m.due) { toast('回答期限を入力してください', 'warn'); return; }
    const message = (document.getElementById('ca-req-msg')?.value || '').trim() || null;
    const btn = document.getElementById('ca-req-send');
    if (btn) { btn.disabled = true; btn.textContent = '発行中…'; }
    const body = {
      user_ids: m.userIds, party_code: m.partyCode, version_ids: Array.from(m.versionIds),
      due_date: m.due, start_date: m.start || null, auto_renew: !!m.autoRenew, renew_notice_days: m.renewDays,
      message, send: !!send,
    };
    if (m.preset && m.preset.onboarding_record_id) body.onboarding_record_id = m.preset.onboarding_record_id;
    const r = await h.api('/requests', { method: 'POST', json: body });
    if (!r.ok) { toast(r.error, 'error'); if (btn) { btn.disabled = false; btn.textContent = '発行して送信'; } return; }
    const list = Array.isArray(r.data) ? r.data : (r.data && (r.data.results || r.data.requests)) || [];
    m.result = list;
    if (!send) {
      const text = list.filter(x => x.url).map(x => `${h.nameOf(m.users.get(String(x.user_id)) || {})}: ${x.url}`).join('\n');
      copyText(text);
    } else {
      const ok = list.filter(x => x.sent).length;
      toast(`${ok} / ${list.length} 件に送信しました${ok < list.length ? '（未送信は結果一覧の理由をご確認ください）' : ''}`, ok < list.length ? 'warn' : 'success');
    }
    drawRequestModal();
  }

  function copyText(text) {
    if (!text) return;
    const done = () => toast('コピーしました', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (_) { toast('コピーに失敗しました', 'error'); }
    document.body.removeChild(ta);
  }

  // ───────────────── 詳細モーダル ─────────────────
  async function openContractDetail(memberContractId) {
    const h = H();
    ensureModal('modal-contract-detail', '📝 契約の詳細', true);
    openModalId('modal-contract-detail');
    const body = document.getElementById('modal-contract-detail-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    const r = await h.api(`/member-contracts/${encodeURIComponent(memberContractId)}`);
    if (!r.ok) { body.innerHTML = `<div class="c-notice bad">${esc(r.error)}</div>`; return; }
    // 形: { contract(contractToJson full=manage), request(requestToJson manage), profile(admin: マスク済み / view: PII なし),
    //       consents[], chain_ok, events[], related_contracts[], can_bank_reveal }
    const d = r.data || {};
    const contract = d.contract || {};
    const profile = d.profile || null;
    S.detail = {
      id: memberContractId, contract, consents: Array.isArray(d.consents) ? d.consents : [], events: Array.isArray(d.events) ? d.events : [],
      profile, request: d.request || null,
      user: profile ? { id: profile.id, full_name: profile.full_name, nickname: profile.nickname } : null,
      party: contract.party_name ? { code: contract.party_code, display_name: contract.party_name } : contract.party_code,
      version: contract.version || null, document: contract.document || null,
      related: Array.isArray(d.related_contracts) ? d.related_contracts : [], chainOk: d.chain_ok, canBankReveal: !!d.can_bank_reveal,
    };
    drawDetail();
  }
  function closeDetail() { closeModalId('modal-contract-detail'); }

  // contract_events 行: { action, actor_user_id, actor_name, actor_role, user_id, from_status, to_status, detail{...}, ip_address?, user_agent?, created_at }
  function eventLine(e) {
    const h = H();
    const action = e.action || '';
    const label = ACTION_LABELS[action] || action;
    const isSystem = !e.actor_user_id || e.actor_role === 'system';
    const isSelf = e.actor_user_id && e.user_id && String(e.actor_user_id) === String(e.user_id);
    const whoTxt = isSystem ? 'システム' : `${e.actor_name || `ID:${e.actor_user_id}`}${isSelf ? '（本人）' : (e.actor_role ? `（${e.actor_role}）` : '')}`;
    const meta = e.detail || {};
    const bits = [];
    if (meta.reason && meta.reason !== 'cancelled') bits.push(`理由：${meta.reason === 'superseded' ? '後継契約の承認により終了' : meta.reason}`);
    if (meta.channel) bits.push(`${CHANNEL_LABELS[meta.channel] || meta.channel}${meta.ok === false ? '（送信失敗）' : ''}${meta.resent ? '・再送' : ''}`);
    if (meta.due_date) bits.push(`期限 ${h.fmtD(meta.due_date)}`);
    if (meta.contract_date) bits.push(`締結日 ${h.fmtD(meta.contract_date)}`);
    if (meta.start_date) bits.push(`開始 ${h.fmtD(meta.start_date)}`);
    if (meta.end_date) bits.push(`終了日 ${h.fmtD(meta.end_date)}`);
    if (meta.version_no != null) bits.push(`v${meta.version_no}`);
    if (meta.step != null) bits.push(`ステップ ${Number(meta.step) + 1}`);
    if (Array.isArray(meta.profile_updated) && meta.profile_updated.length) bits.push(`本人情報を更新（${meta.profile_updated.join(', ')}）`);
    if (meta.record_hash) bits.push(`記録 ${String(meta.record_hash).slice(0, 12)}…`);
    if (meta.consent_kind) bits.push(meta.consent_kind === 'acknowledged' ? '確認' : '同意');
    if (meta.reconsent_required_count) bits.push(`再同意対象 ${meta.reconsent_required_count}件`);
    if (Array.isArray(meta.keys) && meta.keys.length) bits.push(meta.keys.join(', '));
    if (e.ip_address) bits.push(`IP ${e.ip_address}`);
    const dot = ['bank_revealed', 'cancelled', 'ended'].includes(action) ? 'bad' : (['revision_requested', 'reminded', 'reconsent_requested', 'ending_set'].includes(action) ? 'warn' : (ADMIN_ACTIONS.has(action) && !isSelf ? 'admin' : ''));
    return `<li><time>${esc(h.fmtDT(e.created_at))}</time><span class="dot ${dot}"></span><span><b>${esc(label)}</b>　${esc(whoTxt)}${bits.length ? ` ／ ${esc(bits.join(' ／ '))}` : ''}${e.user_agent ? `<div class="c-mini">${esc(String(e.user_agent).slice(0, 80))}</div>` : ''}</span></li>`;
  }

  function drawDetail() {
    const h = H();
    const D = S.detail;
    const c = D.contract || {};
    const user = D.user;
    const party = D.party;
    const ver = c.version || {};
    const doc = c.document || {};
    const st = adminStatus(normRow({ user: user || {}, summary_status: c.status, latest_request: D.request, contracts: [c], reconsent_required: c.status === 'reconsent_required', next_end_date: c.end_date, days_to_end: c.end_date ? h.daysDiff(h.todayJst(), h.fmtD(c.end_date)) : null }));
    const canManage = S.canManage;
    document.getElementById('modal-contract-detail-title').innerHTML = `${user ? h.nameHtml(user) : '契約'} の契約　${h.chip(st.cls, st.label)}`;

    // ヘッダー操作
    const acts = [];
    if (canManage) {
      if (c.status === 'submitted') {
        acts.push(`<button class="btn-danger" onclick="HFSContractAdmin.showForm('revision')">修正依頼（理由必須）</button>`);
        acts.push(`<button class="btn-primary" onclick="HFSContractAdmin.showForm('approve')">承認して締結済みにする</button>`);
      }
      if (['requested', 'revision_requested'].includes(c.status) && (D.request && D.request.id || c.request_id)) {
        acts.push(`<button class="btn-sm" onclick="HFSContractAdmin.remind('${esc((D.request && D.request.id) || c.request_id)}')">催促</button>`);
        acts.push(`<button class="btn-sm" style="color:#C0392B" onclick="HFSContractAdmin.cancelRequest('${esc((D.request && D.request.id) || c.request_id)}')">依頼を取消</button>`);
      }
      if (['active', 'ending', 'reconsent_required'].includes(c.status)) acts.push(`<button class="btn-sm" style="color:#C0392B" onclick="HFSContractAdmin.showForm('end')">終了</button>`);
    }
    const forms = `
      <div id="ca-d-form-approve" style="display:none" class="c-notice" >
        <b>承認して締結済みにします。</b>
        <div class="c-row2" style="margin-top:8px">
          <div><label class="form-label">締結日（既定：今日）</label><input class="form-input" type="date" id="ca-d-approve-date" value="${esc(h.todayJst())}"></div>
          <div><label class="form-label">契約開始日</label><input class="form-input" type="date" id="ca-d-approve-start" value="${esc(h.fmtD(c.start_date || (D.request && D.request.start_date)) === '—' ? '' : h.fmtD(c.start_date || (D.request && D.request.start_date)))}"></div>
        </div>
        <div class="c-actions"><button class="btn-sm" onclick="HFSContractAdmin.showForm(null)">キャンセル</button><button class="btn-primary" onclick="HFSContractAdmin.approve()">承認する</button></div>
      </div>
      <div id="ca-d-form-revision" style="display:none" class="c-notice warn">
        <b>修正依頼</b>（本人へ理由と再入力のお願いを送ります）
        <textarea class="form-input" id="ca-d-revision-reason" rows="3" style="margin-top:8px" placeholder="例) 口座名義がカナになっていません。カナで再入力をお願いします。"></textarea>
        <div class="c-actions"><button class="btn-sm" onclick="HFSContractAdmin.showForm(null)">キャンセル</button><button class="btn-danger" onclick="HFSContractAdmin.revision()">修正を依頼する</button></div>
      </div>
      <div id="ca-d-form-end" style="display:none" class="c-notice bad">
        <b>契約を終了します。</b> 未来の日付なら「終了予定」、今日以前なら即「終了」になります。
        <div class="c-row2" style="margin-top:8px">
          <div><label class="form-label">終了日</label><input class="form-input" type="date" id="ca-d-end-date" value="${esc(h.todayJst())}"></div>
          <div><label class="form-label">理由</label><input class="form-input" id="ca-d-end-reason" placeholder="例) 法人契約へ切替のため"></div>
        </div>
        <div class="c-actions"><button class="btn-sm" onclick="HFSContractAdmin.showForm(null)">キャンセル</button><button class="btn-danger" onclick="HFSContractAdmin.end()">終了する</button></div>
      </div>`;

    // タイムライン
    const tl = (D.events || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(eventLine).join('');
    const pendingLine = c.status === 'submitted' ? `<li><time>—</time><span class="dot warn"></span><span><b>管理者の確認待ち</b>　承認すると締結日＝承認日、契約開始日 ${esc(h.fmtD(c.start_date || (D.request && D.request.start_date)))}</span></li>` : '';

    // 同意記録
    const consents = (D.consents || []).filter(x => x.consent_kind !== 'viewed');
    const consentHtml = consents.length ? consents.map(x => {
      const okHash = ver.pdf_sha256 && x.pdf_sha256 ? ver.pdf_sha256 === x.pdf_sha256 : null;
      return `<dl class="c-kv" style="margin-bottom:10px">
        <dt>署名者名</dt><dd>${esc(x.signer_name_typed || '—')}${x.signer_name_registered ? `（登録氏名${x.signer_name_typed === x.signer_name_registered ? 'と一致' : `：${esc(x.signer_name_registered)}`}）` : ''}</dd>
        <dt>種別</dt><dd>${esc(x.consent_kind === 'acknowledged' ? '確認' : '同意')}</dd>
        <dt>同意日時</dt><dd>${esc(h.fmtDTS(x.consented_at))}</dd>
        ${canManage ? `<dt>IP／ブラウザ</dt><dd>${esc(x.ip_address || '—')} ／ <span class="c-mini">${esc(String(x.user_agent || '—').slice(0, 120))}</span></dd>` : ''}
        <dt>文書ハッシュ</dt><dd><div class="c-hash">${esc(x.pdf_sha256 || '—')}</div></dd>
        <dt>記録ハッシュ</dt><dd><div class="c-hash">${esc(x.record_hash || '—')}</div></dd>
        <dt>検証</dt><dd>${okHash === null ? '<span class="c-mini">（版の PDF ハッシュ未取得）</span>' : (okHash ? '<span class="c-verify">● 公開中の PDF と一致（改ざんなし）</span>' : '<span class="c-verify ng">● 公開中の PDF と不一致</span>')}${D.chainOk === false ? ' <span class="c-verify ng">● 記録の連鎖検証 NG</span>' : (D.chainOk === true ? ' <span class="c-verify">● 記録の連鎖 OK</span>' : '')}</dd>
      </dl>`;
    }).join('') : `<div class="c-mini">${c.status === 'submitted' || ['active', 'ending', 'ended'].includes(c.status) ? (canManage ? '同意記録がありません（外部締結の可能性）' : '参照権限では同意記録の本文は表示されません') : 'まだ同意されていません'}</div>`;
    const fillSnap = c.fill_snapshot && typeof c.fill_snapshot === 'object' && Object.keys(c.fill_snapshot).length
      ? `<details style="margin-top:8px"><summary class="c-mini" style="cursor:pointer">条件票（差し込み値）を見る</summary><dl class="c-kv" style="margin-top:6px">${Object.entries(c.fill_snapshot).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : '';

    // 契約情報
    const renewDeadline = c.auto_renew && c.end_date && c.renew_notice_days != null ? (() => { const t = new Date(h.fmtD(c.end_date) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - Number(c.renew_notice_days)); return t.toISOString().slice(0, 10); })() : null;
    const pred = c.predecessor_contract_id ? (D.related.find(x => String(x.id) === String(c.predecessor_contract_id)) || null) : null;
    const contractInfo = `<dl class="c-kv">
      <dt>文書 / 版</dt><dd>${esc(h.docTitle(doc))} ${esc(h.verLabel(ver))}${ver.id && ver.has_pdf !== false ? ` <a class="btn-sm" style="padding:1px 8px;font-size:11px" href="${h.pdfUrl(ver.id)}" target="_blank" rel="noopener">⬇ PDF</a>` : ''}</dd>
      <dt>契約相手</dt><dd>${esc(h.partyLabel(party))}</dd>
      <dt>締結方法</dt><dd>${esc(h.EXEC_LABELS[c.execution_method] || c.execution_method || 'HFS内同意')}</dd>
      <dt>締結日</dt><dd>${c.contract_date ? esc(h.fmtD(c.contract_date)) : '（承認時に確定）'}</dd>
      <dt>契約開始日</dt><dd>${esc(h.fmtD(c.start_date || (D.request && D.request.start_date)))}</dd>
      <dt>契約終了日</dt><dd>${c.end_date ? esc(h.fmtD(c.end_date)) : '—'}${c.auto_renew ? '（自動更新あり）' : ''}</dd>
      ${renewDeadline ? `<dt>更新拒絶期限</dt><dd>${esc(renewDeadline)} → 30日前に通知</dd>` : ''}
      ${c.billing_party_code ? `<dt>請求先</dt><dd>${esc(partyLabelByCode(c.billing_party_code))}</dd>` : ''}
      ${pred ? `<dt>旧契約</dt><dd>${esc(pred.party_name || h.partyLabel(pred.party_code))} ${esc(h.verLabel(pred.version))}（${esc(h.EXEC_LABELS[pred.execution_method] || '')}・${esc(h.fmtD(pred.start_date))}〜）${pred.status === 'ending' ? `<br>${h.chip('c-warn', `終了予定：${h.fmtD(pred.end_date)}`)}` : (pred.status === 'ended' ? `<br>${h.chip('c-gray', `終了 ${h.fmtD(pred.end_date)}`)}` : '')}</dd>` : ''}
      ${c.execution_method && c.execution_method !== 'hfs' && c.external_pdf_url ? `<dt>締結済みPDF</dt><dd><a href="${esc(c.external_pdf_url)}" target="_blank" rel="noopener" style="color:var(--em-dark)">Drive で開く</a></dd>` : ''}
      ${c.external_note ? `<dt>外部締結メモ</dt><dd>${esc(c.external_note)}</dd>` : ''}
      ${c.has_existing_projects != null ? `<dt>既存案件</dt><dd>${c.has_existing_projects ? `あり${c.existing_projects_party ? `（${esc(partyLabelByCode(c.existing_projects_party))}のまま）` : '（個人契約のまま）'}` : 'なし'}</dd>` : ''}
      ${c.storage_note ? `<dt>保存場所</dt><dd>${esc(c.storage_note)}</dd>` : ''}
      ${c.note ? `<dt>メモ</dt><dd>${esc(c.note)}</dd>` : ''}
      ${D.request && D.request.due_date ? `<dt>回答期限</dt><dd>${esc(h.fmtD(D.request.due_date))}</dd>` : ''}
      ${D.request && D.request.token && canManage ? `<dt>依頼URL</dt><dd><span class="c-mono">${esc(location.origin)}/haruka.html?contract_req=${esc(D.request.token)}</span> <button class="btn-sm" style="padding:1px 8px;font-size:11px" onclick="HFSContractAdmin.copyText('${esc(location.origin)}/haruka.html?contract_req=${esc(D.request.token)}')">コピー</button></dd>` : ''}
    </dl>`;

    // 本人情報（contract.page のみ。contract.view は非表示）
    const p = D.profile;
    const profileHtml = canManage && p ? `<div class="c-card"><h4>本人情報・請求情報（本人が入力）</h4><dl class="c-kv">
        <dt>区分</dt><dd>${esc(BIZ_LABELS[p.business_type] || p.business_type || '—')}${p.trade_name ? `（${esc(p.business_type === 'corporation' ? '法人名' : '屋号')}：${esc(p.trade_name)}${p.representative_name ? `・代表 ${esc(p.representative_name)}` : ''}）` : ''}</dd>
        <dt>氏名</dt><dd>${esc(p.full_name || '—')}${p.name_kana ? `<span class="c-mini">（${esc(p.name_kana)}）</span>` : ''}</dd>
        <dt>請求名義</dt><dd>${esc(p.invoice_name || '—')}</dd>
        <dt>登録番号</dt><dd class="c-mono">${esc(p.invoice_registration_number || '—')}</dd>
        <dt>連絡先</dt><dd>${esc(p.email || '—')}<br>${esc(p.phone || '—')}</dd>
        <dt>住所</dt><dd>${esc(p.postal_code ? `〒${p.postal_code} ` : '')}${esc(p.address || '—')}</dd>
        <dt>振込先</dt><dd>${esc(p.bank_name || '—')}${p.bank_code ? `(${esc(p.bank_code)})` : ''} ${esc(p.branch_name || '')}${p.branch_code ? `(${esc(p.branch_code)})` : ''} ${esc(p.account_type || '')} <span class="c-masked" id="ca-d-acct">${esc(p.account_number_masked || p.account_number || '—')}</span> ${esc(p.account_holder_kana || '')}
          ${D.canBankReveal && h.permission('contract.bank_reveal') ? `<button class="btn-sm" style="padding:2px 8px;font-size:11px" id="ca-d-reveal" onclick="HFSContractAdmin.bankReveal()">全桁を表示（履歴に残ります）</button>` : ''}</dd>
        ${p.profile_confirmed_at ? `<dt>本人確認日時</dt><dd>${esc(h.fmtDT(p.profile_confirmed_at))}</dd>` : ''}
      </dl></div>` : (canManage ? '' : '<div class="c-mini">参照権限では本人情報（住所・口座）は表示されません。</div>');

    const related = (D.related || []).filter(x => String(x.id) !== String(D.id));
    const relatedHtml = related.length ? `<div class="c-card"><h4>同じメンバーの他の契約</h4>${related.map(x => `<div class="cw-list-item"><div class="t"><b>${esc(h.docTitle(x.document))} ${esc(h.verLabel(x.version))}</b><div class="c-mini">${esc(x.party_name || h.partyLabel(x.party_code))}　${esc(h.EXEC_LABELS[x.execution_method] || '')}　${esc(h.fmtD(x.start_date))}〜${esc(x.end_date ? h.fmtD(x.end_date) : '')}</div></div>${h.memberStatus(x.status)}<button class="btn-sm" onclick="openContractDetail('${esc(x.id)}')">開く</button></div>`).join('')}</div>` : '';

    document.getElementById('modal-contract-detail-body').innerHTML = `
      ${acts.length ? `<div class="c-actions" style="margin:0 0 12px;justify-content:flex-start">${acts.join('')}</div>` : ''}
      ${canManage ? forms : ''}
      <div class="ca-detail" style="margin-top:12px">
        <div>
          <div class="c-card"><h4>タイムライン（操作履歴）</h4><ul class="ca-tl">${tl}${pendingLine}${!tl && !pendingLine ? '<li><time>—</time><span class="dot"></span><span class="c-mini">履歴がありません</span></li>' : ''}</ul></div>
          <div class="c-card"><h4>同意記録（書き換え不可）</h4>${consentHtml}${fillSnap}
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              ${ver.id && ver.has_pdf !== false ? `<a class="btn-sm" href="${h.pdfUrl(ver.id)}" target="_blank" rel="noopener">⬇ 契約書PDF</a>` : ''}
              ${consents.length && canManage ? `<button class="btn-sm" onclick="HFSContract.printReceipt('${esc(D.id)}')">⬇ 同意記録（控え）</button>` : ''}
            </div>
          </div>
        </div>
        <div>
          <div class="c-card"><h4>契約情報</h4>${contractInfo}</div>
          ${profileHtml}
          ${relatedHtml}
        </div>
      </div>`;
  }

  function showForm(kind) {
    ['approve', 'revision', 'end'].forEach(k => { const el = document.getElementById(`ca-d-form-${k}`); if (el) el.style.display = (k === kind) ? '' : 'none'; });
    if (kind === 'revision') document.getElementById('ca-d-revision-reason')?.focus();
  }

  async function approve() {
    const D = S.detail; if (!D) return;
    const body = {};
    const cd = document.getElementById('ca-d-approve-date')?.value; if (cd) body.contract_date = cd;
    const sd = document.getElementById('ca-d-approve-start')?.value; if (sd) body.start_date = sd;
    const r = await H().api(`/member-contracts/${encodeURIComponent(D.id)}/approve`, { method: 'POST', json: body });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(`承認しました（締結済み）${r.data && r.data.notified ? `・本人へ通知済み（${CHANNEL_LABELS[r.data.notify_channel] || r.data.notify_channel}）` : '・本人への通知は送れませんでした'}`, r.data && r.data.notified ? 'success' : 'warn');
    await openContractDetail(D.id);
    if (S.tab === 'list') renderList();
  }
  async function revision() {
    const D = S.detail; if (!D) return;
    const reason = (document.getElementById('ca-d-revision-reason')?.value || '').trim();
    if (!reason) { toast('修正依頼の理由を入力してください', 'warn'); return; }
    const r = await H().api(`/member-contracts/${encodeURIComponent(D.id)}/revision`, { method: 'POST', json: { reason } });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast(`修正を依頼しました${r.data && r.data.notified ? '・本人へ通知済み' : '・本人への通知は送れませんでした（DM 先をご確認ください）'}`, r.data && r.data.notified ? 'success' : 'warn');
    await openContractDetail(D.id);
    if (S.tab === 'list') renderList();
  }
  async function end() {
    const D = S.detail; if (!D) return;
    const end_date = document.getElementById('ca-d-end-date')?.value;
    const reason = (document.getElementById('ca-d-end-reason')?.value || '').trim();
    if (!end_date) { toast('終了日を入力してください', 'warn'); return; }
    const ok = await confirmDlg({ title: '契約を終了', message: `終了日 ${end_date} で契約を終了します。よろしいですか？`, okLabel: '終了する', okVariant: 'danger' });
    if (!ok) return;
    const r = await H().api(`/member-contracts/${encodeURIComponent(D.id)}/end`, { method: 'POST', json: { end_date, reason } });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('契約を終了しました', 'success');
    await openContractDetail(D.id);
    if (S.tab === 'list') renderList();
  }
  async function bankReveal() {
    const D = S.detail; if (!D) return;
    const ok = await confirmDlg({ title: '口座番号を全桁表示', message: 'この操作は操作履歴に記録されます（誰が・いつ表示したか）。表示しますか？', okLabel: '表示する' });
    if (!ok) return;
    const r = await H().api(`/member-contracts/${encodeURIComponent(D.id)}/bank-reveal`, { method: 'POST', json: {} });
    if (!r.ok) { toast(r.error, 'error'); return; }
    const el = document.getElementById('ca-d-acct');
    if (el) el.textContent = (r.data && r.data.account_number) || '—';
    const btn = document.getElementById('ca-d-reveal'); if (btn) btn.remove();
  }

  // ───────────────── 文書バージョン ─────────────────
  async function renderDocs() {
    const h = H();
    const body = document.getElementById('ca-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    await loadDocuments();
    if (S.notReady && !S.documents.length) { body.innerHTML = '<div class="c-notice">契約管理の準備中です（バックエンド未適用）</div>'; return; }
    const canManage = S.canManage;
    const docHtml = S.documents.map(d => {
      const vers = versionsOf(d).slice().sort((a, b) => (b.version_no || 0) - (a.version_no || 0));
      const verRows = vers.map(v => {
        const stChip = v.status === 'published' ? h.chip('c-ok', '公開中') : (v.status === 'draft' ? h.chip('c-gray', '下書き') : (v.status === 'superseded' ? h.chip('c-gray', '旧版') : h.chip('c-gray', v.status || '—')));
        return `<div class="ca-ver">
          <b>${esc(h.verLabel(v) || `v${v.version_no}`)}</b> ${stChip}
          <span class="c-mini">適用 ${esc(h.fmtD(v.effective_from))}〜${v.published_at ? `　公開 ${esc(h.fmtD(v.published_at))}` : ''}</span>
          ${v.requires_reconsent ? h.chip('c-info', '再同意対象') : ''}
          ${v.change_summary ? `<span class="c-mini">変更点：${esc(v.change_summary)}</span>` : ''}
          ${v.pdf_sha256 ? `<span class="c-mono" title="SHA-256">${esc(String(v.pdf_sha256).slice(0, 12))}…</span>` : ''}
          <span style="flex:1"></span>
          ${v.id && v.has_pdf && (canManage || v.status === 'published') ? `<a class="btn-sm" href="${h.pdfUrl(v.id)}" target="_blank" rel="noopener">⬇ PDF</a>` : (v.id && !v.has_pdf ? '<span class="c-mini">（PDF なし・本文のみ）</span>' : '')}
          ${canManage && v.status === 'draft' ? `<button class="btn-primary" style="font-size:12px;padding:5px 12px" onclick="HFSContractAdmin.publish('${esc(v.id)}', ${v.requires_reconsent ? 'true' : 'false'})">公開する</button>` : ''}
          ${v.status === 'published' ? '<span class="c-mini">公開後は本文・PDF・適用日を変更できません</span>' : ''}
        </div>`;
      }).join('');
      return `<div class="ca-doc">
        <div class="head"><b>${esc(h.docTitle(d))}</b>${h.chip('c-em', h.DOC_TYPE_LABELS[d.doc_type] || d.doc_type)}${d.party_code ? h.chip('c-gray', partyLabelByCode(d.party_code)) : h.chip('c-gray', '主体を問わない')}${d.client_name || (d.client && d.client.name) ? h.chip('c-gray', d.client_name || d.client.name) : ''}<span style="flex:1"></span>${canManage ? `<button class="btn-sm" onclick="HFSContractAdmin.toggleVerForm('${esc(d.id)}')">＋ 新しい版（PDF）</button>` : ''}</div>
        ${d.description ? `<div class="c-mini" style="margin-bottom:6px">${esc(d.description)}</div>` : ''}
        ${verRows || '<div class="c-mini">まだ版がありません</div>'}
        ${canManage ? `<div id="ca-verform-${esc(d.id)}" style="display:none;margin-top:10px;border-top:0.5px solid var(--border-light);padding-top:10px">
          <div class="c-row3">
            <div><label class="form-label">版ラベル</label><input class="form-input" id="ca-vf-label-${esc(d.id)}" placeholder="例) 法人版・2026-09-22改訂"></div>
            <div><label class="form-label">適用開始日</label><input class="form-input" type="date" id="ca-vf-eff-${esc(d.id)}" value="${esc(h.todayJst())}"></div>
            <div><label class="form-label">PDF（20MBまで）</label><input class="form-input" type="file" accept="application/pdf" id="ca-vf-pdf-${esc(d.id)}"></div>
          </div>
          <div class="form-group" style="margin:8px 0"><label class="form-label">変更点（再同意の案内文に載ります）</label><input class="form-input" id="ca-vf-summary-${esc(d.id)}" placeholder="例) 第12条 支払期日の表現"></div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="ca-vf-reconsent-${esc(d.id)}"> 公開時に旧版の有効契約を「再同意が必要」にする</label>
          <div class="c-actions"><button class="btn-sm" onclick="HFSContractAdmin.toggleVerForm('${esc(d.id)}')">キャンセル</button><button class="btn-primary" onclick="HFSContractAdmin.createVersion('${esc(d.id)}')">下書きとして登録</button></div>
        </div>` : ''}
      </div>`;
    }).join('');

    body.innerHTML = `
      ${canManage ? `<div class="c-card">
        <h4>文書を作成</h4>
        <div class="c-row3">
          <div><label class="form-label">種類</label><select class="form-select" id="ca-nd-type">${Object.entries(h.DOC_TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div><label class="form-label">契約主体</label><select class="form-select" id="ca-nd-party"><option value="">主体を問わない</option>${partyOptions('')}</select></div>
          <div><label class="form-label">タイトル</label><input class="form-input" id="ca-nd-title" placeholder="例) 業務委託基本契約書（法人版）"></div>
        </div>
        <div class="c-row2" style="margin-top:8px">
          <div><label class="form-label">説明（任意）</label><input class="form-input" id="ca-nd-desc" placeholder="本人に見せる一言（例: 納品・請求・セキュリティの運用）"></div>
          <div><label class="form-label">クライアントID（誓約書のみ・任意）</label><input class="form-input" id="ca-nd-client" placeholder="clients.id"></div>
        </div>
        <div class="c-actions"><button class="btn-primary" onclick="HFSContractAdmin.createDocument()">文書を作成</button></div>
      </div>` : ''}
      ${docHtml || '<div class="c-empty">文書がまだありません。</div>'}`;
  }
  function toggleVerForm(docId) {
    const el = document.getElementById(`ca-verform-${docId}`);
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  }
  async function createDocument() {
    const body = {
      doc_type: document.getElementById('ca-nd-type')?.value,
      party_code: document.getElementById('ca-nd-party')?.value || null,
      client_id: (document.getElementById('ca-nd-client')?.value || '').trim() || null,
      title: (document.getElementById('ca-nd-title')?.value || '').trim(),
      description: (document.getElementById('ca-nd-desc')?.value || '').trim() || null,
    };
    if (!body.title) { toast('タイトルを入力してください', 'warn'); return; }
    const r = await H().api('/documents', { method: 'POST', json: body });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('文書を作成しました。続けて PDF の版を登録してください', 'success');
    renderDocs();
  }
  async function createVersion(docId) {
    const pdf = document.getElementById(`ca-vf-pdf-${docId}`)?.files?.[0];
    if (!pdf) { toast('PDF を選択してください', 'warn'); return; }
    if (pdf.type && pdf.type !== 'application/pdf') { toast('PDF ファイルのみ登録できます', 'warn'); return; }
    if (pdf.size > 20 * 1024 * 1024) { toast('PDF は 20MB 以下にしてください', 'warn'); return; }
    const fd = new FormData();
    fd.append('pdf', pdf);
    fd.append('version_label', document.getElementById(`ca-vf-label-${docId}`)?.value || '');
    fd.append('effective_from', document.getElementById(`ca-vf-eff-${docId}`)?.value || '');
    fd.append('change_summary', document.getElementById(`ca-vf-summary-${docId}`)?.value || '');
    fd.append('requires_reconsent', document.getElementById(`ca-vf-reconsent-${docId}`)?.checked ? 'true' : 'false');
    const r = await H().api(`/documents/${encodeURIComponent(docId)}/versions`, { method: 'POST', body: fd });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('版を下書きとして登録しました（PDF は Drive に保存・SHA-256 を計算済み）', 'success');
    renderDocs();
  }
  async function publish(versionId, requiresReconsent) {
    const ok = await confirmDlg({ title: '版を公開', message: `この版を公開します。公開後は本文・PDF・適用日を変更できません。${requiresReconsent ? '\n旧版の有効契約は「再同意が必要」になります（本人への依頼は別途「依頼URLを発行」から送ります）。' : ''}`, okLabel: '公開する' });
    if (!ok) return;
    const r = await H().api(`/versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST', json: {} });
    if (!r.ok) { toast(r.error, 'error'); return; }
    const n = r.data && r.data.reconsent_required_count;
    toast(n ? `公開しました。${n} 件の有効契約が「再同意が必要」になりました（依頼は「＋ 依頼URLを発行」から）` : '公開しました', 'success');
    renderDocs();
  }

  // ───────────────── 既存契約の登録（外部締結） ─────────────────
  function renderExternal() {
    const h = H();
    const body = document.getElementById('ca-body');
    S.ext = S.ext || { userId: null, user: null };
    body.innerHTML = `<div class="c-card">
      <h4>既存契約の登録（紙・メール・外部電子契約で締結済みの契約）</h4>
      <div class="c-mini" style="margin-bottom:10px">既存メンバーの旧契約（個人事業主 髙橋聖との契約など）を記録として登録します。締結方法・日付・保存場所を残し、期限監視の対象にします。PDF は任意です。</div>
      <div class="c-row3">
        <div><label class="form-label">メンバー <span style="color:#C0392B">*</span></label><div><button class="btn-sm" id="ca-ext-user-btn" onclick="HFSContractAdmin.extPickUser(this)">${S.ext.user ? h.nameHtml(S.ext.user) : '👤 メンバーを選択'}</button></div></div>
        <div><label class="form-label">契約相手 <span style="color:#C0392B">*</span></label><select class="form-select" id="ca-ext-party">${partyOptions('individual_takahashi')}</select></div>
        <div><label class="form-label">締結方法 <span style="color:#C0392B">*</span></label><select class="form-select" id="ca-ext-method">${Object.entries(h.EXEC_LABELS).filter(([k]) => k !== 'hfs').map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
      </div>
      <div class="c-row2" style="margin-top:8px">
        <div><label class="form-label">文書 <span style="color:#C0392B">*</span></label><select class="form-select" id="ca-ext-doc" onchange="HFSContractAdmin.extDocChange()"><option value="">選択してください</option>${docOptions('', false)}</select></div>
        <div><label class="form-label">版（任意）</label><select class="form-select" id="ca-ext-ver"><option value="">（版を指定しない）</option></select></div>
      </div>
      <div class="c-row3" style="margin-top:8px">
        <div><label class="form-label">締結日 <span style="color:#C0392B">*</span></label><input class="form-input" type="date" id="ca-ext-cdate"></div>
        <div><label class="form-label">契約開始日</label><input class="form-input" type="date" id="ca-ext-start"></div>
        <div><label class="form-label">契約終了日</label><input class="form-input" type="date" id="ca-ext-end"></div>
      </div>
      <div class="c-row3" style="margin-top:8px">
        <div><label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:26px"><input type="checkbox" id="ca-ext-renew" checked> 自動更新あり</label></div>
        <div><label class="form-label">切替方法（法人契約への移行）</label><select class="form-select" id="ca-ext-switch"><option value="">未定</option><option value="new">新規締結（旧契約は終了予定）</option><option value="succession">承継のお知らせ</option></select></div>
        <div><label class="form-label">切替日</label><input class="form-input" type="date" id="ca-ext-switchdate"></div>
      </div>
      <div class="c-row3" style="margin-top:8px">
        <div><label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:26px"><input type="checkbox" id="ca-ext-hasproj"> 進行中の既存案件あり</label></div>
        <div><label class="form-label">既存案件の契約主体</label><select class="form-select" id="ca-ext-projparty"><option value="">（既存案件は個人契約のまま）</option>${partyOptions('')}</select></div>
        <div><label class="form-label">請求先</label><select class="form-select" id="ca-ext-billparty"><option value="">（契約相手と同じ）</option>${partyOptions('')}</select></div>
      </div>
      <div class="c-row2" style="margin-top:8px">
        <div><label class="form-label">保存場所（原本）</label><input class="form-input" id="ca-ext-storage" placeholder="例) Drive ／ 契約書／2026／◯◯"></div>
        <div><label class="form-label">締結済み PDF（任意）</label><input class="form-input" type="file" accept="application/pdf" id="ca-ext-pdf"></div>
      </div>
      <div class="c-row2" style="margin-top:8px">
        <div><label class="form-label">締結済み PDF の URL（Drive 等・PDF を添付しない場合）</label><input class="form-input" id="ca-ext-pdfurl" placeholder="https://drive.google.com/file/d/…"></div>
        <div><label class="form-label">外部締結メモ（締結の経緯など）</label><input class="form-input" id="ca-ext-extnote"></div>
      </div>
      <div class="form-group" style="margin-top:8px"><label class="form-label">メモ</label><textarea class="form-input" id="ca-ext-note" rows="2"></textarea></div>
      <div class="c-actions"><button class="btn-primary" onclick="HFSContractAdmin.extSubmit()">登録する（締結済みとして記録）</button></div>
    </div>`;
  }
  function extPickUser(btn) {
    if (!window.MemberPicker) { toast('MemberPicker が読み込まれていません', 'error'); return; }
    window.MemberPicker.open(btn, {
      mode: 'single', value: S.ext.userId, title: '契約を登録するメンバー', showInactive: true,
      onChange: async (id) => {
        S.ext.userId = id ? String(id) : null;
        try { const members = await window.MemberPicker.loadMembers(); S.ext.user = members.find(x => String(x.id) === S.ext.userId) || null; } catch (_) {}
        const b = document.getElementById('ca-ext-user-btn');
        if (b) b.innerHTML = S.ext.user ? H().nameHtml(S.ext.user) : '👤 メンバーを選択';
      },
    });
  }
  function extDocChange() {
    const h = H();
    const docId = document.getElementById('ca-ext-doc')?.value;
    const sel = document.getElementById('ca-ext-ver');
    if (!sel) return;
    const d = S.documents.find(x => String(x.id) === String(docId));
    sel.innerHTML = '<option value="">（版を指定しない）</option>' + versionsOf(d || {}).map(v => `<option value="${esc(v.id)}">${esc(h.verLabel(v) || `v${v.version_no}`)}（${esc(v.status)}）</option>`).join('');
  }
  async function extSubmit() {
    if (!S.ext.userId) { toast('メンバーを選択してください', 'warn'); return; }
    const g = (id) => document.getElementById(id)?.value || '';
    const docId = g('ca-ext-doc');
    if (!docId) { toast('文書を選択してください', 'warn'); return; }
    if (!g('ca-ext-cdate')) { toast('締結日を入力してください', 'warn'); return; }
    const fd = new FormData();
    fd.append('user_id', S.ext.userId);
    fd.append('party_code', g('ca-ext-party'));
    fd.append('document_id', docId);
    if (g('ca-ext-ver')) fd.append('version_id', g('ca-ext-ver'));
    fd.append('execution_method', g('ca-ext-method'));
    fd.append('contract_date', g('ca-ext-cdate'));
    if (g('ca-ext-start')) fd.append('start_date', g('ca-ext-start'));
    if (g('ca-ext-end')) fd.append('end_date', g('ca-ext-end'));
    fd.append('auto_renew', document.getElementById('ca-ext-renew')?.checked ? 'true' : 'false');
    if (g('ca-ext-switch')) fd.append('switch_method', g('ca-ext-switch'));
    if (g('ca-ext-switchdate')) fd.append('switch_date', g('ca-ext-switchdate'));
    fd.append('has_existing_projects', document.getElementById('ca-ext-hasproj')?.checked ? 'true' : 'false');
    if (g('ca-ext-projparty')) fd.append('existing_projects_party', g('ca-ext-projparty'));
    if (g('ca-ext-billparty')) fd.append('billing_party_code', g('ca-ext-billparty'));
    if (g('ca-ext-storage')) fd.append('storage_note', g('ca-ext-storage'));
    if (g('ca-ext-note')) fd.append('note', g('ca-ext-note'));
    if (g('ca-ext-pdfurl')) fd.append('external_pdf_url', g('ca-ext-pdfurl'));
    if (g('ca-ext-extnote')) fd.append('external_note', g('ca-ext-extnote'));
    const pdf = document.getElementById('ca-ext-pdf')?.files?.[0];
    if (pdf) {
      if (pdf.size > 20 * 1024 * 1024) { toast('PDF は 20MB 以下にしてください', 'warn'); return; }
      fd.append('pdf', pdf);
    }
    const r = await H().api('/member-contracts/external', { method: 'POST', body: fd });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('既存契約を登録しました', 'success');
    S.ext = { userId: null, user: null };
    S.tab = 'list';
    renderShell();
    renderList();
  }

  // ───────────────── 操作履歴 ─────────────────
  async function renderEvents() {
    const body = document.getElementById('ca-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    const r = await H().api('/events?limit=200');
    if (!r.ok) { body.innerHTML = `<div class="c-notice ${r.notReady ? '' : 'bad'}">${esc(r.error)}</div>`; return; }
    const events = Array.isArray(r.data) ? r.data : (r.data && r.data.events) || [];
    const h = H();
    body.innerHTML = `<div class="c-card"><h4>操作履歴（最新 ${events.length} 件）</h4>
      <ul class="ca-tl">${events.slice().sort((a, b) => new Date(b.created_at || b.at) - new Date(a.created_at || a.at)).map(e => {
        const target = e.target_user || e.member || (e.user_id ? { full_name: e.user_full_name || `ID:${e.user_id}` } : null);
        const line = eventLine(e);
        return target ? line.replace('</span></li>', `<div class="c-mini">対象：${h.nameHtml(target)}${e.member_contract_id ? ` <button class="btn-sm" style="padding:0 6px;font-size:10px" onclick="openContractDetail('${esc(e.member_contract_id)}')">詳細</button>` : ''}</div></span></li>`) : line;
      }).join('') || '<li><span class="c-mini">履歴がありません</span></li>'}</ul></div>`;
  }

  // ───────────────── 設定 ─────────────────
  async function renderSettings() {
    const body = document.getElementById('ca-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    const r = await H().api('/settings');
    if (!r.ok) { body.innerHTML = `<div class="c-notice ${r.notReady ? '' : 'bad'}">${esc(r.error)}</div>`; return; }
    const s = (r.data && (r.data.settings || r.data)) || {};
    S.settings = s;
    const expiry = String(s.contract_expiry_notice_days ?? '60,30').split(',').map(x => x.trim());
    const v = (k, d) => esc(s[k] != null && s[k] !== '' ? s[k] : d);
    body.innerHTML = `<div class="c-card">
      <h4>期限とお知らせの自動化（workers/contract-reminder.js・毎日 10:00 JST）</h4>
      <div class="ca-setting">
        <div class="r"><span>未対応の催促：依頼から</span><input type="number" min="1" id="ca-s-remind" value="${v('contract_remind_interval_days', 3)}">日ごと<span class="c-mini">（オンボーディング停滞催促と同じ間隔）</span></div>
        <div class="r"><span>回答期限：</span><input type="number" min="0" id="ca-s-due" value="${v('contract_due_notice_days', 3)}">日前と当日に本人へ</div>
        <div class="r"><span>契約の有効期限：</span><input type="number" min="0" id="ca-s-exp1" value="${esc(expiry[0] || 60)}">日前・<input type="number" min="0" id="ca-s-exp2" value="${esc(expiry[1] || 30)}">日前に本人と管理者へ</div>
        <div class="r"><span>自動更新の拒絶期限：</span><input type="number" min="0" id="ca-s-renew" value="${v('contract_renewal_notice_days', 30)}">日前に管理者へ</div>
      </div>
    </div>
    <div class="c-card">
      <h4>送信先・保存先</h4>
      <div class="ca-setting">
        <div class="r"><span style="min-width:220px">契約書の Drive フォルダID</span><input type="text" id="ca-s-folder" style="width:min(420px,100%)" value="${v('contract_root_folder_id', '')}" placeholder="空欄なら請求書フォルダと同じ親に「契約書」を自動作成"></div>
        <div class="r"><span style="min-width:220px">Chatwork 通知ルームID（DM ルーム未登録者向け）</span><input type="text" id="ca-s-cw" style="width:min(420px,100%)" value="${v('contract_notify_chatwork_room_id', '')}"></div>
        <div class="r"><span style="min-width:220px">管理者日次サマリ Slack ユーザーID（カンマ区切り）</span><input type="text" id="ca-s-slack" style="width:min(420px,100%)" value="${v('contract_admin_summary_slack_user_ids', '')}"></div>
      </div>
      <div class="c-actions"><button class="btn-primary" onclick="HFSContractAdmin.saveSettings()">設定を保存</button></div>
    </div>
    <div class="c-card">
      <h4>一覧の見え方</h4>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${H().chip('c-warn', '依頼済み・未閲覧 3日')}${H().chip('c-info', '閲覧済み・同意待ち')}${H().chip('c-pend', '確認待ち')}${H().chip('c-ok', '締結済み')}${H().chip('c-warn', '期限まで28日')}${H().chip('c-bad', '期限切れ')}${H().chip('c-info', '再同意が必要')}${H().chip('c-gray', '終了')}</div>
      <div class="c-mini" style="margin-top:8px">「期限切れ」「再同意が必要」は一覧の先頭に固定表示。管理者には毎朝 Slack DM で日次サマリが届きます。</div>
    </div>`;
  }
  async function saveSettings() {
    const g = (id) => document.getElementById(id)?.value ?? '';
    const body = {
      contract_remind_interval_days: Number(g('ca-s-remind')) || 3,
      contract_due_notice_days: Number(g('ca-s-due')) || 0,
      contract_expiry_notice_days: `${Number(g('ca-s-exp1')) || 0},${Number(g('ca-s-exp2')) || 0}`,
      contract_renewal_notice_days: Number(g('ca-s-renew')) || 0,
      contract_root_folder_id: g('ca-s-folder').trim() || null,
      contract_notify_chatwork_room_id: g('ca-s-cw').trim() || null,
      contract_admin_summary_slack_user_ids: g('ca-s-slack').trim() || null,
    };
    const r = await H().api('/settings', { method: 'PUT', json: body });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('設定を保存しました', 'success');
  }

  // ───────────────── 契約主体マスタ ─────────────────
  // routes/contracts.js PARTY_EDITABLE（billing_parties の編集可能列）
  const PARTY_FIELDS = [
    ['display_name', '表示名'], ['legal_name', '正式名称（契約書の甲）'], ['trade_name', '屋号（個人事業主のみ）'], ['representative_title', '代表者肩書'], ['representative_name', '代表者名'],
    ['postal_code', '郵便番号'], ['address', '本店所在地／住所'], ['corporate_number', '法人番号（13桁）'], ['invoice_registration_number', '適格請求書発行事業者登録番号（T+13桁）'],
    ['court_name', '合意管轄裁判所'], ['contact_email', '連絡先メール'], ['effective_from', '有効開始日'], ['effective_to', '有効終了日'],
  ];
  async function renderParties() {
    const h = H();
    const body = document.getElementById('ca-body');
    body.innerHTML = '<div class="c-loading">読み込み中…</div>';
    await loadParties();
    if (!S.parties.length) { body.innerHTML = `<div class="c-notice">${S.notReady ? '契約管理の準備中です（バックエンド未適用）' : '契約主体がまだ登録されていません（migration の seed をご確認ください）'}</div>`; return; }
    body.innerHTML = `<div class="c-mini" style="margin-bottom:10px">契約書の甲欄・請求先に使う自社情報です。本店所在地・法人番号・登録番号など未確定の項目は空欄のままで構いません（確定後に入力）。</div>` +
      S.parties.map(p => {
        return `<div class="c-card">
          <h4>${esc(h.partyLabel(p))} <span class="c-mono">${esc(p.code)}</span> ${h.chip('c-gray', p.party_kind === 'individual' ? '個人事業主' : '法人')}${p.is_active === false ? h.chip('c-gray', '無効') : ''}</h4>
          <div class="c-row2">${PARTY_FIELDS.map(([k, label]) => `<div><label class="form-label">${esc(label)}</label><input class="form-input" data-party="${esc(p.code)}" data-key="${esc(k)}" value="${esc(p[k] == null ? '' : p[k])}" ${k === 'effective_from' || k === 'effective_to' ? 'type="date"' : ''}></div>`).join('')}</div>
          <div class="c-actions"><button class="btn-primary" onclick="HFSContractAdmin.saveParty('${esc(p.code)}')">保存</button></div>
        </div>`;
      }).join('');
  }
  async function saveParty(code) {
    const body = {};
    document.querySelectorAll(`input[data-party="${CSS.escape(code)}"]`).forEach(i => { body[i.dataset.key] = i.value.trim() === '' ? null : i.value.trim(); });
    const r = await H().api(`/parties/${encodeURIComponent(code)}`, { method: 'PUT', json: body });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('契約主体を保存しました', 'success');
    renderParties();
  }

  // ───────────────── 公開 ─────────────────
  window.HFSContractAdmin = {
    tab: setTab, filter: applyFilter, tile: setTile, reload: renderList, remind, cancelRequest,
    reqPickUsers, reqRemoveUser, reqToggleVersion, reqPartyChange, reqField, reqRegenMessage, reqSubmit, copyText,
    showForm, approve, revision, end, bankReveal,
    toggleVerForm, createDocument, createVersion, publish,
    extPickUser, extDocChange, extSubmit,
    saveSettings, saveParty,
  };
  window.loadContractAdminPage = loadContractAdminPage;
  window.openContractRequestModal = openContractRequestModal;
  window.openContractDetail = openContractDetail;

})(window, document);

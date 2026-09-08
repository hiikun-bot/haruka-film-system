/* ============================================================
 * contract-wizard.js — 📝 契約・登録手続き（本人用ページ #page-contract）＋ホームバナー
 *   ADR 035（docs/design/decisions/035-contract-management.md）Stage 3。
 *
 *   公開 API（window）:
 *     loadContractPage(token?)     ページ入口。token を渡すと依頼詳細から開始（?contract_req= ディープリンク）
 *     renderContractBanner()       ホームの契約バナー（#dash-contract-banner）を GET /contracts/me の banner で描画
 *     HFSContract                  管理画面（contract-admin.js）と共有するヘルパー群
 *
 *   API は haruka.html の apiFetch()（X-View-As 付与）経由。名前表示は NameDisplay 経由。
 *   バックエンド未適用（503 / 404）のときは「契約管理の準備中です」と表示して落ちない。
 * ============================================================ */
(function (window, document) {
  'use strict';

  const BASE = '/api/haruka/contracts';

  // ───────────────── 共有ヘルパー ─────────────────
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[contract]', type, msg);
  }
  function nameOf(u) {
    if (window.NameDisplay) return window.NameDisplay.full(u);
    return (u && (u.nickname || u.full_name)) || '(名前未設定)';
  }
  function nameHtml(u) {
    if (window.NameDisplay) return window.NameDisplay.formatHtml(u, { tier: 'full' });
    return esc(nameOf(u));
  }
  function permission(key) {
    return typeof window.hasPermission === 'function' ? !!window.hasPermission(key) : false;
  }

  // すべて JST 表示（Railway は UTC 動作のため timeZone を明示）
  const JST = 'Asia/Tokyo';
  function fmtDT(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('ja-JP', { timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDTS(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('ja-JP', { timeZone: JST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' JST';
  }
  function fmtD(iso) {
    if (!iso) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso);
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('sv-SE', { timeZone: JST });
  }
  function fmtMD(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('ja-JP', { timeZone: JST, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function todayJst() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: JST });
  }
  function addDaysJst(days) {
    const t = new Date(todayJst() + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  }
  // 'YYYY-MM-DD'（JST 日付）同士の日数差（b - a）
  function daysDiff(a, b) {
    if (!a || !b) return null;
    const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((db - da) / 86400000);
  }
  function daysSince(iso) {
    if (!iso) return null;
    return daysDiff(fmtD(iso), todayJst());
  }

  const PARTY_LABELS = { individual_takahashi: '個人事業主 髙橋聖', haruka_film_inc: '株式会社HARUKA FILM' };
  const DOC_TYPE_LABELS = {
    basic_agreement: '業務委託基本契約書', rules_confirmation: '業務ルール確認書', client_pledge: '誓約書（クライアント固有）',
    succession_notice: '契約承継のお知らせ', amendment_memo: '覚書', individual_contract: '個別契約書', termination_notice: '終了通知',
  };
  const EXEC_LABELS = { hfs: 'HFS内同意', external_esign: '外部電子契約', paper: '紙', email: 'メール', chat: 'チャット', other: 'その他' };
  function partyLabel(p) {
    if (!p) return '—';
    if (typeof p === 'string') return PARTY_LABELS[p] || p;
    return p.display_name || p.name || p.legal_name || PARTY_LABELS[p.code] || p.code || '—';
  }
  function partyRep(p) {
    if (!p || typeof p !== 'object') return '';
    const title = p.representative_title || '';
    const name = p.representative_name || '';
    return [title, name].filter(Boolean).join('　');
  }
  function docTitle(d) {
    if (!d) return '—';
    const doc = d.document || d;
    return doc.title || DOC_TYPE_LABELS[doc.doc_type] || doc.doc_type || '文書';
  }
  function verLabel(v) {
    if (!v) return '';
    const n = v.version_no != null ? `v${v.version_no}` : '';
    return v.version_label ? (n ? `${n} ${v.version_label}` : v.version_label) : n;
  }
  function chip(cls, text) {
    return `<span class="cchip ${cls}">${esc(text)}</span>`;
  }
  function maskAccount(num) {
    const s = String(num || '').replace(/\s/g, '');
    if (!s) return '';
    return '****' + s.slice(-4);
  }

  // 制作者向けの状態表示（ADR 035 状態機械の「制作者向け表示」列）
  function memberStatus(status, opts) {
    const o = opts || {};
    switch (status) {
      case 'requested': return o.hasDraft ? chip('c-info', '入力中') : chip('c-warn', '未着手（依頼あり）');
      case 'submitted': return chip('c-pend', '確認待ち');
      case 'revision_requested': return chip('c-warn', '修正依頼あり');
      case 'active': return chip('c-ok', '契約手続き完了');
      case 'ending': return chip('c-ok', '契約手続き完了（終了予定）');
      case 'ended': return chip('c-gray', '終了');
      case 'reconsent_required': return chip('c-info', '再同意が必要');
      case 'cancelled': return chip('c-gray', '取消');
      default: return chip('c-gray', status || '—');
    }
  }

  // apiFetch ラッパ。{ ok, status, data, error, notReady } を返す（例外を投げない）
  async function api(path, init) {
    const f = (typeof window.apiFetch === 'function') ? window.apiFetch : window.fetch.bind(window);
    const opts = Object.assign({}, init || {});
    if (opts.json !== undefined) {
      opts.headers = Object.assign({}, opts.headers || {}, { 'Content-Type': 'application/json' });
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    let res;
    try {
      res = await f(BASE + path, opts);
    } catch (e) {
      return { ok: false, status: 0, data: null, error: 'ネットワークエラーが発生しました', notReady: false };
    }
    let data = null;
    const ct = (res.headers && res.headers.get('content-type')) || '';
    try {
      data = ct.includes('application/json') ? await res.json() : await res.text();
    } catch (_) { data = null; }
    // 503（テーブル未作成）/ 404 でルート未マウント（Express の "Cannot GET" HTML）は「準備中」扱い
    const notReady = res.status === 503 || (res.status === 404 && (typeof data !== 'object' || data === null));
    const error = (data && typeof data === 'object' && data.error)
      || (notReady ? '契約管理の準備中です（バックエンド未適用）' : (res.ok ? '' : `エラーが発生しました (${res.status})`));
    return { ok: res.ok, status: res.status, data, error, notReady };
  }

  // #print-only（請求書 PDF 保存と同じ流儀）で印刷 → ブラウザの「PDFに保存」
  function printHtml(html, title) {
    const box = document.getElementById('print-only');
    if (!box) { toast('印刷領域が見つかりません', 'error'); return; }
    box.innerHTML = html;
    const prev = document.title;
    if (title) document.title = title;
    window.print();
    setTimeout(() => { document.title = prev; }, 500);
  }

  // 同意記録の控え（GET /member-contracts/:id/receipt / POST submit の receipt → 印刷用 HTML）
  // 形は routes/contracts.js buildReceipt(): { request_id, signer_name, submitted_at, member{id,full_name,email,business_type,invoice_name},
  //   party{code,legal_name,display_name,representative_title,representative_name},
  //   documents[{member_contract_id,title,doc_type,version_no,version_label,effective_from,pdf_sha256,body_sha256,status,contract_date,start_date,end_date,
  //              auto_renew,approved_at,fill_snapshot,consents[{consent_kind,signer_name_typed,signer_name_registered,consented_at,ip_address,user_agent,pdf_sha256,record_hash,prev_record_hash}],viewed_at[],chain_ok}],
  //   generated_at }
  function receiptHtml(rc) {
    const r = rc || {};
    const member = r.member || {};
    const party = r.party || null;
    const docs = Array.isArray(r.documents) ? r.documents : [];
    const firstConsent = docs.flatMap(d => d.consents || [])[0] || {};
    const rows = docs.map(d => {
      const cs = (d.consents || []).length ? d.consents : [{}];
      return cs.map(c => `<tr>
        <td>${esc(d.title || '—')} ${esc(verLabel(d))}${d.effective_from ? `<br><span style="color:#666">適用 ${esc(fmtD(d.effective_from))}〜</span>` : ''}</td>
        <td>${esc(c.consent_kind === 'acknowledged' ? '確認' : (c.consent_kind ? '同意' : '—'))}</td>
        <td>${esc(fmtDTS(c.consented_at || r.submitted_at))}</td>
        <td class="mono">${esc(c.pdf_sha256 || d.pdf_sha256 || '—')}</td>
        <td class="mono">${esc(c.record_hash || '—')}${d.chain_ok === false ? '<br><span style="color:#c9384a">（連鎖検証 NG）</span>' : ''}</td>
      </tr>`).join('');
    }).join('');
    const period = docs[0] ? `${fmtD(docs[0].start_date)} 〜 ${docs[0].end_date ? fmtD(docs[0].end_date) : (docs[0].auto_renew ? '自動更新' : '—')}` : '—';
    return `<div class="c-receipt">
      <h1>同意記録の控え</h1>
      <table>
        <tr><th>署名者名（入力）</th><td>${esc(r.signer_name || firstConsent.signer_name_typed || '—')}</td></tr>
        <tr><th>登録氏名</th><td>${esc(member.full_name || firstConsent.signer_name_registered || '—')}</td></tr>
        <tr><th>ユーザーID / メール</th><td>${esc(member.id || '—')} / ${esc(member.email || '—')}</td></tr>
        <tr><th>契約相手</th><td>${esc(partyLabel(party))}${partyRep(party) ? `（${esc(partyRep(party))}）` : ''}${party && party.legal_name && party.legal_name !== party.display_name ? `<br><span style="color:#666">${esc(party.legal_name)}</span>` : ''}</td></tr>
        <tr><th>契約期間</th><td>${esc(period)}</td></tr>
        <tr><th>送信日時</th><td>${esc(fmtDTS(r.submitted_at))}</td></tr>
        <tr><th>接続元IP / ブラウザ</th><td>${esc(firstConsent.ip_address || '—')}<br><span style="font-size:10px">${esc(firstConsent.user_agent || '—')}</span></td></tr>
        <tr><th>記録ID</th><td class="mono">${docs.map(d => esc(d.member_contract_id)).join('<br>') || '—'}</td></tr>
      </table>
      <table>
        <thead><tr><th style="width:auto">文書 / 版</th><th style="width:auto">種別</th><th style="width:auto">日時</th><th style="width:auto">文書ハッシュ (SHA-256)</th><th style="width:auto">記録ハッシュ</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">同意記録がありません</td></tr>'}</tbody>
      </table>
      <div class="foot">この控えは HARUKA FILM SYSTEM に記録された同意証跡（contract_consents・追記専用）から生成しています。記録ハッシュは直前レコードのハッシュを含む連鎖値で、後から書き換えることはできません。出力日時：${esc(fmtDTS(r.generated_at || new Date().toISOString()))}</div>
    </div>`;
  }

  async function printReceipt(memberContractId) {
    const r = await api(`/member-contracts/${encodeURIComponent(memberContractId)}/receipt`);
    if (!r.ok) { toast(r.error, 'error'); return; }
    printHtml(receiptHtml(r.data), `同意記録の控え_${todayJst()}`);
  }

  function pdfUrl(versionId) {
    return `${BASE}/versions/${encodeURIComponent(versionId)}/pdf`;
  }

  window.HFSContract = {
    BASE, esc, toast, api, nameOf, nameHtml, permission,
    fmtDT, fmtDTS, fmtD, fmtMD, todayJst, addDaysJst, daysDiff, daysSince,
    PARTY_LABELS, DOC_TYPE_LABELS, EXEC_LABELS, partyLabel, partyRep, docTitle, verLabel, chip, maskAccount, memberStatus,
    printHtml, receiptHtml, printReceipt, pdfUrl,
  };

  // ───────────────── 本人ページ ─────────────────
  const ROOT_ID = 'contract-root';
  let cw = null;          // ウィザード状態
  let cwSaving = false;

  function root() { return document.getElementById(ROOT_ID); }

  function navBtnFor(page) {
    return document.querySelector(`.nav-btn[data-page="${page}"]`) || document.querySelector(`.nav-drawer-btn[data-page="${page}"]`);
  }

  // 入口。token 指定（ディープリンク / バナー）ならその依頼を開く。無ければ一覧
  async function loadContractPage(token) {
    const el = root();
    if (!el) return;
    const t = token || window._contractReqToken || null;
    window._contractReqToken = null;
    if (t) { await openRequest(t); return; }
    await renderHome();
  }

  async function renderHome() {
    const el = root();
    el.innerHTML = `<div class="c-wrap"><div class="c-bar"><h2>📝 契約・登録手続き</h2></div><div class="c-loading">読み込み中…</div></div>`;
    const r = await api('/me');
    if (!r.ok) {
      el.innerHTML = `<div class="c-wrap"><div class="c-bar"><h2>📝 契約・登録手続き</h2></div>
        <div class="c-notice ${r.notReady ? '' : 'bad'}">${esc(r.error)}</div></div>`;
      return;
    }
    // 形は routes/contracts.js GET /me: requests[]=requestToJson(self)（token/url/has_draft/status: open|submitted|completed|cancelled）、
    // contracts[]=contractToJson（request_id/document/version/status/party_name）。依頼→文書は contracts を request_id で結合する
    const me = r.data || {};
    const requests = Array.isArray(me.requests) ? me.requests : [];
    const contracts = Array.isArray(me.contracts) ? me.contracts : [];
    const docsOf = (q) => contracts.filter(c => String(c.request_id) === String(q.id));
    const openReqs = requests.filter(q => q.status === 'open');
    const otherReqs = requests.filter(q => q.status !== 'open');

    const reqRow = (q) => {
      const cs = docsOf(q);
      const docs = cs.map(c => `${docTitle(c)} ${verLabel(c.version)}`.trim()).join('・');
      const isOpen = q.status === 'open';
      const st = isOpen ? (cs.some(c => c.status === 'revision_requested') ? 'revision_requested' : 'requested')
        : (q.status === 'submitted' ? 'submitted' : (q.status === 'cancelled' ? 'cancelled' : (cs[0] ? cs[0].status : 'active')));
      const label = q.has_draft ? '続きから再開' : '手続きを始める';
      const btn = isOpen && q.token
        ? `<button class="btn-primary" style="font-size:13px;padding:7px 16px" onclick="HFSContractWizard.open('${esc(q.token)}')">${label} ▶</button>`
        : (q.status === 'submitted' && q.token ? `<button class="btn-sm" onclick="HFSContractWizard.open('${esc(q.token)}')">控えを見る</button>` : '');
      const due = q.due_date ? `<span class="c-mini">回答期限 ${esc(fmtD(q.due_date))}</span>` : '';
      return `<div class="cw-list-item">
        <div class="t"><b>${esc((cs[0] && cs[0].party_name) || partyLabel(q.party_code))}</b><div class="c-mini">${esc(docs || '—')}　依頼日 ${esc(fmtD(q.sent_at || q.requested_at))}</div></div>
        ${memberStatus(st, { hasDraft: !!q.has_draft })}
        ${due}
        ${btn}
      </div>`;
    };
    const ctRow = (c) => {
      const ver = c.version || {};
      const period = c.start_date ? `${fmtD(c.start_date)} 〜 ${c.end_date ? fmtD(c.end_date) : (c.auto_renew ? '自動更新' : '—')}` : '—';
      const pdf = ver.id && ver.has_pdf !== false ? `<a class="btn-sm" href="${pdfUrl(ver.id)}" target="_blank" rel="noopener">⬇ 契約書PDF</a>` : '';
      const extPdf = c.external_pdf_url ? `<a class="btn-sm" href="${esc(c.external_pdf_url)}" target="_blank" rel="noopener">⬇ 締結済みPDF</a>` : '';
      const rec = (c.execution_method === 'hfs' && ['submitted', 'active', 'ending', 'ended', 'reconsent_required'].includes(c.status))
        ? `<button class="btn-sm" onclick="HFSContract.printReceipt('${esc(c.id)}')">🧾 同意記録の控え</button>` : '';
      return `<div class="cw-list-item">
        <div class="t"><b>${esc(docTitle(c))} ${esc(verLabel(ver))}</b><div class="c-mini">${esc(c.party_name || partyLabel(c.party_code))}　${esc(EXEC_LABELS[c.execution_method] || '')}　期間 ${esc(period)}</div></div>
        ${memberStatus(c.status)}
        ${pdf}${extPdf}${rec}
      </div>`;
    };

    el.innerHTML = `<div class="c-wrap">
      <div class="c-bar"><h2>📝 契約・登録手続き</h2><span class="c-readonly-note" title="管理者を含め、あなたの依頼と契約だけを表示します">🔒 あなたの手続き</span></div>
      <div class="c-mini" style="margin-bottom:12px">HARUKA FILM との業務委託契約・確認書の閲覧と同意、本人情報・請求先・振込先の登録をここで行います。途中で閉じても、次回ここから再開できます。</div>
      <div class="c-card">
        <h4>手続きのお願い（${openReqs.length}件）</h4>
        ${openReqs.length ? openReqs.map(reqRow).join('') : '<div class="c-empty">現在お願いしている手続きはありません。</div>'}
      </div>
      <div class="c-card">
        <h4>あなたの契約</h4>
        ${contracts.filter(c => !['requested', 'revision_requested', 'cancelled'].includes(c.status)).length ? contracts.filter(c => !['requested', 'revision_requested', 'cancelled'].includes(c.status)).map(ctRow).join('') : '<div class="c-empty">登録済みの契約はまだありません。</div>'}
      </div>
      ${otherReqs.length ? `<div class="c-card"><h4>過去の依頼</h4>${otherReqs.map(reqRow).join('')}</div>` : ''}
      <div class="c-mini">操作方法は <a href="/guide-contract.html" target="_blank" rel="noopener" style="color:var(--em-dark);font-weight:600">📖 契約・登録手続きガイド</a> をご覧ください。</div>
    </div>`;
  }

  // 依頼を開く（GET /req/:token）
  async function openRequest(token) {
    const el = root();
    if (!el) return;
    el.innerHTML = `<div class="c-wrap"><div class="c-bar"><h2>📝 契約・登録手続き</h2></div><div class="c-loading">依頼を読み込み中…</div></div>`;
    const r = await api(`/req/${encodeURIComponent(token)}`);
    if (!r.ok) {
      toast(r.status === 403 ? 'この依頼URLはあなた宛てではありません。ご自身の手続き一覧を表示します' : r.error, r.status === 403 ? 'warn' : 'error');
      await renderHome();
      return;
    }
    // 形は routes/contracts.js GET /req/:token: { request(requestToJson self), party(billing_parties 行), documents[{member_contract_id,status,
    //   member_status_label,document{title,doc_type},version{id,version_no,version_label,effective_from,pdf_sha256,has_pdf,body_html,fill_fields},
    //   consent_kind,first_viewed_at,viewed_completed_at,revision_reason,start_date,end_date,auto_renew,renew_notice_days,fill_values}], profile, fill_values }
    const d = r.data || {};
    const req = d.request || {};
    const docs = Array.isArray(d.documents) ? d.documents : [];
    if (req.status === 'cancelled') { toast('この依頼は取り消されています', 'warn'); await renderHome(); return; }
    if (req.token_expired) toast('この依頼URLの有効期限は切れていますが、ご本人のためそのまま手続きできます', 'info');
    cw = {
      token, req, party: d.party || req.party_code, docs,
      profile: d.profile || {}, fill: d.fill_values || {},
      step: 0, checks: {}, bankChange: false, receipt: null, submitted: false,
      revisionReason: (docs.find(x => x.revision_reason) || {}).revision_reason || null,
      steps: [],
    };
    cw.steps = [
      { key: 'profile', title: '本人情報', sub: '氏名・連絡先・事業区分' },
      { key: 'billing', title: '請求情報・振込先', sub: '請求名義・登録番号・口座' },
      ...docs.map((doc, i) => ({ key: 'doc', idx: i, doc, title: `${docTitle(doc)} ${verLabel(doc.version)}`.trim(), sub: `${partyLabel(cw.party)}版` })),
      { key: 'sign', title: '同意して署名', sub: '氏名を入力' },
      { key: 'done', title: '完了・控えをダウンロード', sub: '' },
    ];
    // 途中保存の復元
    const ds = req.draft_state || {};
    if (ds && typeof ds === 'object') {
      cw.checks = Object.assign({}, ds.checks || {});
      cw.bankChange = !!ds.bankChange;
      if (Number.isInteger(ds.step)) cw.step = Math.min(Math.max(ds.step, 0), cw.steps.length - 2);
    }
    // 送信済み（確認待ち／承認済み）なら完了画面（request.status: open | submitted | completed | cancelled）
    const allDone = docs.length && docs.every(x => ['submitted', 'active', 'ending', 'ended'].includes(x.status));
    if (req.status === 'submitted' || req.status === 'completed' || allDone) { cw.submitted = true; cw.step = cw.steps.length - 1; }
    // 修正依頼はステップ1から（理由を表示）
    if (docs.some(x => x.status === 'revision_requested')) { cw.step = 0; cw.revision = true; }
    render();
  }

  function stepIndex(key) { return cw.steps.findIndex(s => s.key === key); }
  function curStep() { return cw.steps[cw.step]; }
  function isDocViewed(doc) { return !!doc.viewed_completed_at; }
  function stepDone(i) {
    const s = cw.steps[i];
    if (cw.submitted) return s.key !== 'done';
    if (s.key === 'profile') return !!cw.checks.profile_ok;
    if (s.key === 'billing') return !!cw.checks.billing_ok;
    if (s.key === 'doc') return isDocViewed(s.doc);
    if (s.key === 'sign') return false;
    return false;
  }
  function stepReachable(i) {
    if (cw.submitted) return i === cw.steps.length - 1;
    if (i === cw.steps.length - 1) return false;
    for (let k = 0; k < i; k++) if (!stepDone(k)) return false;
    return true;
  }

  function render() {
    const el = root();
    if (!el || !cw) return;
    const s = curStep();
    const idxSign = stepIndex('sign');
    const total = cw.steps.length - 1; // done を除いた段数
    const progress = cw.submitted ? '完了' : `${Math.min(cw.step + 1, total)} / ${total}`;
    const revisionNote = cw.revision && !cw.submitted
      ? `<div class="c-notice bad" style="margin-bottom:12px"><b>修正依頼があります。</b>${cw.revisionReason ? `<br>${esc(cw.revisionReason)}` : ''}<br><span class="c-mini">内容を確認・修正のうえ、もう一度「同意して送信」してください。</span></div>`
      : '';
    el.innerHTML = `<div class="c-wrap">
      <div class="c-bar">
        <h2>📝 契約・登録手続き</h2>
        ${chip(cw.submitted ? 'c-pend' : 'c-info', cw.submitted ? '送信済み' : `${progress}　${s.key === 'doc' ? '閲覧中' : s.title}`)}
        <span class="sp"></span>
        <button class="btn-sm" onclick="HFSContractWizard.home()">手続き一覧へ</button>
      </div>
      ${revisionNote}
      <div class="cw-grid">
        <aside class="cw-steps">
          <h4>手続きの流れ</h4>
          ${cw.steps.map((st, i) => renderStepItem(st, i)).join('')}
          <div class="c-mini" style="margin-top:8px;padding:0 8px">途中で閉じても、次回ログイン時にここから再開できます。</div>
        </aside>
        <div class="cw-main" id="cw-main">${renderStepBody(s, idxSign)}</div>
        <aside class="cw-side">${renderSide()}</aside>
      </div>
    </div>`;
  }

  function renderStepItem(st, i) {
    const done = stepDone(i);
    const cur = i === cw.step;
    const reach = stepReachable(i) || cur;
    const num = st.key === 'done' ? '✓' : String(i + 1);
    const stCls = done ? 'done' : (cur ? 'cur' : '');
    let sub = st.sub || '';
    if (st.key === 'billing' && done) sub = `確認済み${cw.profile.account_number || cw.profile.account_number_masked ? `（口座 ${maskAccount(cw.profile.account_number) || cw.profile.account_number_masked}）` : ''}`;
    if (st.key === 'doc' && done) sub = `閲覧完了 ${fmtMD(st.doc.viewed_completed_at)}`;
    return `<div class="cw-step ${cur ? 'cur' : ''} ${reach ? '' : 'locked'}" ${reach && !cur ? `onclick="HFSContractWizard.go(${i})"` : ''}>
      <span class="st ${stCls}">${done ? '✓' : num}</span>
      <div><b>${esc(st.title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    </div>`;
  }

  function renderSide() {
    const p = cw.party;
    const req = cw.req;
    const prof = cw.profile || {};
    const due = req.due_date ? fmtD(req.due_date) : null;
    const left = due ? daysDiff(todayJst(), due) : null;
    const dueHtml = due ? `<div class="cw-due ${left != null && left < 0 ? 'over' : ''}">回答期限：${esc(due)}${left != null ? (left >= 0 ? `（あと${left}日）` : `（${-left}日超過）`) : ''}</div>` : '';
    const d0 = cw.docs[0] || {};
    const period = d0.auto_renew ? `1年・自動更新${d0.renew_notice_days ? `（拒絶は${d0.renew_notice_days}日前まで）` : ''}` : (d0.end_date ? `〜 ${fmtD(d0.end_date)}` : (d0.start_date ? '1年' : '—'));
    const biz = { individual: '個人', sole_proprietor: '個人事業主', corporation: '法人' }[prof.business_type] || prof.business_type || '';
    return `<h4>この契約について</h4>
      <dl class="c-kv">
        <dt>契約相手</dt><dd>${esc(partyLabel(p))}${partyRep(p) ? `<br><span class="c-mini">${esc(partyRep(p))}</span>` : ''}</dd>
        <dt>あなた</dt><dd>${esc(prof.full_name || nameOf(window.currentUser))}${biz || prof.invoice_registration_number ? `<br><span class="c-mini">${esc(biz)}${prof.invoice_registration_number ? '・登録番号あり' : ''}</span>` : ''}</dd>
        <dt>契約開始日</dt><dd>${esc(fmtD(d0.start_date))}</dd>
        <dt>期間</dt><dd>${esc(period)}</dd>
        <dt>文書</dt><dd>${cw.docs.map(d => `${esc(docTitle(d))} ${esc(verLabel(d.version))}${d.version && d.version.effective_from ? `<span class="c-mini">（${esc(fmtD(d.version.effective_from))}〜）</span>` : ''}`).join('<br>') || '—'}</dd>
        <dt>依頼日</dt><dd>${esc(fmtD(req.sent_at || req.requested_at))}</dd>
      </dl>
      ${dueHtml}
      ${req.first_viewed_at ? `<div class="c-mini" style="margin-top:10px">閲覧を始めた日時は記録されます（初回閲覧 ${esc(fmtDT(req.first_viewed_at))}）。</div>` : ''}`;
  }

  function inp(id, label, value, opts) {
    const o = opts || {};
    return `<div class="form-group" style="margin-bottom:10px">
      <label class="form-label" for="${id}">${esc(label)}${o.required ? ' <span style="color:#C0392B">*</span>' : ''}</label>
      <input class="form-input" id="${id}" type="${o.type || 'text'}" value="${esc(value == null ? '' : value)}" ${o.readonly ? 'readonly style="background:#f3f7f7;color:#5b7473"' : ''} ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ''} ${o.attrs || ''}>
      ${o.hint ? `<div class="c-mini" style="margin-top:3px">${o.hint}</div>` : ''}
    </div>`;
  }

  function renderStepBody(s, idxSign) {
    const p = cw.profile || {};
    if (s.key === 'profile') {
      const bt = p.business_type || 'individual';
      return `<div class="cw-panel">
        <h3>1. 本人情報</h3>
        <div class="c-mini" style="margin-bottom:10px">契約書に差し込まれる情報です。登録氏名は署名時に同じ表記で入力します。</div>
        <div class="c-row2">
          ${inp('cw-full-name', '氏名（登録氏名）', p.full_name, { required: true })}
          ${inp('cw-name-kana', 'ふりがな', p.name_kana)}
        </div>
        <div class="c-row2">
          ${inp('cw-email', 'メールアドレス', p.email, { readonly: true, hint: '変更が必要な場合は管理者へご連絡ください' })}
          ${inp('cw-phone', '電話番号', p.phone, { required: true, type: 'tel' })}
        </div>
        <div class="c-row2">
          ${inp('cw-postal', '郵便番号', p.postal_code, { placeholder: '例) 650-0001' })}
          ${inp('cw-address', '住所', p.address, { required: true })}
        </div>
        <div class="form-group" style="margin-bottom:10px">
          <label class="form-label" for="cw-biz">事業区分 <span style="color:#C0392B">*</span></label>
          <select class="form-select" id="cw-biz" onchange="HFSContractWizard.onBizChange()">
            <option value="individual" ${bt === 'individual' ? 'selected' : ''}>個人</option>
            <option value="sole_proprietor" ${bt === 'sole_proprietor' ? 'selected' : ''}>個人事業主（屋号あり）</option>
            <option value="corporation" ${bt === 'corporation' ? 'selected' : ''}>法人</option>
          </select>
        </div>
        <div class="c-row2" id="cw-biz-extra" style="${bt === 'individual' ? 'display:none' : ''}">
          ${inp('cw-trade-name', bt === 'corporation' ? '法人名' : '屋号', p.trade_name)}
          ${inp('cw-rep-name', '代表者名', p.representative_name, { hint: '法人の場合は必須' })}
        </div>
        <div class="c-actions">
          <button class="btn-sm" onclick="HFSContractWizard.saveDraftOnly()">下書き保存</button>
          <button class="btn-primary" onclick="HFSContractWizard.saveProfile('profile')">保存して次へ ▶</button>
        </div>
      </div>`;
    }
    if (s.key === 'billing') {
      const masked = p.account_number_masked || maskAccount(p.account_number);
      const hasBank = !!(masked || p.bank_name);
      const showBankForm = cw.bankChange || !hasBank;
      return `<div class="cw-panel">
        <h3>2. 請求情報・振込先</h3>
        <div class="c-row2">
          ${inp('cw-invoice-name', '請求名義', p.invoice_name || p.trade_name || p.full_name, { required: true, hint: '請求書に記載する名義' })}
          ${inp('cw-inv-reg', 'インボイス登録番号', p.invoice_registration_number, { placeholder: 'T + 13桁（未登録なら空欄）', hint: '例) T1234567890123' })}
        </div>
        <h4 style="margin:14px 0 8px;font-size:12px;letter-spacing:.06em;color:var(--c-ink-soft)">振込先口座</h4>
        ${hasBank ? `<div class="cw-bankmask" style="margin-bottom:10px">
            <span>${esc(p.bank_name || '')}${p.bank_code ? `(${esc(p.bank_code)})` : ''} ${esc(p.branch_name || '')}${p.branch_code ? `(${esc(p.branch_code)})` : ''} ${esc(p.account_type || '')} <span class="c-masked">${esc(masked || '—')}</span> ${esc(p.account_holder_kana || '')}</span>
            ${showBankForm ? '' : `<button class="btn-sm" onclick="HFSContractWizard.toggleBank(true)">変更する</button>`}
          </div>` : ''}
        <div id="cw-bank-form" style="${showBankForm ? '' : 'display:none'}">
          <div class="c-row2">
            ${inp('cw-bank-name', '銀行名', p.bank_name, { required: true })}
            ${inp('cw-bank-code', '銀行コード', p.bank_code, { placeholder: '4桁' })}
          </div>
          <div class="c-row2">
            ${inp('cw-branch-name', '支店名', p.branch_name, { required: true })}
            ${inp('cw-branch-code', '支店コード', p.branch_code, { placeholder: '3桁' })}
          </div>
          <div class="c-row2">
            <div class="form-group" style="margin-bottom:10px">
              <label class="form-label" for="cw-account-type">口座種別</label>
              <select class="form-select" id="cw-account-type">
                <option value="普通" ${(p.account_type || '普通') === '普通' ? 'selected' : ''}>普通預金</option>
                <option value="当座" ${p.account_type === '当座' ? 'selected' : ''}>当座預金</option>
              </select>
            </div>
            ${inp('cw-account-number', '口座番号', showBankForm && cw.bankChange ? '' : (p.account_number || ''), { required: true, placeholder: '7桁', attrs: 'inputmode="numeric" autocomplete="off"' })}
          </div>
          ${inp('cw-account-holder', '口座名義（カナ）', p.account_holder_kana, { required: true, placeholder: '例) ヤマダ タロウ' })}
          ${hasBank ? `<div style="text-align:right"><button class="btn-sm" onclick="HFSContractWizard.toggleBank(false)">変更をやめる</button></div>` : ''}
        </div>
        <div class="c-actions">
          <button class="btn-sm" onclick="HFSContractWizard.go(${cw.step - 1})">◀ 戻る</button>
          <button class="btn-sm" onclick="HFSContractWizard.saveDraftOnly()">下書き保存</button>
          <button class="btn-primary" onclick="HFSContractWizard.saveProfile('billing')">保存して次へ ▶</button>
        </div>
      </div>`;
    }
    if (s.key === 'doc') {
      const d = s.doc;
      const v = d.version || {};
      const viewed = isDocViewed(d);
      const isAck = d.consent_kind === 'acknowledged';
      const fv = d.fill_values || cw.fill || {};
      const fills = [
        ['甲', fv.party_legal_name], ['乙', fv.member_invoice_name || fv.member_full_name], ['契約開始日', fv.start_date],
        ['適用', fv.effective_from], ['回答期限', fv.due_date],
      ].filter(([, val]) => val != null && val !== '');
      const hasPdf = !!(v.id && v.has_pdf !== false);
      return `<div class="cw-viewer">
        <div class="vh"><b>${esc(docTitle(d))}</b>${chip('c-em', verLabel(v) || 'v?')}<span class="sp" style="flex:1"></span>${viewed ? chip('c-ok', `閲覧完了 ${fmtMD(d.viewed_completed_at)}`) : chip('c-info', '閲覧中')}</div>
        <div class="paper">
          ${hasPdf
            ? `<iframe src="${pdfUrl(v.id)}#toolbar=1&view=FitH" title="${esc(docTitle(d))}"></iframe>`
            : (v.body_html
              ? `<div style="background:#fff;padding:26px 30px;font-size:12.5px;line-height:1.8;color:#222;overflow:auto;max-height:640px">${v.body_html}</div>`
              : `<div class="c-empty">PDF がまだ登録されていません。管理者にご連絡ください。</div>`)}
        </div>
        ${fills.length ? `<div style="padding:8px 12px;border-top:0.5px solid var(--border-light);font-size:12px"><span class="c-mini">差し込み値：</span>${fills.map(([k, val]) => `<span class="cw-fill" style="margin-right:8px">${esc(k)}: ${esc(val)}</span>`).join('')}</div>` : ''}
        <div class="vf">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="cw-viewed-${d.member_contract_id}" ${viewed ? 'checked disabled' : ''} onchange="HFSContractWizard.markViewed('${esc(d.member_contract_id)}', this)"> ${isAck ? '内容を確認しました' : '最後まで読みました'}</label>
          <span class="c-mini">${viewed ? '' : 'PDF を最後まで読んでからチェックすると「次へ」が押せます'}</span>
          <span style="flex:1"></span>
          ${hasPdf ? `<a class="btn-sm" href="${pdfUrl(v.id)}" target="_blank" rel="noopener">⬇ PDFを保存</a>` : ''}
          <button class="btn-sm" onclick="HFSContractWizard.go(${cw.step - 1})">◀ 戻る</button>
          <button class="btn-primary" id="cw-doc-next" style="font-size:13px;padding:7px 16px" ${viewed ? '' : 'disabled style="opacity:.5;font-size:13px;padding:7px 16px"'} onclick="HFSContractWizard.go(${cw.step + 1})">次へ ▶</button>
        </div>
      </div>`;
    }
    if (s.key === 'sign') {
      const docChecks = cw.docs.map(d => {
        const isAck = d.consent_kind === 'acknowledged';
        const id = `cw-agree-${d.member_contract_id}`;
        return `<label><input type="checkbox" id="${id}" ${cw.checks[id] ? 'checked' : ''} onchange="HFSContractWizard.onCheck('${id}', this.checked)"> ${esc(docTitle(d))} ${esc(verLabel(d.version))}（${esc(partyLabel(cw.party))}）${isAck ? 'を確認しました' : 'を最後まで読み、内容に同意します'}</label>`;
      }).join('');
      const keyId = 'cw-agree-keypoints';
      return `<div class="cw-panel">
        <h3>内容に同意して署名する</h3>
        <div class="c-checks">
          ${docChecks}
          <label><input type="checkbox" id="${keyId}" ${cw.checks[keyId] ? 'checked' : ''} onchange="HFSContractWizard.onCheck('${keyId}', this.checked)"> 秘密保持、個人情報・機密情報の取扱い、著作権・制作データ・実績公開、請求方法と支払条件に関する条項を確認しました</label>
        </div>
        <div class="form-group" style="margin:14px 0 10px">
          <label class="form-label" for="cw-signer">署名者名（登録氏名「${esc(p.full_name || '')}」と同じ表記で入力） <span style="color:#C0392B">*</span></label>
          <input class="form-input" id="cw-signer" value="${esc(cw.signer || '')}" placeholder="${esc(p.full_name || '')}" autocomplete="off">
        </div>
        <div class="cw-rec"><b>送信すると次の情報が記録されます。</b><br>ユーザーID ／ 署名者名 ／ 契約相手（${esc(partyLabel(cw.party))}）／ 文書の種類と版 ／ 適用開始日 ／ 同意日時（日本時間）／ 接続元IPアドレス ／ ブラウザ情報 ／ 同意した時点の文書データとそのハッシュ値。この記録は後から誰も書き換えられません。</div>
        <div class="c-actions">
          <button class="btn-sm" onclick="HFSContractWizard.go(${cw.step - 1})">◀ 戻る</button>
          <button class="btn-sm" onclick="HFSContractWizard.saveDraftAndClose()">下書き保存して閉じる</button>
          <button class="btn-primary" id="cw-submit" onclick="HFSContractWizard.submit()">同意して送信</button>
        </div>
      </div>`;
    }
    if (s.key === 'done') {
      const rc = cw.receipt;
      const rcDocs = rc && Array.isArray(rc.documents) ? rc.documents : [];
      const first = rcDocs.flatMap(x => x.consents || [])[0] || null;
      const anyActive = cw.docs.some(d => ['active', 'ending'].includes(d.status));
      const mcId = (cw.docs[0] && cw.docs[0].member_contract_id) || (rcDocs[0] && rcDocs[0].member_contract_id);
      return `<div class="cw-panel cw-done">
        <div class="ok">✓</div>
        <h3>${anyActive ? '契約手続きが完了しています' : '同意を受け付けました'}</h3>
        <div class="c-mini">${anyActive ? '契約書PDFと同意記録の控えはいつでもここからダウンロードできます。' : '管理者が確認すると「契約手続き完了」になります。ホームの表示は「確認待ち」に変わります。'}</div>
        <div class="cw-rec">
          <b>同意記録（控え）</b><br>
          同意日時：${esc(fmtDTS((first && first.consented_at) || (rc && rc.submitted_at) || cw.req.submitted_at))} ／ 署名者：${esc((rc && rc.signer_name) || (first && first.signer_name_typed) || cw.req.signer_name || cw.signer || p.full_name || '—')} ／ 契約相手：${esc(partyLabel(cw.party))}<br>
          文書：${cw.docs.map(d => `${esc(docTitle(d))} ${esc(verLabel(d.version))}${d.version && d.version.effective_from ? `（適用 ${esc(fmtD(d.version.effective_from))}〜）` : ''}`).join('、')}<br>
          ${cw.docs.map(d => d.version && d.version.pdf_sha256 ? `文書ハッシュ（SHA-256）：<span class="c-mono">${esc(d.version.pdf_sha256)}</span><br>` : '').join('')}
          ${first && first.record_hash ? `記録ハッシュ：<span class="c-mono">${esc(first.record_hash)}</span><br>` : ''}
          ${mcId ? `記録ID：<span class="c-mono">${esc(mcId)}</span>` : ''}
        </div>
        <div class="actions">
          ${cw.docs.map(d => d.version && d.version.id && d.version.has_pdf !== false ? `<a class="btn" href="${pdfUrl(d.version.id)}" target="_blank" rel="noopener">⬇ ${esc(docTitle(d))} PDF</a>` : '').join('')}
          ${mcId ? `<button class="btn" onclick="HFSContract.printReceipt('${esc(mcId)}')">⬇ 同意記録の控え（PDF）</button>` : ''}
          <button class="btn-sm" onclick="HFSContractWizard.home()">手続き一覧へ</button>
        </div>
      </div>`;
    }
    return '';
  }

  // ───────────────── 操作 ─────────────────
  function go(i) {
    if (!cw) return;
    if (i < 0 || i >= cw.steps.length) return;
    if (!cw.submitted && !stepReachable(i) && i !== cw.step) { toast('前のステップを先に完了してください', 'warn'); return; }
    cw.step = i;
    render();
    saveDraft({ silent: true });
  }

  function readProfileForm(which) {
    const g = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : undefined; };
    const prof = {};
    if (which === 'profile') {
      prof.full_name = g('cw-full-name');
      prof.name_kana = g('cw-name-kana');
      prof.phone = g('cw-phone');
      prof.postal_code = g('cw-postal');
      prof.address = g('cw-address');
      prof.business_type = g('cw-biz');
      prof.trade_name = prof.business_type === 'individual' ? '' : g('cw-trade-name');
      prof.representative_name = prof.business_type === 'individual' ? '' : g('cw-rep-name');
    } else if (which === 'billing') {
      prof.invoice_name = g('cw-invoice-name');
      prof.invoice_registration_number = g('cw-inv-reg');
      const bankForm = document.getElementById('cw-bank-form');
      if (bankForm && bankForm.style.display !== 'none') {
        prof.bank_name = g('cw-bank-name');
        prof.bank_code = g('cw-bank-code');
        prof.branch_name = g('cw-branch-name');
        prof.branch_code = g('cw-branch-code');
        prof.account_type = g('cw-account-type');
        prof.account_number = g('cw-account-number');
        prof.account_holder_kana = g('cw-account-holder');
      }
    }
    Object.keys(prof).forEach(k => { if (prof[k] === undefined) delete prof[k]; });
    return prof;
  }

  function validateProfile(which, prof) {
    if (which === 'profile') {
      if (!prof.full_name) return '氏名を入力してください';
      if (!prof.phone) return '電話番号を入力してください';
      if (!prof.address) return '住所を入力してください';
      if (prof.business_type === 'corporation' && !prof.trade_name) return '法人名を入力してください';
      if (prof.business_type === 'corporation' && !prof.representative_name) return '代表者名を入力してください';
    }
    if (which === 'billing') {
      if (!prof.invoice_name) return '請求名義を入力してください';
      if (prof.invoice_registration_number && !/^T\d{13}$/.test(prof.invoice_registration_number)) return 'インボイス登録番号は T + 13桁の数字で入力してください';
      if ('bank_name' in prof) {
        if (!prof.bank_name) return '銀行名を入力してください';
        if (!prof.branch_name) return '支店名を入力してください';
        if (!prof.account_number) return '口座番号を入力してください';
        if (!/^\d{1,8}$/.test(prof.account_number)) return '口座番号は数字で入力してください';
        if (!prof.account_holder_kana) return '口座名義（カナ）を入力してください';
      }
    }
    return null;
  }

  // PUT /req/:token/draft。profile を渡すと users も更新（サーバー側で PUT /members/:id と同じ検証）
  async function saveDraft(opts) {
    const o = opts || {};
    if (!cw || cw.submitted) return true;
    if (cwSaving) return true;
    cwSaving = true;
    try {
      const body = { draft_state: { step: cw.step, checks: cw.checks, bankChange: cw.bankChange, saved_at: new Date().toISOString() } };
      if (o.profile) body.profile = o.profile;
      const r = await api(`/req/${encodeURIComponent(cw.token)}/draft`, { method: 'PUT', json: body });
      if (!r.ok) { if (!o.silent) toast(r.error, 'error'); return false; }
      if (o.profile) Object.assign(cw.profile, o.profile);
      if (r.data && r.data.profile && typeof r.data.profile === 'object') Object.assign(cw.profile, r.data.profile);
      if (!o.silent) toast('下書きを保存しました', 'success');
      return true;
    } finally { cwSaving = false; }
  }

  async function saveProfile(which) {
    if (!cw) return;
    const prof = readProfileForm(which);
    const err = validateProfile(which, prof);
    if (err) { toast(err, 'warn'); return; }
    const btn = document.querySelector('#cw-main .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    cw.checks[which === 'profile' ? 'profile_ok' : 'billing_ok'] = true;
    if (which === 'billing' && 'account_number' in prof) cw.bankChange = false;
    const ok = await saveDraft({ profile: prof, silent: true });
    if (!ok) { cw.checks[which === 'profile' ? 'profile_ok' : 'billing_ok'] = false; render(); return; }
    // 口座番号は保存後にマスク表示へ戻す
    if ('account_number' in prof) { cw.profile.account_number_masked = maskAccount(prof.account_number); }
    cw.step = Math.min(cw.step + 1, cw.steps.length - 2);
    render();
    saveDraft({ silent: true });
  }

  async function saveDraftOnly() {
    if (!cw) return;
    const s = curStep();
    if (s.key === 'profile' || s.key === 'billing') {
      const prof = readProfileForm(s.key);
      // 下書きは検証を緩める（空欄可）。登録番号だけ形式チェック
      if (prof.invoice_registration_number && !/^T\d{13}$/.test(prof.invoice_registration_number)) { toast('インボイス登録番号は T + 13桁の数字で入力してください', 'warn'); return; }
      Object.keys(prof).forEach(k => { if (prof[k] === '') delete prof[k]; });
      await saveDraft({ profile: prof });
      return;
    }
    await saveDraft({});
  }

  async function saveDraftAndClose() {
    if (!cw) return;
    const el = document.getElementById('cw-signer');
    if (el) cw.signer = el.value.trim();
    const ok = await saveDraft({});
    if (ok) await renderHome();
  }

  function toggleBank(on) {
    if (!cw) return;
    cw.bankChange = !!on;
    render();
  }
  function onBizChange() {
    const v = document.getElementById('cw-biz')?.value;
    const extra = document.getElementById('cw-biz-extra');
    if (extra) extra.style.display = v === 'individual' ? 'none' : '';
    const tn = document.querySelector('label[for="cw-trade-name"]');
    if (tn) tn.textContent = v === 'corporation' ? '法人名' : '屋号';
  }
  function onCheck(id, checked) {
    if (!cw) return;
    cw.checks[id] = !!checked;
    saveDraft({ silent: true });
  }

  // 「最後まで読みました」→ POST /req/:token/viewed
  async function markViewed(memberContractId, cb) {
    if (!cw) return;
    if (!cb.checked) return;
    cb.disabled = true;
    const r = await api(`/req/${encodeURIComponent(cw.token)}/viewed`, { method: 'POST', json: { member_contract_id: memberContractId, completed: true } });
    if (!r.ok) { cb.checked = false; cb.disabled = false; toast(r.error, 'error'); return; }
    const d = cw.docs.find(x => String(x.member_contract_id) === String(memberContractId));
    if (d) d.viewed_completed_at = (r.data && r.data.viewed_completed_at) || new Date().toISOString();
    render();
    saveDraft({ silent: true });
  }

  // POST /req/:token/submit
  async function submit() {
    if (!cw) return;
    const notViewed = cw.docs.filter(d => !isDocViewed(d));
    if (notViewed.length) { toast(`「${docTitle(notViewed[0])}」を最後まで閲覧してください`, 'warn'); go(stepIndex('doc') + cw.docs.indexOf(notViewed[0])); return; }
    const unchecked = cw.docs.filter(d => !document.getElementById(`cw-agree-${d.member_contract_id}`)?.checked);
    if (unchecked.length || !document.getElementById('cw-agree-keypoints')?.checked) { toast('すべての項目にチェックを入れてください', 'warn'); return; }
    const signer = (document.getElementById('cw-signer')?.value || '').trim();
    if (!signer) { toast('署名者名を入力してください', 'warn'); return; }
    cw.signer = signer;
    const ok = typeof window.showConfirmDialog === 'function'
      ? await window.showConfirmDialog({ title: '同意して送信', message: `署名者名「${signer}」で同意を送信します。\n送信後は内容を書き換えられません。よろしいですか？`, okLabel: '送信する' })
      : window.confirm(`署名者名「${signer}」で同意を送信します。よろしいですか？`);
    if (!ok) return;
    const btn = document.getElementById('cw-submit');
    if (btn) { btn.disabled = true; btn.textContent = '送信中…'; }
    const r = await api(`/req/${encodeURIComponent(cw.token)}/submit`, {
      method: 'POST',
      json: { signer_name: signer, agreed_member_contract_ids: cw.docs.map(d => d.member_contract_id) },
    });
    if (!r.ok) {
      toast(r.error, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '同意して送信'; }
      return;
    }
    cw.receipt = (r.data && r.data.receipt) || null;
    if (r.data && r.data.request) cw.req = r.data.request;
    cw.submitted = true;
    cw.docs.forEach(d => { if (['requested', 'revision_requested', 'reconsent_required'].includes(d.status) || !d.status) d.status = 'submitted'; });
    cw.req.status = 'submitted';
    cw.req.submitted_at = new Date().toISOString();
    cw.step = cw.steps.length - 1;
    toast('同意を送信しました。管理者の確認をお待ちください', 'success');
    render();
    try { renderContractBanner(); } catch (_) {}
  }

  function home() {
    cw = null;
    renderHome();
  }

  window.HFSContractWizard = {
    open: openRequest, home, go, saveProfile, saveDraftOnly, saveDraftAndClose, toggleBank, onBizChange, onCheck, markViewed, submit,
  };
  window.loadContractPage = loadContractPage;

  // ───────────────── ホームバナー ─────────────────
  // GET /me の banner: { kind: 'requested'|'revision'|'reconsent'|null, request_id }
  async function renderContractBanner() {
    const box = document.getElementById('dash-contract-banner');
    if (!box) return;
    const r = await api('/me');
    if (!r.ok) { box.innerHTML = ''; return; } // 準備中・エラーは静かに非表示
    const me = r.data || {};
    const b = me.banner;
    if (!b || !b.kind) { box.innerHTML = ''; return; }
    const requests = Array.isArray(me.requests) ? me.requests : [];
    const contracts = Array.isArray(me.contracts) ? me.contracts : [];
    const req = requests.find(q => String(q.id) === String(b.request_id)) || requests.find(q => q.status === 'open') || null;
    const n = me.pending_count || requests.filter(q => q.status === 'open').length || 1;
    const docs = req ? contracts.filter(c => String(c.request_id) === String(req.id)).map(c => `${docTitle(c)} ${verLabel(c.version)}`.trim()).join('・') : '';
    const due = req && req.due_date ? `回答期限 ${fmtD(req.due_date)}` : '';
    const texts = {
      requested: { title: `契約・登録手続きのお願いが${n}件あります`, btn: '手続きを始める', cls: '' },
      revision: { title: '契約手続きに修正依頼があります', btn: '内容を確認する', cls: 'revision' },
      reconsent: { title: '契約書が改訂されました。再同意をお願いします', btn: '新しい版を確認する', cls: 'reconsent' },
    };
    const t = texts[b.kind] || texts.requested;
    const token = req && req.token && req.status === 'open' ? req.token : '';
    box.innerHTML = `<div class="c-banner ${t.cls}">
      <span class="ic">📝</span>
      <div class="tx"><b>${esc(t.title)}</b><div class="c-mini">${esc([docs, due].filter(Boolean).join(' ／ ') || '「契約・登録手続き」から進めてください')}</div></div>
      <button class="btn-primary" style="font-size:13px;padding:8px 16px" onclick="HFSContractWizard.fromBanner('${esc(token)}')">${esc(t.btn)} ▶</button>
    </div>`;
  }
  function fromBanner(token) {
    window._contractReqToken = token || null;
    if (typeof window.showPage === 'function') window.showPage('contract', navBtnFor('contract'));
  }
  window.HFSContractWizard.fromBanner = fromBanner;
  window.renderContractBanner = renderContractBanner;

})(window, document);

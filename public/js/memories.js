/* ============================================================
 * memories.js — 🎞 思い出アルバム（#page-memories）
 *   ADR 052（docs/design/decisions/052-memories-album-drive.md）。
 *
 *   公開 API（window）:
 *     loadMemoriesPage()   ページ入口（showPage('memories') から呼ぶ）
 *
 *   保存先は Google Drive（アルバム名/投稿者名/元のファイル名）。アップロードは haruka.html の
 *   Drive 直送コア driveUploadToSession()（受領位置再開・停止検知・チャンク縮小つき）を使う。
 *   API は haruka.html の apiFetch() 経由。時刻表示はすべて JST。
 * ============================================================ */
(function (window, document) {
  'use strict';

  const BASE = '/api/haruka/memories';
  const JST = 'Asia/Tokyo';
  const PARALLEL = 2;                       // 同時に送るファイル数（スマホ回線でも詰まらない程度）
  const CHUNK_BYTES = 8 * 1024 * 1024;      // 初期チャンク（失敗時はコア側で半減）
  const ALBUM_LS_KEY = 'hfs_memories_album';

  const state = {
    albums: [],
    albumId: null,
    canCreate: false,
    maxBytes: 10 * 1024 * 1024 * 1024,
    items: [],
    uploaders: [],
    me: null,
    canDeleteAny: false,
    filterFolder: '',      // '' = 全員
    filterKind: '',        // '' | 'image' | 'video'
    queue: [],             // { file, status: 'wait'|'up'|'done'|'error', done, msg }
    running: 0,
    cancelled: false,
    lbIndex: -1,
    inited: false,
  };

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
    if (!res.ok) throw new Error((data && data.error) || `通信に失敗しました (${res.status})`);
    return data;
  }
  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB';
    return Math.max(1, Math.round(n / 1024)) + 'KB';
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms)) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtDayTitle(key) {
    if (!key) return '日付不明';
    const d = new Date(`${key}T12:00:00+09:00`);
    return d.toLocaleDateString('ja-JP', { timeZone: JST, month: 'long', day: 'numeric', weekday: 'short' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ja-JP', { timeZone: JST, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function isMemoryFile(f) {
    if (/^(image|video)\//.test(f.type || '')) return true;
    return /\.(jpe?g|png|heic|heif|gif|webp|dng|tiff?|bmp|mov|mp4|m4v|3gp|avi|mts|m2ts|mkv|webm|hevc)$/i.test(f.name || '');
  }
  function thumbUrl(id, s) { return `${BASE}/items/${encodeURIComponent(id)}/thumb?s=${s || 400}`; }

  // ───────────────── 画面の骨組み ─────────────────
  function renderShell() {
    const page = $('page-memories');
    if (!page || state.inited) return;
    state.inited = true;
    page.innerHTML = `
      <div class="mem-wrap">
        <div class="mem-head">
          <h2>🎞 思い出アルバム</h2>
          <div class="mem-head-actions">
            <select id="mem-album" class="mem-album-select" aria-label="アルバムを選ぶ"></select>
            <a id="mem-open-drive" class="btn-sm" target="_blank" rel="noopener" title="Google ドライブでフォルダごと開く（まとめてダウンロードもここから）">📂 Driveで開く</a>
            <button type="button" id="mem-new-album" class="btn-sm" style="display:none">＋ アルバム</button>
          </div>
        </div>
        <label class="mem-drop" id="mem-drop">
          <input type="file" id="mem-file" multiple accept="image/*,video/*">
          <span class="mem-drop-main">📷 写真・動画を追加する</span>
          <span class="mem-drop-sub">まとめて選べます（PC はここへドラッグ＆ドロップも OK）／動画も容量を気にせず入れられます</span>
        </label>
        <div class="mem-queue" id="mem-queue" style="display:none"></div>
        <div class="mem-filters" id="mem-filters"></div>
        <div id="mem-list"><div class="mem-empty">読み込み中…</div></div>
      </div>
      <div class="mem-lb" id="mem-lb" role="dialog" aria-modal="true" aria-label="写真・動画を見る">
        <div class="mem-lb-top">
          <div class="mem-lb-info"><div id="mem-lb-name"></div><div class="mem-lb-sub" id="mem-lb-sub"></div></div>
          <a class="mem-lb-btn" id="mem-lb-dl" target="_blank" rel="noopener">⬇ 保存</a>
          <a class="mem-lb-btn" id="mem-lb-drive" target="_blank" rel="noopener">Driveで開く</a>
          <button type="button" class="mem-lb-btn" id="mem-lb-del" style="display:none">🗑 削除</button>
          <button type="button" class="mem-lb-btn" id="mem-lb-close" aria-label="閉じる">✕</button>
        </div>
        <div class="mem-lb-stage" id="mem-lb-stage"></div>
      </div>`;

    $('mem-album').addEventListener('change', (e) => {
      state.albumId = e.target.value;
      try { localStorage.setItem(ALBUM_LS_KEY, state.albumId); } catch (_) {}
      state.filterFolder = '';
      syncDriveLink();
      loadItems();
    });
    $('mem-new-album').addEventListener('click', createAlbum);
    $('mem-file').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });

    const drop = $('mem-drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer && e.dataTransfer.files));

    $('mem-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      if (b.dataset.filter === 'kind') state.filterKind = b.dataset.value;
      else state.filterFolder = b.dataset.value;
      renderFilters();
      renderList();
    });
    $('mem-list').addEventListener('click', (e) => {
      const t = e.target.closest('[data-idx]');
      if (t) openLightbox(Number(t.dataset.idx));
    });
    $('mem-list').addEventListener('error', (e) => {
      // サムネがまだ無い（Drive が作成中の動画など）→ アイコン表示に切り替え
      const img = e.target;
      if (img.tagName !== 'IMG') return;
      const tile = img.closest('.mem-tile');
      img.remove();
      if (tile && !tile.querySelector('.mem-tile-ph')) {
        tile.insertAdjacentHTML('afterbegin', `<span class="mem-tile-ph">${tile.dataset.kind === 'video' ? '🎬' : '🖼'}<small>${esc(tile.dataset.name)}</small></span>`);
      }
    }, true);

    $('mem-lb-close').addEventListener('click', closeLightbox);
    $('mem-lb-del').addEventListener('click', trashCurrent);
    $('mem-lb').addEventListener('click', (e) => {
      if (e.target.id === 'mem-lb-stage') closeLightbox();
      const nav = e.target.closest('[data-nav]');
      if (nav) stepLightbox(Number(nav.dataset.nav));
    });
    document.addEventListener('keydown', (e) => {
      if (!$('mem-lb') || !$('mem-lb').classList.contains('is-open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    });
    // スマホは左右スワイプで前後へ
    let touchX = null;
    $('mem-lb-stage').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    $('mem-lb-stage').addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    });

    window.addEventListener('beforeunload', (e) => {
      if (state.running > 0 || state.queue.some((q) => q.status === 'wait')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ───────────────── アルバム ─────────────────
  async function loadAlbums() {
    const data = await api('/albums');
    state.albums = data.albums || [];
    state.canCreate = !!data.can_create;
    state.maxBytes = Number(data.max_file_bytes) || state.maxBytes;
    let saved = null;
    try { saved = localStorage.getItem(ALBUM_LS_KEY); } catch (_) {}
    if (!state.albums.some((a) => a.id === state.albumId)) {
      state.albumId = state.albums.some((a) => a.id === saved) ? saved : (state.albums[0] && state.albums[0].id);
    }
    $('mem-album').innerHTML = state.albums.map((a) => `<option value="${esc(a.id)}"${a.id === state.albumId ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    $('mem-new-album').style.display = state.canCreate ? '' : 'none';
    syncDriveLink();
  }
  function syncDriveLink() {
    const a = state.albums.find((x) => x.id === state.albumId);
    const link = $('mem-open-drive');
    if (a) { link.href = a.folder_url; link.style.display = ''; } else { link.style.display = 'none'; }
  }
  async function createAlbum() {
    const name = prompt('新しいアルバムの名前（例: 2027 忘年会）');
    if (!name || !name.trim()) return;
    try {
      const { album } = await postJson('/albums', { name: name.trim() });
      state.albumId = album.id;
      try { localStorage.setItem(ALBUM_LS_KEY, album.id); } catch (_) {}
      await loadAlbums();
      await loadItems();
      toast(`アルバム「${album.name}」を作りました`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ───────────────── 一覧 ─────────────────
  async function loadItems(fresh) {
    if (!state.albumId) {
      $('mem-list').innerHTML = '<div class="mem-empty">アルバムがありません</div>';
      return;
    }
    try {
      const data = await api(`/albums/${encodeURIComponent(state.albumId)}/items${fresh ? '?fresh=1' : ''}`);
      state.items = data.items || [];
      state.uploaders = data.uploaders || [];
      state.me = data.me;
      state.canDeleteAny = !!data.can_delete_any;
      if (state.filterFolder && !state.uploaders.some((u) => u.folder_id === state.filterFolder)) state.filterFolder = '';
      renderFilters();
      renderList();
    } catch (e) {
      $('mem-list').innerHTML = `<div class="mem-empty">読み込めませんでした：${esc(e.message)}</div>`;
    }
  }

  function filteredItems() {
    return state.items.filter((it) =>
      (!state.filterFolder || it.folder_id === state.filterFolder) &&
      (!state.filterKind || it.kind === state.filterKind));
  }

  function renderFilters() {
    const box = $('mem-filters');
    if (!state.items.length) { box.innerHTML = ''; return; }
    const nImg = state.items.filter((i) => i.kind === 'image').length;
    const nVid = state.items.length - nImg;
    const chip = (type, value, label, n, active) =>
      `<button type="button" class="mem-chip${active ? ' is-active' : ''}" data-filter="${type}" data-value="${esc(value)}">${label}<span class="mem-chip-n">${n}</span></button>`;
    box.innerHTML = [
      chip('who', '', '👥 みんな', state.items.length, !state.filterFolder),
      ...state.uploaders.map((u) => chip('who', u.folder_id || '', esc(u.uploader_name || '（フォルダ直下）'), u.count, state.filterFolder === u.folder_id)),
      '<span style="flex-basis:100%;height:0"></span>',
      chip('kind', '', 'すべて', state.items.length, !state.filterKind),
      chip('kind', 'image', '📷 写真', nImg, state.filterKind === 'image'),
      chip('kind', 'video', '🎬 動画', nVid, state.filterKind === 'video'),
    ].join('');
  }

  function renderList() {
    const list = $('mem-list');
    const items = filteredItems();
    if (!state.items.length) {
      list.innerHTML = '<div class="mem-empty">まだ写真・動画がありません。<br>上の「📷 写真・動画を追加する」から最初の1枚をどうぞ！</div>';
      return;
    }
    if (!items.length) { list.innerHTML = '<div class="mem-empty">条件に合う写真・動画はありません</div>'; return; }
    const groups = [];
    items.forEach((it, idx) => {
      const last = groups[groups.length - 1];
      if (last && last.key === it.date_key) last.rows.push({ it, idx });
      else groups.push({ key: it.date_key, rows: [{ it, idx }] });
    });
    list.innerHTML = groups.map((g) => `
      <section class="mem-day">
        <h3 class="mem-day-title">${esc(fmtDayTitle(g.key))}<small>${g.rows.length}件</small></h3>
        <div class="mem-grid">${g.rows.map(({ it, idx }) => tileHtml(it, idx)).join('')}</div>
      </section>`).join('');
  }

  function tileHtml(it, idx) {
    const media = it.has_thumb
      ? `<img loading="lazy" src="${thumbUrl(it.id, 400)}" alt="">`
      : `<span class="mem-tile-ph">${it.kind === 'video' ? '🎬' : '🖼'}<small>${esc(it.name)}</small></span>`;
    const badge = it.kind === 'video' ? `<span class="mem-tile-badge">▶ ${esc(fmtDuration(it.duration_ms))}</span>` : '';
    return `<button type="button" class="mem-tile" data-idx="${idx}" data-kind="${it.kind}" data-name="${esc(it.name)}" title="${esc(it.name)}">${media}${badge}<span class="mem-tile-who">${esc(it.uploader_name || '')}</span></button>`;
  }

  // ───────────────── ライトボックス ─────────────────
  function openLightbox(idx) {
    const items = filteredItems();
    if (!items[idx]) return;
    state.lbIndex = idx;
    const it = items[idx];
    $('mem-lb-name').textContent = it.name;
    $('mem-lb-sub').textContent = [it.uploader_name, fmtDateTime(it.taken_at), fmtBytes(it.size)].filter(Boolean).join(' ・ ');
    $('mem-lb-dl').href = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(it.id)}&confirm=t`;
    $('mem-lb-drive').href = `https://drive.google.com/file/d/${encodeURIComponent(it.id)}/view`;
    $('mem-lb-del').style.display = (it.uploader_id === state.me || state.canDeleteAny) ? '' : 'none';
    const stage = $('mem-lb-stage');
    const nav = `${idx > 0 ? '<button type="button" class="mem-lb-nav mem-lb-prev" data-nav="-1" aria-label="前へ">‹</button>' : ''}${idx < items.length - 1 ? '<button type="button" class="mem-lb-nav mem-lb-next" data-nav="1" aria-label="次へ">›</button>' : ''}`;
    if (it.kind === 'video') {
      // 再生は Drive のプレーヤー（アップ直後は Drive 側の処理が終わるまで「処理中」と出ることがある）
      stage.innerHTML = `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(it.id)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>${nav}`;
    } else {
      stage.innerHTML = `<img src="${thumbUrl(it.id, 2000)}" alt="${esc(it.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{style:'color:#fff;font-size:13px;text-align:center',textContent:'プレビューを準備中です。「Driveで開く」から見られます'}))">${nav}`;
    }
    $('mem-lb').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function stepLightbox(d) {
    const next = state.lbIndex + d;
    if (next >= 0 && next < filteredItems().length) openLightbox(next);
  }
  function closeLightbox() {
    $('mem-lb').classList.remove('is-open');
    $('mem-lb-stage').innerHTML = '';
    document.body.style.overflow = '';
    state.lbIndex = -1;
  }
  async function trashCurrent() {
    const it = filteredItems()[state.lbIndex];
    if (!it) return;
    const msg = `「${it.name}」を削除しますか？（Drive のゴミ箱に移ります）`;
    const ok = typeof window.showConfirmDialog === 'function' ? await window.showConfirmDialog(msg) : confirm(msg);
    if (!ok) return;
    try {
      await postJson(`/items/${encodeURIComponent(it.id)}/trash`, {});
      closeLightbox();
      toast('削除しました', 'success');
      await loadItems(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ───────────────── アップロード ─────────────────
  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!state.albumId) { toast('アルバムがありません', 'error'); return; }
    let skipped = 0;
    for (const file of files) {
      if (!isMemoryFile(file)) { skipped++; continue; }
      if (file.size > state.maxBytes) {
        state.queue.push({ file, status: 'error', done: 0, msg: '10GB を超えるため入れられません' });
        continue;
      }
      state.queue.push({ file, albumId: state.albumId, status: 'wait', done: 0, msg: '' });
    }
    if (skipped) toast(`写真・動画以外の ${skipped} 件はスキップしました`, 'info');
    state.cancelled = false;
    renderQueue();
    pump();
  }

  function pump() {
    while (state.running < PARALLEL && !state.cancelled) {
      const job = state.queue.find((q) => q.status === 'wait');
      if (!job) break;
      state.running++;
      job.status = 'up';
      uploadOne(job)
        .then(() => { job.status = 'done'; job.done = job.file.size; })
        .catch((e) => {
          job.status = 'error';
          job.msg = (e && e.__cancelled) ? 'キャンセルしました'
            : (typeof window.driveUploadFailureMessage === 'function' ? window.driveUploadFailureMessage(e) : (e.message || String(e)));
          if (typeof window.driveReportUploadFailure === 'function') window.driveReportUploadFailure('memories', job.file, e);
        })
        .finally(() => {
          state.running--;
          renderQueue();
          if (state.running === 0 && !state.queue.some((q) => q.status === 'wait')) onBatchFinished();
          else pump();
        });
    }
    renderQueue();
  }

  async function uploadOne(job) {
    const f = job.file;
    const { sessionUrl } = await postJson(`/albums/${encodeURIComponent(job.albumId)}/upload-session`, {
      filename: f.name,
      fileSize: f.size,
      mimeType: f.type || '',
      lastModified: f.lastModified || null,
    });
    const { driveFileId } = await window.driveUploadToSession({
      file: f,
      sessionUrl,
      chunkBytes: CHUNK_BYTES,
      onProgress: (done) => { job.done = done; job.msg = ''; scheduleQueueRender(); },
      onStatus: (msg) => { job.msg = msg; scheduleQueueRender(); },
      shouldAbort: () => state.cancelled,
      onXhrReady: () => {},
      onChunkCommitted: () => { job.msg = ''; },
    });
    await postJson(`/albums/${encodeURIComponent(job.albumId)}/upload-complete`, { driveFileId });
  }

  let _qTimer = null;
  function scheduleQueueRender() {
    if (_qTimer) return;
    _qTimer = setTimeout(() => { _qTimer = null; renderQueue(); }, 250);
  }

  function renderQueue() {
    const box = $('mem-queue');
    if (!box) return;
    if (!state.queue.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const total = state.queue.reduce((s, q) => s + q.file.size, 0);
    const done = state.queue.reduce((s, q) => s + (q.status === 'done' ? q.file.size : Math.min(q.done || 0, q.file.size)), 0);
    const nDone = state.queue.filter((q) => q.status === 'done').length;
    const nErr = state.queue.filter((q) => q.status === 'error').length;
    const busy = state.running > 0 || state.queue.some((q) => q.status === 'wait');
    const pct = total ? Math.round((done / total) * 100) : 0;
    const stateText = (q) => {
      if (q.status === 'done') return '✅ 完了';
      if (q.status === 'error') return `⚠️ ${esc(q.msg)}`;
      if (q.status === 'wait') return '待機中';
      return q.msg ? esc(q.msg) : `${Math.round(((q.done || 0) / q.file.size) * 100)}%`;
    };
    box.style.display = '';
    box.innerHTML = `
      <div class="mem-queue-head">
        <span>${busy ? '⏫ アップロード中' : '✅ アップロード完了'}　${nDone}/${state.queue.length} 件${nErr ? `（失敗 ${nErr} 件）` : ''}</span>
        <span class="mem-queue-actions">
          ${nErr && !busy ? '<button type="button" class="btn-sm" data-q="retry">失敗分をやり直す</button>' : ''}
          ${busy ? '<button type="button" class="btn-sm" data-q="cancel">中止</button>' : '<button type="button" class="btn-sm" data-q="clear">閉じる</button>'}
        </span>
      </div>
      ${busy ? '<div class="mem-queue-note">終わるまでこの画面を開いたままにしてください（スマホは画面ロック・アプリ切り替えで止まります）</div>' : ''}
      <div class="mem-queue-bar"><span style="width:${pct}%"></span></div>
      <div class="mem-queue-list">${state.queue.map((q) => `
        <div class="mem-queue-row is-${q.status}">
          <span class="mem-queue-name">${esc(q.file.name)}</span>
          <span class="mem-queue-state">${fmtBytes(q.file.size)}　${stateText(q)}</span>
        </div>`).join('')}</div>`;
    box.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.q;
      if (act === 'cancel') { state.cancelled = true; state.queue.forEach((q) => { if (q.status === 'wait') { q.status = 'error'; q.msg = 'キャンセルしました'; } }); renderQueue(); }
      if (act === 'clear') { state.queue = []; renderQueue(); }
      if (act === 'retry') {
        state.cancelled = false;
        state.queue.forEach((q) => { if (q.status === 'error' && q.albumId) { q.status = 'wait'; q.done = 0; q.msg = ''; } });
        pump();
      }
    }));
  }

  function onBatchFinished() {
    const nDone = state.queue.filter((q) => q.status === 'done').length;
    const nErr = state.queue.filter((q) => q.status === 'error').length;
    if (nDone) toast(`${nDone} 件をアルバムに追加しました${nErr ? `（${nErr} 件は失敗）` : ''}`, nErr ? 'info' : 'success');
    loadItems(true);
  }

  // ───────────────── 入口 ─────────────────
  async function loadMemoriesPage() {
    renderShell();
    try {
      await loadAlbums();
      await loadItems();
    } catch (e) {
      $('mem-list').innerHTML = `<div class="mem-empty">読み込めませんでした：${esc(e.message)}</div>`;
    }
  }

  window.loadMemoriesPage = loadMemoriesPage;
})(window, document);

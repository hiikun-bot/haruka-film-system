// public/js/creative-preview-longpage.js
//
// HP / LP 用「縦長キャプチャ」レンダラ。
//
// 設計:
//   - 既存の画像レビュー（fp-image-stage / fp-image-overlay / bbox JSONB）基盤を流用。
//   - 1 クリエイティブに複数枚（複数ページ）の縦長 PNG/JPEG が紐付くケースに対応。
//     creative.files[] が無い場合は単一画像（driveFileId）扱いで落ちないようにする。
//   - 画像高さが大きいので、stage 自体は overflow:auto で縦スクロール可能にする。
//     既存の zoom/pan は image renderer と同じ流儀（fpInitImageZoom）で動かしたい
//     ところだが、HP/LP のレビューでは「自然な縦スクロール + セクション別範囲選択コメント」
//     のほうが UX が高いため、ここでは zoom 制御を簡略化（bbox オーバーレイのみ動作）。
//   - bbox は既存 schema (creative_files.bbox JSONB) をそのまま使い、
//     fpInitImageBboxOverlay を流用する（=画像レビューと同じ操作感）。
//
// 公開: register 自身は creative-preview-renderer.js に対して
//        registerCreativePreviewRenderer('longpage', renderLongpagePreview) を呼ぶ。
//        外から呼びたい場合は window.renderLongpagePreview(creative, ctx) も提供。
//
// 注意:
//   - haruka.html の fp* グローバル（fpInitImageBboxOverlay / fpHideLoading 等）に依存する。
//     creative-preview-renderer.js 同様、haruka.html の <script> より前に読み込んでも
//     register は同期的に登録されるだけなので問題ない（実際の呼び出しは preview を開いたとき）。
(function () {
  'use strict';

  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // 複数ページ画像を取り出す。
  //   - creative.files[] : { id, drive_file_id, generated_name, ... } 形式（haruka.js POST /creatives/:id/upload 後）
  //   - 無ければ ctx.driveFileId を 1 枚だけ
  function _collectPages(creative, ctx) {
    const list = [];
    const files = Array.isArray(creative?.files) ? creative.files
                : Array.isArray(creative?.creative_files) ? creative.creative_files
                : [];
    files.forEach(f => {
      const id = f.drive_file_id || f.driveFileId || f.id || null;
      if (!id) return;
      // 画像っぽい拡張子だけを縦並べ対象に。動画は混ざらない前提。
      const fn = f.generated_name || f.file_name || '';
      if (fn && !/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(fn)) return;
      list.push({ driveFileId: f.drive_file_id || null, name: fn || '' , id: f.id || null });
    });
    if (list.length === 0 && ctx?.driveFileId) {
      list.push({ driveFileId: ctx.driveFileId, name: ctx.filename || '', id: ctx.fileRecordId || null });
    }
    return list;
  }

  function renderLongpagePreview(creative, ctx) {
    const dom = ctx?.dom || {};
    const player = dom.player || document.getElementById('fp-player');
    const ctrlBar = dom.ctrlBar || document.getElementById('fp-controls-bar');
    if (!player) return false;

    if (ctrlBar) ctrlBar.style.display = 'none';
    if (typeof window.fpShowLoading === 'function') window.fpShowLoading('縦長キャプチャを読み込み中...');

    const pages = _collectPages(creative, ctx);
    if (pages.length === 0) {
      player.innerHTML = `
        <div style="color:#71717a;font-size:13px;text-align:center;padding:40px">
          <div style="font-size:48px;margin-bottom:16px">📄</div>
          <div style="margin-bottom:8px;color:#a1a1aa">表示できる縦長キャプチャがありません</div>
          <div style="font-size:11px;color:#52525b">PNG/JPEG の縦長スクリーンショットをアップロードするとここに表示されます</div>
        </div>`;
      if (typeof window.fpHideLoading === 'function') window.fpHideLoading();
      return true;
    }

    // 縦スクロール可能なステージ（画像レビューと共存させるため fp-image-* の id をそのまま使う）。
    // 縦に複数 <img> を並べ、bbox オーバーレイ層は最上位に被せる。
    // 画像 1 枚のときは画像レビューと同じ DOM 構造（fp-image-stage / fp-image-transform / fp-image / fp-image-overlay）
    // を維持し、fpInitImageBboxOverlay / fpInitImageZoom を流用する。
    const API = window.API || '/api';
    if (pages.length === 1) {
      const p = pages[0];
      player.innerHTML = `
        <div id="fp-image-stage" style="position:relative;width:100%;height:100%;overflow:auto;cursor:crosshair;touch-action:pan-y">
          <div id="fp-image-transform" style="position:relative;left:0;top:0;transform-origin:0 0;will-change:transform">
            <img id="fp-image" src="${API}/files/${p.driveFileId}/stream" style="display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;pointer-events:none" draggable="false" onload="if(typeof fpOnImageLoaded==='function')fpOnImageLoaded()" onerror="if(typeof fpShowLoadingError==='function')fpShowLoadingError('画像の読み込みに失敗しました')">
            <div id="fp-image-overlay" style="position:absolute;left:0;top:0;width:0;height:0;pointer-events:auto"></div>
          </div>
        </div>`;
      setTimeout(() => {
        try { if (typeof window.fpInitImageBboxOverlay === 'function') window.fpInitImageBboxOverlay(); } catch (_) {}
        // longpage は zoom/pan より素直な縦スクロールを優先。zoom 初期化はスキップ。
      }, 50);
      return true;
    }

    // 複数ページ: 縦に並べる
    // bbox は「アクティブな1枚」を fp-image-overlay でハンドルする運用。
    // 簡素化のため、ページごとに img + 個別 overlay を持たせ、
    // クリック対象ページの overlay を fp-image-overlay として再バインドする。
    const html = pages.map((p, i) => `
      <div class="fp-longpage-page" data-page-index="${i}" data-file-id="${_esc(p.id || '')}" style="position:relative;border-bottom:1px solid #27272a">
        <img class="fp-longpage-img" src="${API}/files/${p.driveFileId}/stream"
             style="display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;pointer-events:none"
             draggable="false"
             alt="${_esc(p.name)}">
        <div class="fp-longpage-overlay" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto"></div>
      </div>
    `).join('');

    player.innerHTML = `
      <div id="fp-image-stage" style="position:relative;width:100%;height:100%;overflow:auto;cursor:crosshair;touch-action:pan-y;background:#0a0a0a">
        <div id="fp-image-transform" style="position:relative;left:0;top:0;transform-origin:0 0">
          <div id="fp-longpage-pages">${html}</div>
          <!-- 画像レビューと共通の overlay slot（アクティブページが入れ替わるとここを差し替える） -->
          <div id="fp-image-overlay" style="position:absolute;left:0;top:0;width:0;height:0;pointer-events:none"></div>
          <!-- ダミー img（fp-image-* を期待する既存 fpInitImageBboxOverlay 互換のため非表示で置く） -->
          <img id="fp-image" alt="" style="display:none">
        </div>
      </div>`;

    // 画像読み込み完了でローディング解除（先頭画像基準で十分）
    const firstImg = player.querySelector('.fp-longpage-img');
    if (firstImg) {
      firstImg.addEventListener('load', () => {
        if (typeof window.fpHideLoading === 'function') window.fpHideLoading();
      }, { once: true });
      firstImg.addEventListener('error', () => {
        if (typeof window.fpShowLoadingError === 'function') window.fpShowLoadingError('画像の読み込みに失敗しました');
      }, { once: true });
    } else {
      if (typeof window.fpHideLoading === 'function') window.fpHideLoading();
    }
    return true;
  }

  window.renderLongpagePreview = renderLongpagePreview;

  if (typeof window.registerCreativePreviewRenderer === 'function') {
    window.registerCreativePreviewRenderer('longpage', renderLongpagePreview);
  } else {
    // creative-preview-renderer.js が後で読み込まれるケースに備えて遅延登録
    document.addEventListener('DOMContentLoaded', () => {
      if (typeof window.registerCreativePreviewRenderer === 'function') {
        window.registerCreativePreviewRenderer('longpage', renderLongpagePreview);
      }
    });
  }
})();

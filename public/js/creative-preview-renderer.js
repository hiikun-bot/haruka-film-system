// public/js/creative-preview-renderer.js
//
// クリエイティブのレビュー画面プレビューを「カテゴリの render_kind」で
// 切替えるための薄い抽象化レイヤ。
//
// 既存実装（haruka.html の openFilePreview 内インライン）を、
// render_kind ごとの renderer 関数に分解して呼び出す。
//
// 設計思想（プラン /Users/takahashi_satoru/.claude/plans/hp-lp-line-enumerated-walrus.md より）:
//   「カテゴリ追加時にコード改修ゼロ」を担保するため、種別判定は
//   creative.category.render_kind だけを見て分岐する。creative_type の prefix 判定や
//   ファイル拡張子による分岐は、ここに到達する前のフォールバック専用。
//
// 公開関数:
//   - renderCreativePreview(creative, ctx) :
//       カテゴリ駆動でレンダラを選択する玄関口。openFilePreview() から呼ぶ。
//       戻り値: { kind, handled }  handled=true ならインラインHTMLは触らない。
//   - resolveRenderKind(creative) :
//       category.render_kind / category_id → render_kind を解決。
//       カテゴリ未設定の古いレコードはファイル拡張子で video/image/iframe にフォールバック。
//   - registerCreativePreviewRenderer(kind, fn) :
//       将来の拡張用。新しい render_kind を追加するときに使う。
//
// 注意: このファイルは haruka.html の <script> 群より前に読み込まれることを想定。
//       window.openFilePreview / window.fp* / API などは haruka.html 側のグローバル参照を使う。
(function () {
  'use strict';

  // ==== レンダラ登録テーブル ====
  // それぞれ ctx = { driveFileId, filename, driveUrl, fileRecordId, creativeType, assigneeRole, dom: { player, ctrlBar, diagnoseArea } }
  // 戻り値:
  //   true  → このレンダラがプレビュー DOM を構築済（呼び出し元はインライン処理を行わない）
  //   false → 何もしなかった（呼び出し元の既存処理にフォールバック）
  const renderers = Object.create(null);

  function registerCreativePreviewRenderer(kind, fn) {
    if (typeof kind !== 'string' || typeof fn !== 'function') return;
    renderers[kind] = fn;
  }

  // 既存ファイル拡張子フォールバック（カテゴリ未設定の古いレコード用）
  function _kindByFilename(filename) {
    if (!filename) return null;
    if (/\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(filename)) return 'video';
    if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(filename)) return 'image';
    if (/\.pdf$/i.test(filename)) return 'pdf';
    return null;
  }

  // creative → render_kind を解決
  // 1) creative.category.render_kind（GET /creatives で埋め込み済）
  // 2) creative.category_id → window.getCategory(id) のキャッシュから
  // 3) ファイル拡張子フォールバック
  // 4) 'iframe'（最終フォールバック=Drive iframe）
  function resolveRenderKind(creative, filename) {
    if (creative && creative.category && creative.category.render_kind) {
      return creative.category.render_kind;
    }
    if (creative && creative.category_id && typeof window.getCategory === 'function') {
      const cat = window.getCategory(creative.category_id);
      if (cat && cat.render_kind) return cat.render_kind;
    }
    const byName = _kindByFilename(filename);
    if (byName) return byName;
    return 'iframe';
  }

  // 玄関口: openFilePreview から呼ぶ
  // - dom: { player, ctrlBar, diagnoseArea } を渡す
  // - 既存 renderer が登録されていなければ false を返す
  function renderCreativePreview(creative, ctx) {
    const kind = resolveRenderKind(creative, ctx?.filename);
    const fn = renderers[kind];
    if (!fn) return { kind, handled: false };
    let handled = false;
    try {
      handled = !!fn(creative, ctx);
    } catch (e) {
      try { console.error('[creative-preview-renderer]', kind, e); } catch (_) {}
      handled = false;
    }
    return { kind, handled };
  }

  // 公開
  window.renderCreativePreview = renderCreativePreview;
  window.resolveRenderKind = resolveRenderKind;
  window.registerCreativePreviewRenderer = registerCreativePreviewRenderer;

  // ==================================================================
  // longpage 以外の renderer は haruka.html 側の既存実装を流用するため、
  // ここでは「フック登録のみ」行う薄いブリッジを定義する。
  // 実際の DOM 構築は haruka.html の openFilePreview() 内で従来通り行うが、
  // 「カテゴリ駆動」の橋渡しとしてこの抽象化を経由する形に統一する。
  // ==================================================================

  // video / image / iframe / pdf : 既存処理を呼ぶブリッジ
  registerCreativePreviewRenderer('video', function (creative, ctx) {
    if (typeof window._fpRenderVideoInline === 'function') {
      return !!window._fpRenderVideoInline(creative, ctx);
    }
    return false;
  });
  registerCreativePreviewRenderer('image', function (creative, ctx) {
    if (typeof window._fpRenderImageInline === 'function') {
      return !!window._fpRenderImageInline(creative, ctx);
    }
    return false;
  });
  registerCreativePreviewRenderer('iframe', function (creative, ctx) {
    if (typeof window._fpRenderIframeInline === 'function') {
      return !!window._fpRenderIframeInline(creative, ctx);
    }
    return false;
  });
  registerCreativePreviewRenderer('pdf', function (creative, ctx) {
    // pdf も Drive iframe で十分（plan/`render_kind` 対応表より）
    if (typeof window._fpRenderIframeInline === 'function') {
      return !!window._fpRenderIframeInline(creative, ctx);
    }
    return false;
  });

  // longpage は creative-preview-longpage.js が registerCreativePreviewRenderer('longpage', ...) を呼ぶ
})();

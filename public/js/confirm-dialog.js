/* ============================================================
 * confirm-dialog.js
 *   ブラウザネイティブ window.confirm() の代替となる、
 *   画面中央表示のカスタム確認モーダル。
 *
 * 使い方:
 *   const ok = await showConfirmDialog({
 *     title:    'ステータスを進める',         // 任意（省略時は「確認」）
 *     message:  '『制作中』に進めますか？',     // 必須（\n で改行可能）
 *     okLabel:  '進める',                     // 任意（省略時は「OK」）
 *     cancelLabel: 'キャンセル',              // 任意（省略時は「キャンセル」）
 *     okVariant: 'primary' | 'danger' | 'success', // 任意（省略時は 'primary'）
 *   });
 *   if (!ok) return;
 *
 * 後方互換: 文字列 1 つを渡しても動く（confirm(msg) と同じ）
 *   const ok = await showConfirmDialog('本当に削除しますか？');
 *
 * 設計メモ:
 *   - z-index: 10000  → 既存 modal-overlay (z-index:200) より上に出す
 *   - Esc / 背景クリック / × ボタン / キャンセル → false
 *   - OK → true
 *   - haruka.html の CSS 変数（--em / --em-dark / --text / --border 等）を使い
 *     既存 UI トーンに揃える。CSS 変数が未定義でもフォールバック色で動作する。
 *   - DOM はモジュールではなく素の <script> として読み込み、window に公開する。
 *     （haruka.html 本体の関数群が type="module" ではないため）
 * ============================================================ */
(function (window, document) {
  'use strict';

  // 多重ロード防止
  if (window.showConfirmDialog) return;

  // ---- スタイル注入（一度だけ） ----
  function ensureStyles() {
    if (document.getElementById('confirm-dialog-style')) return;
    const css = `
      .haruka-confirm-overlay{
        position:fixed; inset:0;
        background:rgba(0,0,0,0.45);
        z-index:10000;
        display:flex; align-items:center; justify-content:center;
        padding:24px;
        animation:harukaConfirmFadeIn .14s ease-out;
      }
      .haruka-confirm-box{
        background: var(--white, #fff);
        color: var(--text, #1a6b68);
        border:0.5px solid var(--border, #A8EDEA);
        border-radius:14px;
        box-shadow:0 20px 60px rgba(0,0,0,0.28), 0 4px 12px rgba(0,0,0,0.10);
        width:420px; max-width:calc(100vw - 32px);
        padding:22px 24px 18px;
        animation:harukaConfirmPop .16s ease-out;
      }
      .haruka-confirm-title{
        font-size:16px; font-weight:600;
        color: var(--text, #1a6b68);
        margin:0 0 12px;
        display:flex; align-items:center; justify-content:space-between; gap:12px;
      }
      .haruka-confirm-close{
        background:none; border:none; font-size:20px; line-height:1;
        cursor:pointer; color: var(--text-muted, #5ABDB9);
        padding:0 4px;
      }
      .haruka-confirm-close:hover{ color: var(--text, #1a6b68); }
      .haruka-confirm-message{
        font-size:14px; line-height:1.65;
        color: var(--text, #1a6b68);
        white-space:pre-wrap; word-break:break-word;
        margin:0 0 22px;
      }
      .haruka-confirm-footer{
        display:flex; justify-content:flex-end; gap:10px;
        padding-top:14px; border-top:0.5px solid var(--border, #A8EDEA);
      }
      .haruka-confirm-btn{
        font-size:13px; padding:8px 18px;
        border-radius:8px; cursor:pointer;
        border:0.5px solid var(--border, #A8EDEA);
        background:transparent;
        color: var(--em-dark, #2BB8B4);
        font-weight:500;
      }
      .haruka-confirm-btn:hover{ background: var(--surface, #F5FCFC); }
      .haruka-confirm-btn-primary{
        font-size:14px; padding:9px 22px;
        border-radius:8px; cursor:pointer;
        border:none;
        background: var(--em, #3ECFCA);
        color:#fff; font-weight:500;
      }
      .haruka-confirm-btn-primary:hover{ filter:brightness(1.05); }
      .haruka-confirm-btn-success{
        background:#16a34a;
      }
      .haruka-confirm-btn-success:hover{ background:#15803d; }
      .haruka-confirm-btn-danger{
        background:#dc2626;
      }
      .haruka-confirm-btn-danger:hover{ background:#b91c1c; }

      @keyframes harukaConfirmFadeIn{ from{opacity:0} to{opacity:1} }
      @keyframes harukaConfirmPop{
        from{ opacity:0; transform:translateY(6px) scale(.98) }
        to{ opacity:1; transform:translateY(0) scale(1) }
      }

      /* スマホ */
      @media (max-width:768px){
        .haruka-confirm-overlay{ padding:16px; }
        .haruka-confirm-box{
          width:100%; max-width:100%;
          padding:18px 18px 14px;
          border-radius:12px;
        }
        .haruka-confirm-title{ font-size:15px; margin-bottom:10px; }
        .haruka-confirm-message{ font-size:13.5px; margin-bottom:18px; }
        .haruka-confirm-footer{ flex-wrap:wrap; gap:8px; }
        .haruka-confirm-footer .haruka-confirm-btn,
        .haruka-confirm-footer .haruka-confirm-btn-primary{
          flex:1; min-width:120px; min-height:42px;
          text-align:center;
        }
      }
    `;
    const style = document.createElement('style');
    style.id = 'confirm-dialog-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * 画面中央に確認ダイアログを表示し、OK なら true / それ以外は false で resolve する Promise を返す。
   *
   * @param {string|object} optsOrMessage
   *   文字列を渡すと message として扱う（後方互換）。
   *   オブジェクトを渡す場合のキー:
   *     - title       {string}  ヘッダタイトル（既定: '確認'）
   *     - message     {string}  本文（必須。\n で改行可能）
   *     - okLabel     {string}  OK ボタン文言（既定: 'OK'）
   *     - cancelLabel {string}  キャンセルボタン文言（既定: 'キャンセル'）
   *     - okVariant   {'primary'|'success'|'danger'}  OK ボタンの色味（既定: 'primary'）
   * @returns {Promise<boolean>}
   */
  function showConfirmDialog(optsOrMessage) {
    ensureStyles();

    const opts =
      typeof optsOrMessage === 'string'
        ? { message: optsOrMessage }
        : (optsOrMessage || {});
    const title       = opts.title       || '確認';
    const message     = opts.message     || '';
    const okLabel     = opts.okLabel     || 'OK';
    const cancelLabel = opts.cancelLabel || 'キャンセル';
    const okVariant   = opts.okVariant   || 'primary'; // primary / success / danger

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'haruka-confirm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      // モーダル本体
      const box = document.createElement('div');
      box.className = 'haruka-confirm-box';

      // タイトル + ×
      const titleEl = document.createElement('div');
      titleEl.className = 'haruka-confirm-title';
      const titleText = document.createElement('span');
      titleText.textContent = title;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'haruka-confirm-close';
      closeBtn.setAttribute('aria-label', 'close');
      closeBtn.textContent = '×';
      titleEl.appendChild(titleText);
      titleEl.appendChild(closeBtn);

      // 本文
      const msgEl = document.createElement('div');
      msgEl.className = 'haruka-confirm-message';
      msgEl.textContent = message;

      // フッタ
      const footer = document.createElement('div');
      footer.className = 'haruka-confirm-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'haruka-confirm-btn';
      cancelBtn.textContent = cancelLabel;

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      const okClass =
        okVariant === 'success' ? 'haruka-confirm-btn-primary haruka-confirm-btn-success'
        : okVariant === 'danger' ? 'haruka-confirm-btn-primary haruka-confirm-btn-danger'
        : 'haruka-confirm-btn-primary';
      okBtn.className = okClass;
      okBtn.textContent = okLabel;

      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);

      box.appendChild(titleEl);
      box.appendChild(msgEl);
      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // フォーカスを OK に。Tab/Shift+Tab で 2 ボタン間をループさせる
      const previouslyFocused = document.activeElement;
      try { okBtn.focus(); } catch (_) {}

      let settled = false;
      function cleanup(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        try { overlay.remove(); } catch (_) {}
        try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {}
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
          e.preventDefault();
          cleanup(false);
        } else if (e.key === 'Enter') {
          // テキスト入力中ではないので Enter は OK 扱い
          if (document.activeElement === cancelBtn) return;
          e.preventDefault();
          cleanup(true);
        } else if (e.key === 'Tab') {
          // 2 ボタン間でフォーカスをトラップ
          const order = e.shiftKey ? [okBtn, cancelBtn] : [cancelBtn, okBtn];
          if (document.activeElement === order[0]) {
            e.preventDefault();
            order[1].focus();
          } else if (document.activeElement === order[1]) {
            e.preventDefault();
            order[0].focus();
          }
        }
      }
      document.addEventListener('keydown', onKey, true);

      // 背景クリックでキャンセル
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) cleanup(false);
      });

      closeBtn.addEventListener('click', () => cleanup(false));
      cancelBtn.addEventListener('click', () => cleanup(false));
      okBtn.addEventListener('click', () => cleanup(true));
    });
  }

  window.showConfirmDialog = showConfirmDialog;
})(window, document);

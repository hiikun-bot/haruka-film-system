// utils/drive-folder-url.js
// クリエイティブの「素材フォルダURL」（creatives.material_folder_url）の検証・表示用の純関数。
//
// 受け付けるのは Google ドライブ（https://drive.google.com/...）の URL だけ。
//   例) https://drive.google.com/drive/folders/1AbC...
//       https://drive.google.com/drive/u/0/folders/1AbC...?usp=sharing
//       https://drive.google.com/open?id=1AbC...
//   http:// は https:// に直して受け付ける。javascript: / data: / 他ドメインは弾く。
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/drive-folder-url')
//   - ブラウザ: server.js が /js/drive-folder-url.js で配信 → window.DriveFolderUrl
//     （入力欄の事前チェック・リンク表示とサーバーの保存時検証で同じロジックを使う）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DriveFolderUrl = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_LEN = 2000;
  const ALLOWED_HOSTS = ['drive.google.com'];
  const ERROR_MESSAGE = '素材フォルダURLは Google ドライブの URL（https://drive.google.com/...）を入れてください';

  // 入力値を検証して保存用の値にする。
  //   空（null / undefined / 空白だけ）→ { ok: true, value: null }
  //   正しい URL → { ok: true, value: '<正規化した URL>' }
  //   だめな値 → { ok: false, error: '<画面に出す文言>' }
  function normalizeDriveFolderUrl(input) {
    if (input === null || input === undefined) return { ok: true, value: null };
    if (typeof input !== 'string') return { ok: false, error: ERROR_MESSAGE };
    const raw = input.trim();
    if (!raw) return { ok: true, value: null };
    if (raw.length > MAX_LEN) return { ok: false, error: '素材フォルダURLが長すぎます（2000文字まで）' };
    // 空白・制御文字が混ざった値は URL として扱わない（貼り付け時に複数行が入った等）
    if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: ERROR_MESSAGE };
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      return { ok: false, error: ERROR_MESSAGE };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: ERROR_MESSAGE };
    if (u.username || u.password) return { ok: false, error: ERROR_MESSAGE };
    if (u.port) return { ok: false, error: ERROR_MESSAGE };
    if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return { ok: false, error: ERROR_MESSAGE };
    u.protocol = 'https:';
    return { ok: true, value: u.href };
  }

  // 表示用: 保存済みの値から安全に <a href> へ入れられる URL を返す。だめなら null。
  // （DB に古い値や手で入れた値があっても javascript: 等をリンクにしない）
  function safeDriveFolderHref(value) {
    const r = normalizeDriveFolderUrl(value);
    return r.ok && r.value ? r.value : null;
  }

  return {
    MAX_LEN,
    ALLOWED_HOSTS,
    ERROR_MESSAGE,
    normalizeDriveFolderUrl,
    safeDriveFolderHref,
  };
});

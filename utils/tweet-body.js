// utils/tweet-body.js
// つぶやき本文の正規化（改行コードの統一 + 前後の空白除去）。
//
// 背景（バグ報告 7374bea4「280字以内のはずなのにエラーがでます」）:
//   投稿画面は textarea の value（改行は LF "\n"）で 280 字を数えているが、
//   投稿は写真同送のため FormData(multipart/form-data) で送る。ブラウザは multipart の
//   文字列値の改行を CRLF "\r\n" に正規化して送る仕様（WHATWG HTML）なので、
//   サーバーが受け取る本文は「改行 1 つにつき 1 文字」長くなる。
//   例: 画面で 280 字（改行 5 つ）→ サーバーでは 285 字 → 400「本文は 280 字以内に…」。
//   サーバー側で改行を LF に戻してから数えれば、画面のカウンターと同じ長さになる。
//   （編集 PATCH は JSON 送信で CRLF 化しないが、同じ関数を通して揃える）

function normalizeTweetBody(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .trim();
}

module.exports = { normalizeTweetBody };

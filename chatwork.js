// ChatWork API クライアント (ミニマム実装)
//
// 仕様:
//   - process.env.CHATWORK_API_TOKEN を使って /v2/rooms/{roomId}/messages に POST する
//   - トークン未設定 / room 未指定 / API エラーなどはすべて例外を投げず、
//     { ok: false, reason: '...' } を返す（呼び出し側に通知失敗で 5xx を返させないため）
//   - Node 18+ のグローバル fetch を使用

const CHATWORK_API = 'https://api.chatwork.com/v2';

async function postChatworkMessage(roomId, body) {
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) {
    console.warn('[chatwork] CHATWORK_API_TOKEN 未設定のため通知スキップ');
    return { ok: false, reason: 'no_token' };
  }
  if (!roomId) return { ok: false, reason: 'no_room_id' };
  try {
    const res = await fetch(`${CHATWORK_API}/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: {
        'X-ChatWorkToken': token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ body, self_unread: '1' }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[chatwork] 送信失敗', res.status, text);
      return { ok: false, reason: 'http_' + res.status, detail: text };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[chatwork] 送信例外', e?.message);
    return { ok: false, reason: 'exception', detail: e?.message };
  }
}

module.exports = { postChatworkMessage };

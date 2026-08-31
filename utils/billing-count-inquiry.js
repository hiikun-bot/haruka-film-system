// utils/billing-count-inquiry.js
// =============================================================
// 月次制作本数ヒアリング（毎月末の自動送信）の文面生成
//
// 背景: よたさん案件（YouTube動画）の請求書発行にあたり、ひーくんが
// 毎月末に担当ディレクター（みっつー）へ Chatwork で制作本数を手動で
// 質問していた定型業務を、システムから自動送信する。
//
// 送信先・文面は system_settings 'billing_inquiry_targets'（JSON配列）で
// 上書き・追加可能。将来ほかの案件チャットにも同様のヒアリングを
// 増やせるよう、複数ターゲット前提の構造にしている。
//
// このモジュールは純関数のみ（DB・外部API 非依存、jest で直接テスト可能）。
// 送信とスケジュール判定は workers/billing-count-inquiry-scheduler.js が担う。
// =============================================================

// 既定ターゲット: 【HF】よたさん｜YouTube動画 ルームで みっつー宛て
// toAccountId は Chatwork の数字アカウントID（users.chatwork_dm_id と同じ値。
// 英数字IDを入れると To が silent に失敗するため必ず数字）。
const DEFAULT_TARGETS = [
  {
    label: 'よたさん YouTube動画（みっつー宛て）',
    roomId: '405007443',
    toAccountId: '7839661',
    toName: '安齋智光（みっつー）',
    body: [
      '【毎月末の自動送信メッセージです🤖】',
      '',
      'みっつー、お疲れさまです😊',
      '',
      'よたさんへの今月分の請求にあたり、以下の空欄を埋めてご返信をお願いします！',
      '該当がない項目は「0」で大丈夫です。',
      '',
      '──────────',
      'ロング動画',
      '──────────',
      '・動画制作：　　本',
      '・サムネイル制作：　　枚',
      '・台本作成：　　本',
      '',
      '──────────',
      'ショート動画',
      '──────────',
      '・動画制作：　　本',
      '・サムネイル制作：　　枚',
      '・台本作成：　　本',
      '',
      'いつも制作ありがとうございます！',
      'よろしくお願いいたします☺️',
    ].join('\n'),
  },
];

// カレンダー月の最終日（TZ 非依存。Date.UTC の day=0 で前月末日を得る）
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 'YYYY-MM' の前月を返す
function prevMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// system_settings 'billing_inquiry_targets' の JSON を検証つきで配列化。
// 不正な JSON・必須項目欠落は null を返し、呼び出し側が既定値へフォールバックする。
function parseTargets(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const targets = parsed.filter(t =>
    t && typeof t === 'object' &&
    String(t.roomId || '').trim() &&
    String(t.body || '').trim()
  ).map(t => ({
    label: String(t.label || t.roomId),
    roomId: String(t.roomId).trim(),
    toAccountId: t.toAccountId ? String(t.toAccountId).trim() : null,
    toName: t.toName ? String(t.toName).trim() : null,
    body: String(t.body),
  }));
  return targets.length > 0 ? targets : null;
}

/**
 * 1ターゲット分の Chatwork 送信本文を組み立てる。
 * toAccountId が数字のときだけ [To:] を付ける（非数字は To が silent 失敗するため本文のみ）。
 * @param {{ roomId: string, toAccountId?: string, toName?: string, body: string }} target
 * @returns {string}
 */
function buildBillingInquiryMessage(target) {
  const accountId = String(target.toAccountId || '').trim();
  if (/^\d+$/.test(accountId)) {
    const name = String(target.toName || '').trim();
    const toLine = name ? `[To:${accountId}]${name}さん` : `[To:${accountId}]`;
    return `${toLine}\n\n${target.body}`;
  }
  return target.body;
}

module.exports = {
  DEFAULT_TARGETS,
  lastDayOfMonth,
  prevMonth,
  parseTargets,
  buildBillingInquiryMessage,
};

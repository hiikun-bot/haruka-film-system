// utils/contract-messages.js
// =============================================================
// 契約管理（ADR 035）の通知文面。純関数のみ（DB・外部API 非依存、jest で直接テスト）。
// 各関数は { chatwork, slack } を返す。送信は utils/member-notify.js が担う。
//
//   buildRequestMessage      依頼（URL 送付）
//   buildReminderMessage     催促
//   buildDueNoticeMessage    回答期限（前日・当日・超過）
//   buildRevisionMessage     修正依頼
//   buildApprovalMessage     承認（手続き完了）
//   buildReconsentMessage    再同意（新版公開）
//   buildExpiryMessage       有効期限（本人）
//   buildAdminSubmittedMessage 管理者向け「確認待ち」
//   buildAdminExpiryMessage  管理者向け 有効期限
//   buildAdminRenewNoticeMessage 管理者向け 更新拒絶期限
//   buildAdminSummaryMessage 管理者日次サマリ
// =============================================================

function formatDateJa(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return ymd ? String(ymd) : '未設定';
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

// 『A』 / 『A』と『B』 / 『A』『B』『C』
function joinTitles(titles) {
  const list = (Array.isArray(titles) ? titles : [titles]).filter(Boolean).map(t => `『${t}』`);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]}と${list[1]}`;
  return list.join('');
}

function san(name) {
  const n = String(name || '').trim();
  return n ? `${n}さん` : 'お疲れさまです';
}

function wrap(title, body) {
  return {
    chatwork: `[info][title]${title}[/title]${body}[/info]`,
    slack: `*${title}*\n${body}`,
  };
}

/**
 * 依頼
 * @param {{displayName:string, partyName:string, docTitles:string[], url:string, due?:string, extraMessage?:string, minutes?:number}} p
 */
function buildRequestMessage({ displayName, partyName, docTitles, url, due, extraMessage, minutes = 10 }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    `${partyName}としての${joinTitles(docTitles)}のご確認・ご同意をお願いします。`,
    `下記URLからHARUKA FILM SYSTEMにログインして進めてください（所要 約${minutes}分）。`,
    url,
  ];
  if (due) lines.push(`回答期限：${formatDateJa(due)}`);
  if (extraMessage && String(extraMessage).trim()) lines.push('', String(extraMessage).trim());
  return wrap('契約書のご確認・ご同意のお願い', lines.join('\n'));
}

/**
 * 催促
 * @param {{displayName:string, sentDate:string, docTitles:string[], due?:string, url:string}} p
 */
function buildReminderMessage({ displayName, sentDate, docTitles, due, url }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    `${formatDateJa(sentDate)}にお送りした${joinTitles(docTitles)}のご同意がまだ完了していません。`,
  ];
  if (due) lines.push(`回答期限は${formatDateJa(due)}です。`);
  lines.push('お手すきの際に下記URLからご対応をお願いします。', url);
  return wrap('契約書ご同意のリマインド', lines.join('\n'));
}

/**
 * 回答期限（前・当日・超過）
 * @param {{displayName:string, docTitles:string[], due:string, kind:'before'|'due'|'overdue', url:string}} p
 */
function buildDueNoticeMessage({ displayName, docTitles, due, kind, url }) {
  const head = kind === 'due'
    ? `${joinTitles(docTitles)}の回答期限は本日（${formatDateJa(due)}）です。`
    : kind === 'overdue'
      ? `${joinTitles(docTitles)}の回答期限（${formatDateJa(due)}）を過ぎています。`
      : `${joinTitles(docTitles)}の回答期限（${formatDateJa(due)}）が近づいています。`;
  const lines = [`${san(displayName)}、お疲れさまです。`, head, '下記URLからご同意をお願いします。', url];
  return wrap('契約書の回答期限のご案内', lines.join('\n'));
}

/**
 * 修正依頼
 * @param {{displayName:string, reason:string, url:string}} p
 */
function buildRevisionMessage({ displayName, reason, url }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    'ご入力内容について確認をお願いしたい点があります。',
    String(reason || '').trim(),
    url,
  ];
  return wrap('契約手続きの修正のお願い', lines.join('\n'));
}

/**
 * 承認
 * @param {{displayName:string, docTitles:string[]}} p
 */
function buildApprovalMessage({ displayName, docTitles }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    `${joinTitles(docTitles)}の契約手続きが完了しました。`,
    '契約書PDFと同意記録の控えはHARUKA FILM SYSTEMの「契約・登録手続き」からダウンロードできます。',
  ];
  return wrap('契約手続き完了のお知らせ', lines.join('\n'));
}

/**
 * 再同意
 * @param {{displayName:string, docTitle:string, versionLabel:string, summary?:string, url:string}} p
 */
function buildReconsentMessage({ displayName, docTitle, versionLabel, summary, url }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    `『${docTitle}』が${versionLabel}に改訂されました（変更点：${String(summary || '').trim() || '詳細は文書をご確認ください'}）。`,
    '新しい版へのご同意をお願いします。同意までは現在の版が有効のままです。',
    url,
  ];
  return wrap('契約書改訂に伴う再同意のお願い', lines.join('\n'));
}

/**
 * 有効期限（本人）
 * @param {{displayName:string, docTitle:string, partyName:string, contractDate:string, endDate:string, renewDeadline?:string, autoRenew:boolean}} p
 */
function buildExpiryMessage({ displayName, docTitle, partyName, contractDate, endDate, renewDeadline, autoRenew }) {
  const lines = [
    `${san(displayName)}、お疲れさまです。`,
    `『${docTitle}』（${partyName}・${formatDateJa(contractDate)}締結）の有効期限が${formatDateJa(endDate)}に来ます。`,
  ];
  if (autoRenew) {
    lines.push('特にお申し出がなければ同じ条件で1年間自動更新されます。');
    if (renewDeadline) lines.push(`更新を希望されない場合は${formatDateJa(renewDeadline)}までにご連絡ください。`);
  } else {
    lines.push('継続をご希望の場合は、HARUKA FILMまでご連絡ください。');
  }
  return wrap('契約の有効期限のご案内', lines.join('\n'));
}

/**
 * 管理者向け「確認待ち」（本人が送信した直後）
 * @param {{memberName:string, docTitles:string[], partyName?:string, url?:string}} p
 */
function buildAdminSubmittedMessage({ memberName, docTitles, partyName, url }) {
  const lines = [
    `${memberName}さんが${joinTitles(docTitles)}${partyName ? `（${partyName}）` : ''}に同意しました。承認をお願いします。`,
  ];
  if (url) lines.push(url);
  return wrap('契約管理：確認待ち', lines.join('\n'));
}

/**
 * 管理者向け 有効期限
 */
function buildAdminExpiryMessage({ memberName, docTitle, partyName, endDate, daysLeft, autoRenew, url }) {
  const lines = [
    `${memberName}さんの『${docTitle}』（${partyName}）の有効期限が${formatDateJa(endDate)}（あと${daysLeft}日）に来ます。`,
    autoRenew ? '自動更新の契約です。' : '自動更新なしの契約です。継続する場合は再契約が必要です。',
  ];
  if (url) lines.push(url);
  return wrap('契約管理：有効期限', lines.join('\n'));
}

/**
 * 管理者向け 更新拒絶期限
 */
function buildAdminRenewNoticeMessage({ memberName, docTitle, partyName, endDate, renewDeadline, url }) {
  const lines = [
    `${memberName}さんの『${docTitle}』（${partyName}）は${formatDateJa(endDate)}に自動更新されます。`,
    `更新しない場合は${formatDateJa(renewDeadline)}までに本人へ通知が必要です。`,
  ];
  if (url) lines.push(url);
  return wrap('契約管理：更新拒絶期限', lines.join('\n'));
}

/**
 * 管理者日次サマリ
 * @param {{date:string, counts:{awaiting:number, unattended:number, overdue:number, expiring:number, reconsent:number}, listUrl?:string, items?:{awaiting?:string[], unattended?:string[], overdue?:string[], expiring?:string[], reconsent?:string[]}}} p
 */
function buildAdminSummaryMessage({ date, counts, listUrl, items = {} }) {
  const c = { awaiting: 0, unattended: 0, overdue: 0, expiring: 0, reconsent: 0, ...(counts || {}) };
  const line = (label, n, names) => {
    const base = `・${label}：${n}件`;
    const list = (names || []).slice(0, 5);
    return list.length ? `${base}（${list.join('、')}${(names || []).length > 5 ? ' ほか' : ''}）` : base;
  };
  const lines = [
    `${formatDateJa(date)}時点の契約手続き状況です。`,
    line('確認待ち（承認が必要）', c.awaiting, items.awaiting),
    line('未対応（3日以上未閲覧）', c.unattended, items.unattended),
    line('回答期限切れ', c.overdue, items.overdue),
    line('30日以内に有効期限', c.expiring, items.expiring),
    line('再同意が必要', c.reconsent, items.reconsent),
  ];
  if (listUrl) lines.push(listUrl);
  return wrap('契約管理 日次サマリ', lines.join('\n'));
}

module.exports = {
  formatDateJa,
  joinTitles,
  buildRequestMessage,
  buildReminderMessage,
  buildDueNoticeMessage,
  buildRevisionMessage,
  buildApprovalMessage,
  buildReconsentMessage,
  buildExpiryMessage,
  buildAdminSubmittedMessage,
  buildAdminExpiryMessage,
  buildAdminRenewNoticeMessage,
  buildAdminSummaryMessage,
};

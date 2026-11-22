// utils/invoice-announce.js
// =============================================================
// 請求書案内（毎月20日ごろの全体アナウンス）の文面生成
//
// 背景: 旧秘書チームが毎月20日ごろ Chatwork 全体チャットへ手動投稿していた
// 「請求書送付についてのご案内」を、秘書チーム解体に伴いシステムから
// 自動送信する（Chatwork 全体チャット + Slack 全体チャンネルの両方）。
//
// このモジュールは純関数のみ（DB・外部API 非依存、jest で直接テスト可能）。
// 送信とスケジュール判定は workers/invoice-announce-scheduler.js が担う。
// =============================================================

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 2026-11: 提出の本線を「請求システム（請求書ページ）で作成→提出」に変更。
// 旧スプレッドシート手入力→PDF→DM 報告は、システムで対応できない場合の
// 例外としてだけ案内する。

// 請求書フォーマット（コピー用スプレッドシート・例外時のみ案内）
const FORMAT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1iiGvKj0DGWeqzukL0hZ3dgejFzf-gY2bzGHlWce3U6g/copy';

// HF案件（GND ではない案件）の一覧。
// 請求システムでの提出が本線になり、メンバーが区分を意識する必要がなくなったため
// 現在は文面に載せていない（設定値と opts.hfClients は互換のため残す）。
const DEFAULT_HF_CLIENTS = [
  'りヲぢさん',
  'よたさん',
  'ひげごろーさん',
  'はっすいさん',
  'さかもと腎・泌尿器クリニック',
];

// 提出期間は毎月 26日〜28日（旧秘書案内の運用踏襲）
const SUBMIT_DAY_START = 26;
const SUBMIT_DAY_END = 28;

const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈';

// 案内文の中での送り主の呼び方（Chatwork は本人名義の投稿／それ以外はボット・システム名義）
const SELF_CHATWORK = '私';
const SELF_OTHERS = '髙橋';

const pad2 = (n) => String(n).padStart(2, '0');

// 提出期間（26〜28日）を終日予定として登録する Google カレンダーリンク。
// 終日予定の終了日は「最終日の翌日」を渡す仕様。月末またぎ（2月など）でも
// 正しい日付になるよう UTC で繰り上げ計算する（TZ 非依存）。
function buildSubmitCalendarUrl(year, month) {
  const endNext = new Date(Date.UTC(year, month - 1, SUBMIT_DAY_END + 1, 12));
  const start = `${year}${pad2(month)}${pad2(SUBMIT_DAY_START)}`;
  const end = `${endNext.getUTCFullYear()}${pad2(endNext.getUTCMonth() + 1)}${pad2(endNext.getUTCDate())}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `【HARUKA FILM】請求書の提出（${month}/${SUBMIT_DAY_START}〜${month}/${SUBMIT_DAY_END}）`,
    dates: `${start}/${end}`,
    ctz: 'Asia/Tokyo',
    details: 'HARUKA FILM SYSTEM の「請求書」ページから今月分を作成し、内容を確認して「提出する」まで行ってください。',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// カレンダー上の日付の曜日は TZ に依存しないよう UTC 正午で計算する
function weekdayJa(year, month, day) {
  return WEEKDAYS_JA[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

// 'YYYY-MM' → { year, month }。不正なら null
function parseMonthStr(monthStr) {
  const m = String(monthStr || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

// system_settings の HF案件上書き値（改行/カンマ区切り）を配列に変換
function parseHfClients(raw) {
  if (!raw) return null;
  const list = String(raw).split(/[\n,、]+/).map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 案内文を組み立てる。
 * @param {string} monthStr 対象月 'YYYY-MM'（提出期間 26〜28日はこの月の日付）
 * @param {object} [opts] 互換のため受け取るが現在は未使用（旧 hfClients）
 * @returns {{ month: string, chatwork: string, slack: string, plain: string, submitPeriodLabel: string, calendarUrl: string }}
 */
function buildInvoiceAnnounceTexts(monthStr, _opts = {}) {
  const parsed = parseMonthStr(monthStr);
  if (!parsed) throw new Error(`invoice-announce: 不正な月指定です: ${monthStr}`);
  const { year, month } = parsed;

  const w1 = weekdayJa(year, month, SUBMIT_DAY_START);
  const w2 = weekdayJa(year, month, SUBMIT_DAY_END);
  const submitPeriodLabel = `${month}/${SUBMIT_DAY_START}(${w1})~${month}/${SUBMIT_DAY_END}(${w2})`;

  // カレンダー登録リンク（提出期間 26〜28日の終日予定。終了日は Google 仕様で翌日を指定）
  const calendarUrl = buildSubmitCalendarUrl(year, month);

  // 本文（Chatwork 絵文字 (bow)/(please) を含む素の形。Slack 版は後で置換）。
  // self = 案内文の中での送り主の呼び方。Chatwork は本人名義で投稿されるので「私」、
  // Slack・ダッシュボードは投稿者名がボット／システムになり「私」では誰か
  // 分からないので「髙橋」にする。
  const buildBody = (self) => [
    '今月もHARUKA FILMからのお仕事を受けていただき',
    'ありがとうございました(bow)',
    '',
    '請求書についてのご案内です😊',
    '',
    '⚠️請求書は【HARUKA FILM SYSTEM（請求システム）】での提出が基本です⚠️',
    `スプレッドシートでの手入力・PDF化・${self}へのDM報告は不要です✨`,
    '',
    DIVIDER,
    '◯提出の流れ',
    '',
    '①HARUKA FILM SYSTEM の「請求書」ページを開く',
    '',
    '②「＋ 今月の請求書を作成」から今月分を作り、本数・金額に間違いがないか確認する',
    '',
    '③「提出する」ボタンを押す',
    '',
    '以上で完了です(bow)',
    '提出するとPDFが自動で作られ、ご自身のフォルダ（Googleドライブ）に保存されます。',
    `こちらのフォルダは${self}とご本人のみ閲覧できます。`,
    '',
    DIVIDER,
    '◯提出日',
    '',
    submitPeriodLabel,
    `📅 カレンダー登録：${calendarUrl}`,
    '',
    '提出後の報酬発生分は',
    '翌月に繰越ください(bow)',
    '',
    DIVIDER,
    '◯請求可能タイミング',
    '',
    '納品完了ステータスの場合支払いOKとします！',
    '判断が迷う場合は',
    'まずはディレクターさんに質問をおねがいします😊',
    '',
    DIVIDER,
    '◯システムの内容が実際と違うとき',
    '',
    '本数や金額が合わない、載っていない案件がある場合は',
    `提出前に${self}へDMでご連絡ください🙇‍♀️`,
    'どうしてもシステムで対応できない場合のみ、',
    '従来のフォーマット（PDF提出）でも受け付けます。',
    FORMAT_SHEET_URL,
  ].join('\n');

  const buildFooter = (self) => [
    '',
    '返信は不要です😊',
    `質問ありましたら${self}へDM`,
    '（ChatworkでもSlackでも可）',
    'お願いいたします!!',
  ].join('\n');

  const greeting = 'みなさんお疲れ様でございます';

  // Chatwork 版: [info][title] 囲み + Chatwork 絵文字そのまま
  const chatwork = `${greeting}(please)\n\n[info][title]請求書送付についてのご案内[/title]${buildBody(SELF_CHATWORK)}[/info]${buildFooter(SELF_CHATWORK)}`;

  // Slack 版: 太字見出し + Chatwork 専用絵文字を Unicode 絵文字に置換
  const slackBody = buildBody(SELF_OTHERS).replace(/\(bow\)/g, '🙇‍♀️').replace(/\(please\)/g, '🙏');
  const slack = `${greeting}🙏\n\n*📄 請求書送付についてのご案内*\n\n${slackBody}\n${buildFooter(SELF_OTHERS)}`;

  // プレーン版: 装飾記法なし（ダッシュボードの全体連絡カード用。見出しは
  // announcements.title 側に入るため本文に重複させない）
  const plain = `${greeting}🙏\n\n${slackBody}\n${buildFooter(SELF_OTHERS)}`;

  return { month: `${parsed.year}-${String(parsed.month).padStart(2, '0')}`, chatwork, slack, plain, submitPeriodLabel, calendarUrl };
}

module.exports = {
  buildInvoiceAnnounceTexts,
  buildSubmitCalendarUrl,
  parseHfClients,
  parseMonthStr,
  weekdayJa,           // テスト用
  DEFAULT_HF_CLIENTS,
  FORMAT_SHEET_URL,
  SUBMIT_DAY_START,
  SUBMIT_DAY_END,
};

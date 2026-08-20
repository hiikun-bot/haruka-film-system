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

// 請求書フォーマット（コピー用スプレッドシート）
const FORMAT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1iiGvKj0DGWeqzukL0hZ3dgejFzf-gY2bzGHlWce3U6g/copy';

// HF案件（GND ではない案件）の一覧。
// system_settings 'invoice_announce_hf_clients'（改行 or カンマ区切り）で上書き可能。
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
 * @param {object} [opts] { hfClients?: string[] }
 * @returns {{ month: string, chatwork: string, slack: string, submitPeriodLabel: string }}
 */
function buildInvoiceAnnounceTexts(monthStr, opts = {}) {
  const parsed = parseMonthStr(monthStr);
  if (!parsed) throw new Error(`invoice-announce: 不正な月指定です: ${monthStr}`);
  const { year, month } = parsed;
  const hfClients = (opts.hfClients && opts.hfClients.length > 0) ? opts.hfClients : DEFAULT_HF_CLIENTS;

  const w1 = weekdayJa(year, month, SUBMIT_DAY_START);
  const w2 = weekdayJa(year, month, SUBMIT_DAY_END);
  const submitPeriodLabel = `${month}/${SUBMIT_DAY_START}(${w1})~${month}/${SUBMIT_DAY_END}(${w2})`;

  // 本文（Chatwork 絵文字 (bow)/(please) を含む素の形。Slack 版は後で置換）
  const body = [
    '今月もHARUKA FILMからのお仕事を受けていただき',
    'ありがとうございました(bow)',
    '',
    '請求書についてのご案内です😊',
    '',
    'システムでの請求書発行はしていただいても大丈夫ですが',
    'そちらはクリエイティブ作成本数等の参考としてご利用ください🙇‍♀️',
    '手入力が発生してとてもお手間かけて申し訳ないです🙇‍♀️',
    '',
    DIVIDER,
    '◯請求書フォーマット',
    '⚠️提出は【pdfファイル】でお願いします🙇‍♀️⚠️',
    '先月と同じものです。',
    '「請求書作成のポイント」シートをご覧ください(bow)',
    '',
    'ファイル名の規則指定はありませんので',
    'ご自身のお名前だけは入力お願いいたします✨',
    FORMAT_SHEET_URL,
    '',
    'Slack対応してる案件はすべてGNDです！',
    '',
    '逆にHF案件は',
    ...hfClients.map(c => `✅${c}`),
    '',
    'のみとなります🙇‍♀️',
    '',
    DIVIDER,
    '◯PDF提出先',
    'システム上フォルダです(bow)',
    'HARUKA FILM SYSTEM の請求書ページから、ご自身のフォルダ（Googleドライブ）に提出ください(please)',
    'こちらのフォルダはひーくんと本人のみ閲覧できます。',
    '',
    DIVIDER,
    '◯提出の報告',
    '',
    '請求書フォーマット👇にて作成する（前月のコピーでもかまいません）',
    FORMAT_SHEET_URL,
    '↓',
    'PDF化する',
    '↓',
    'PDFを各自HARUKA FILM で作ったフォルダにアップロードする',
    '↓',
    'HARUKA FILM でつくったアップロードフォルダの中にある',
    'PDFのURLを⚠️ひーくんにDMで送る⚠️',
    '',
    'こちらの流れで、ひーくんへのDMまでお願いいたします🙇‍♀️🙇‍♀️🙇‍♀️',
    '',
    DIVIDER,
    '◯提出日',
    '',
    submitPeriodLabel,
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
  ].join('\n');

  const footer = [
    '',
    '返信は不要です😊',
    '質問ありましたらひーくんへDM',
    '（ChatworkでもSlackでも可）',
    'お願いいたします!!',
  ].join('\n');

  const greeting = 'みなさんお疲れ様でございます';

  // Chatwork 版: [info][title] 囲み + Chatwork 絵文字そのまま
  const chatwork = `${greeting}(please)\n\n[info][title]請求書送付についてのご案内[/title]${body}[/info]${footer}`;

  // Slack 版: 太字見出し + Chatwork 専用絵文字を Unicode 絵文字に置換
  const slackBody = body.replace(/\(bow\)/g, '🙇‍♀️').replace(/\(please\)/g, '🙏');
  const slack = `${greeting}🙏\n\n*📄 請求書送付についてのご案内*\n\n${slackBody}\n${footer}`;

  return { month: `${parsed.year}-${String(parsed.month).padStart(2, '0')}`, chatwork, slack, submitPeriodLabel };
}

module.exports = {
  buildInvoiceAnnounceTexts,
  parseHfClients,
  parseMonthStr,
  weekdayJa,           // テスト用
  DEFAULT_HF_CLIENTS,
  FORMAT_SHEET_URL,
};

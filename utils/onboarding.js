// utils/onboarding.js
// オンボーディング管理（新メンバー受け入れ）の純関数群。
// - チェックリストテンプレの定義と職種別展開
// - 進捗（done数/総数・次のアクション）の計算
// - 初回メッセージ文例の生成（職種別出し分け）
// DB 非依存。routes/haruka.js とテスト tests/utils/onboarding.test.js から共用する。
//
// 背景: 秘書チーム解体に伴い、スプレッドシート「オンボーディング引き継ぎシート」で
// 秘書が回していた新メンバー受け入れ業務を HFS に取り込む（運用者: admin）。

// 職種コード → 表示ラベル
const ONBOARDING_OCCUPATIONS = {
  video_creator: '動画クリエイター',
  designer: 'デザイナー',
};

// フェーズ定義（表示順もこの並び）
// 2026-08-20 の運用変更で「MT前/MT/MT後/完了確認」の4フェーズから、
// 作業の主体で分けた2フェーズ（相手がやる作業 / こっちがやる作業）に再編。
// key はDB CHECK制約 ('mt_before','mt','mt_after','final') を変えずに済むよう
// 初期実装のキーを流用している（mt_before=相手がやる作業, final=こっちがやる作業）。
const ONBOARDING_PHASES = [
  { key: 'mt_before', label: 'HFSへ入る前の作業（相手がやる作業）' },
  { key: 'final',     label: 'HFSへの招待（こっちがやる作業）' },
];

const PHASE_ORDER = new Map(ONBOARDING_PHASES.map((p, i) => [p.key, i]));

// チェックリストテンプレ（occupations 省略時は全職種対象）。
// レコード作成時に職種でフィルタして onboarding_tasks に展開する。
const ONBOARDING_TASK_TEMPLATE = [
  // --- HFSへ入る前の作業（相手＝新メンバーがやる作業） ---
  { task_key: 'two_factor_auth',    phase: 'mt_before', label: 'Chatwork・Slackの二段階認証設定' },
  { task_key: 'personal_info_form', phase: 'mt_before', label: '個人情報フォーム回答' },
  { task_key: 'hf_contract',        phase: 'mt_before', label: 'HARUKA FILM契約書の提出', occupations: ['video_creator'] },
  { task_key: 'gnd_contract',       phase: 'mt_before', label: 'GND契約書の提出' },
  // --- HFSへの招待（こっち＝運営側がやる作業） ---
  { task_key: 'chatwork_contact', phase: 'final', label: 'Chatworkコンタクト申請・招待' },
  { task_key: 'hfs_invite',       phase: 'final', label: 'HFSへメンバー招待' },
  { task_key: 'gnd_info_share',   phase: 'final', label: 'GOOD NEW Design関連の情報共有' },
  { task_key: 'invoice_guide',    phase: 'final', label: '請求書発行手続きの案内' },
  { task_key: 'team_assignment',  phase: 'final', label: 'チーム配属の決定' },
];

function isValidOccupation(occupation) {
  return Object.prototype.hasOwnProperty.call(ONBOARDING_OCCUPATIONS, occupation);
}

/**
 * 職種別にテンプレを展開し、onboarding_tasks への INSERT 行（record_id 抜き）を返す。
 * sort_order はテンプレ定義順に 10 刻み（将来の間挿入余地）。
 */
function buildOnboardingTasks(occupation) {
  if (!isValidOccupation(occupation)) {
    throw new Error(`不正な職種です: ${occupation}`);
  }
  return ONBOARDING_TASK_TEMPLATE
    .filter(t => !t.occupations || t.occupations.includes(occupation))
    .map((t, i) => ({
      task_key: t.task_key,
      label: t.label,
      phase: t.phase,
      sort_order: (i + 1) * 10,
    }));
}

/**
 * tasks をフェーズ順（mt_before → mt → mt_after → final）→ sort_order 順に整列した新配列を返す。
 */
function sortOnboardingTasks(tasks) {
  return [...(tasks || [])].sort((a, b) => {
    const pa = PHASE_ORDER.has(a.phase) ? PHASE_ORDER.get(a.phase) : 99;
    const pb = PHASE_ORDER.has(b.phase) ? PHASE_ORDER.get(b.phase) : 99;
    if (pa !== pb) return pa - pb;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
}

/**
 * 進捗を計算する。
 * @returns {{ done: number, total: number, next_task: string|null }}
 *   next_task = フェーズ順・sort_order 順で最初の未完了タスクのラベル（全完了なら null）
 */
function computeOnboardingProgress(tasks) {
  const sorted = sortOnboardingTasks(tasks);
  const done = sorted.filter(t => !!t.done).length;
  const next = sorted.find(t => !t.done);
  return {
    done,
    total: sorted.length,
    next_task: next ? next.label : null,
  };
}

// 初回メッセージ「MT前のお願い」の職種別出し分け
const FIRST_MESSAGE_REQUESTS = {
  video_creator: [
    '・HARUKA FILM契約書の提出',
    '・Chatwork・Slackの二段階認証設定',
    '・個人情報フォームへの回答',
  ],
  designer: [
    '・Chatwork・Slackの二段階認証設定',
    '・個人情報フォームへの回答',
  ],
};

/**
 * 初回メッセージ文例（コピー用テンプレ）を生成する。
 * 日程候補はプレースホルダ（〇月〇日）のまま返し、送信時に本人が書き換える運用。
 */
function buildOnboardingFirstMessage(occupation) {
  if (!isValidOccupation(occupation)) {
    throw new Error(`不正な職種です: ${occupation}`);
  }
  return [
    'はじめまして！HARUKA FILMの髙橋です。',
    '',
    'このたびはご加入ありがとうございます。これからよろしくお願いいたします。',
    '',
    'まずはチームの概要をご紹介するMT（30分ほど・Google Meet）をさせてください。',
    '',
    '私の直近の空きは下記です。ご都合の良い日時はありますか？',
    '',
    '・〇月〇日(〇)〇〇時〜',
    '・〇月〇日(〇)〇〇時〜',
    '・〇月〇日(〇)〇〇時〜',
    '',
    'どれも難しければ、ご都合の良い候補をいくつかいただけると助かります。',
    '',
    'あわせて、MTまでに下記のご対応をお願いします。',
    '',
    ...FIRST_MESSAGE_REQUESTS[occupation],
  ].join('\n');
}

module.exports = {
  ONBOARDING_OCCUPATIONS,
  ONBOARDING_PHASES,
  ONBOARDING_TASK_TEMPLATE,
  isValidOccupation,
  buildOnboardingTasks,
  sortOnboardingTasks,
  computeOnboardingProgress,
  buildOnboardingFirstMessage,
};

// tests/utils/onboarding.test.js
// オンボーディング管理（utils/onboarding.js）の純関数テスト。
// - テンプレ展開の職種別項目差分（動画クリエイター限定タスクの有無）
// - 進捗計算（done数/総数・next_task のフェーズ順解決）
// - 初回メッセージ文例の職種別出し分け
// DB 非依存。TZ=UTC / TZ=Asia/Tokyo の両方で同結果になること（日付ロジックなし）。

const {
  ONBOARDING_OCCUPATIONS,
  ONBOARDING_PHASES,
  ONBOARDING_TASK_TEMPLATE,
  isValidOccupation,
  buildOnboardingTasks,
  sortOnboardingTasks,
  computeOnboardingProgress,
  buildOnboardingFirstMessage,
} = require('../../utils/onboarding');

const VIDEO_ONLY_KEYS = ['hf_contract'];

describe('buildOnboardingTasks（職種別テンプレ展開）', () => {
  test('動画クリエイターは全10タスク（動画限定1件を含む）', () => {
    const tasks = buildOnboardingTasks('video_creator');
    expect(tasks).toHaveLength(10);
    const keys = tasks.map(t => t.task_key);
    for (const k of VIDEO_ONLY_KEYS) expect(keys).toContain(k);
  });

  test('デザイナーは動画限定タスクを除いた9タスク', () => {
    const tasks = buildOnboardingTasks('designer');
    expect(tasks).toHaveLength(9);
    const keys = tasks.map(t => t.task_key);
    for (const k of VIDEO_ONLY_KEYS) expect(keys).not.toContain(k);
  });

  test('両職種の差分は動画限定タスクのみ（共通タスクは完全一致）', () => {
    const video = new Set(buildOnboardingTasks('video_creator').map(t => t.task_key));
    const designer = new Set(buildOnboardingTasks('designer').map(t => t.task_key));
    const diff = [...video].filter(k => !designer.has(k)).sort();
    expect(diff).toEqual([...VIDEO_ONLY_KEYS].sort());
    // designer 側に video に無いタスクは存在しない
    expect([...designer].filter(k => !video.has(k))).toEqual([]);
  });

  test('sort_order は昇順・重複なし、phase は定義済みフェーズのみ', () => {
    const validPhases = new Set(ONBOARDING_PHASES.map(p => p.key));
    for (const occ of Object.keys(ONBOARDING_OCCUPATIONS)) {
      const tasks = buildOnboardingTasks(occ);
      const orders = tasks.map(t => t.sort_order);
      expect(new Set(orders).size).toBe(orders.length);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      for (const t of tasks) expect(validPhases.has(t.phase)).toBe(true);
      // record_id / done は展開時点では含まない（INSERT 時に付与）
      for (const t of tasks) {
        expect(t).toEqual({
          task_key: expect.any(String),
          label: expect.any(String),
          phase: expect.any(String),
          sort_order: expect.any(Number),
        });
      }
    }
  });

  test('フェーズは 相手がやる作業 → こっちがやる作業 の順に並ぶ', () => {
    const phaseIndex = new Map(ONBOARDING_PHASES.map((p, i) => [p.key, i]));
    const tasks = buildOnboardingTasks('video_creator');
    const indices = tasks.map(t => phaseIndex.get(t.phase));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  test('不正な職種は throw', () => {
    expect(() => buildOnboardingTasks('editor')).toThrow(/不正な職種/);
    expect(() => buildOnboardingTasks(undefined)).toThrow(/不正な職種/);
    expect(isValidOccupation('video_creator')).toBe(true);
    expect(isValidOccupation('editor')).toBe(false);
  });
});

describe('computeOnboardingProgress（進捗計算）', () => {
  test('未着手: done=0、next_task はテンプレ先頭のラベル', () => {
    const tasks = buildOnboardingTasks('designer').map(t => ({ ...t, done: false }));
    const p = computeOnboardingProgress(tasks);
    expect(p).toEqual({ done: 0, total: 9, next_task: 'Chatwork・Slackの二段階認証設定' });
  });

  test('途中: done数が正しく、next_task はフェーズ順・sort順で最初の未完了', () => {
    const tasks = buildOnboardingTasks('video_creator').map(t => ({
      ...t,
      // 相手側フェーズ4件を完了 → 次は こっち側フェーズ先頭の「Chatworkコンタクト申請・招待」
      done: t.phase === 'mt_before',
    }));
    const p = computeOnboardingProgress(tasks);
    expect(p.done).toBe(4);
    expect(p.total).toBe(10);
    expect(p.next_task).toBe('Chatworkコンタクト申請・招待');
  });

  test('配列の並びが崩れていても next_task はフェーズ順で解決する', () => {
    const tasks = buildOnboardingTasks('designer').map(t => ({ ...t, done: t.phase === 'mt_before' }));
    const shuffled = [...tasks].reverse();
    const p = computeOnboardingProgress(shuffled);
    expect(p.next_task).toBe('Chatworkコンタクト申請・招待'); // こっち側フェーズの先頭
  });

  test('全完了: next_task は null', () => {
    const tasks = buildOnboardingTasks('designer').map(t => ({ ...t, done: true }));
    const p = computeOnboardingProgress(tasks);
    expect(p).toEqual({ done: 9, total: 9, next_task: null });
  });

  test('空配列・null 安全', () => {
    expect(computeOnboardingProgress([])).toEqual({ done: 0, total: 0, next_task: null });
    expect(computeOnboardingProgress(null)).toEqual({ done: 0, total: 0, next_task: null });
  });
});

describe('sortOnboardingTasks', () => {
  test('フェーズ順 → sort_order 順に整列し、元配列は破壊しない', () => {
    const original = [
      { phase: 'final', sort_order: 10, label: 'c' },
      { phase: 'mt_before', sort_order: 20, label: 'b' },
      { phase: 'mt_before', sort_order: 10, label: 'a' },
    ];
    const copy = [...original];
    const sorted = sortOnboardingTasks(original);
    expect(sorted.map(t => t.label)).toEqual(['a', 'b', 'c']);
    expect(original).toEqual(copy);
  });
});

describe('buildOnboardingFirstMessage（初回メッセージ文例）', () => {
  test('共通部分: 挨拶・MT打診・日程プレースホルダを含む', () => {
    for (const occ of Object.keys(ONBOARDING_OCCUPATIONS)) {
      const msg = buildOnboardingFirstMessage(occ);
      expect(msg.startsWith('はじめまして！HARUKA FILMの髙橋です。')).toBe(true);
      expect(msg).toContain('MT（30分ほど・Google Meet）');
      expect(msg).toContain('・〇月〇日(〇)〇〇時〜');
      expect(msg).toContain('あわせて、MTまでに下記のご対応をお願いします。');
      expect(msg).toContain('・Chatwork・Slackの二段階認証設定');
      expect(msg).toContain('・個人情報フォームへの回答');
    }
  });

  test('動画クリエイターのみ「HARUKA FILM契約書の提出」を含む', () => {
    expect(buildOnboardingFirstMessage('video_creator')).toContain('・HARUKA FILM契約書の提出');
    expect(buildOnboardingFirstMessage('designer')).not.toContain('HARUKA FILM契約書');
  });

  test('不正な職種は throw', () => {
    expect(() => buildOnboardingFirstMessage('secretary')).toThrow(/不正な職種/);
  });
});

describe('テンプレ定義の健全性', () => {
  test('task_key はテンプレ内で一意', () => {
    const keys = ONBOARDING_TASK_TEMPLATE.map(t => t.task_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('occupations 指定があるものは既知の職種のみ参照する', () => {
    for (const t of ONBOARDING_TASK_TEMPLATE) {
      for (const occ of t.occupations || []) {
        expect(Object.keys(ONBOARDING_OCCUPATIONS)).toContain(occ);
      }
    }
  });
});

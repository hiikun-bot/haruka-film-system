// 素材広場ガード（ADR 039 D2）: 単価計算・JST 境界の単体テスト
jest.mock('../supabase', () => ({}));

const guards = require('../lib/video-organization/guards');

describe('estimateCostJpy', () => {
  const OLD = process.env.USD_JPY_RATE;
  beforeAll(() => { process.env.USD_JPY_RATE = '150'; });
  afterAll(() => { if (OLD === undefined) delete process.env.USD_JPY_RATE; else process.env.USD_JPY_RATE = OLD; });

  test('Flash: 音声トークンは音声単価、思考トークンは出力に含める', () => {
    const r = guards.estimateCostJpy('gemini-3-flash-preview', {
      promptTokenCount: 43000,
      promptTokensDetails: [{ modality: 'VIDEO', tokenCount: 16000 }, { modality: 'AUDIO', tokenCount: 27000 }],
      candidatesTokenCount: 800, thoughtsTokenCount: 300, totalTokenCount: 44100,
    });
    expect(r.audioTokens).toBe(27000);
    expect(r.outputTokens).toBe(1100);
    expect(r.totalTokens).toBe(44100);
    expect(r.costJpy).toBeCloseTo(5.745, 3);
    expect(r.pricingKnown).toBe(true);
  });

  test('Pro: 3.1 pro は 2.00/12.00', () => {
    const r = guards.estimateCostJpy('gemini-3.1-pro-preview', { promptTokenCount: 1000, candidatesTokenCount: 100 });
    expect(r.costJpy).toBeCloseTo((1000 * 2 + 100 * 12) / 1e6 * 150, 3);
  });

  test('3.8 Flash: 2026 年中は 0.75/3.75、2027-01-01（JST）から 1.50/7.50', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 };
    const y2026 = guards.estimateCostJpy('gemini-3.8-flash', usage, new Date('2026-12-31T14:59:00Z'));
    expect(y2026.pricingKnown).toBe(true);
    expect(y2026.costJpy).toBeCloseTo((1000 * 0.75 + 200 * 3.75) / 1e6 * 150, 3);
    // JST 2027-01-01 00:01 = UTC 2026-12-31 15:01
    const y2027 = guards.estimateCostJpy('gemini-3.8-flash', usage, new Date('2026-12-31T15:01:00Z'));
    expect(y2027.costJpy).toBeCloseTo((1000 * 1.50 + 200 * 7.50) / 1e6 * 150, 3);
  });

  test('3 Flash preview と 3.8 Flash を取り違えない（prefix の境目）', () => {
    expect(guards.getModelPricing('gemini-3-flash-preview').input).toBe(0.50);
    expect(guards.getModelPricing('gemini-3.8-flash', new Date('2026-10-11T00:00:00Z')).input).toBe(0.75);
    expect(guards.getModelPricing('gemini-3.5-flash-lite').output).toBe(2.50);
  });

  test('未設定時の既定モデルは 3.8 Flash', () => {
    const old = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    expect(guards.getModelName()).toBe('gemini-3.8-flash');
    if (old !== undefined) process.env.GEMINI_MODEL = old;
  });

  test('未知モデルは Pro 単価で安全側', () => {
    const r = guards.estimateCostJpy('gemini-9-ultra', { promptTokenCount: 1000, candidatesTokenCount: 100 });
    expect(r.pricingKnown).toBe(false);
    expect(r.costJpy).toBeCloseTo(0.48, 3);
  });

  test('usage が無くても 0 円で落ちない', () => {
    const r = guards.estimateCostJpy('gemini-3-flash-preview', null);
    expect(r.costJpy).toBe(0);
  });
});

describe('JST 境界', () => {
  test('日次: 2026-09-13T14:59Z は JST 9/13、15:01Z は JST 9/14', () => {
    expect(guards.jstDayStartIso(new Date('2026-09-13T14:59:00Z'))).toBe('2026-09-12T15:00:00.000Z');
    expect(guards.jstDayStartIso(new Date('2026-09-13T15:01:00Z'))).toBe('2026-09-13T15:00:00.000Z');
    expect(guards.jstNextDayStartIso(new Date('2026-09-13T15:01:00Z'))).toBe('2026-09-14T15:00:00.000Z');
  });
  test('月次: 9/30 23:59 JST は 9 月、10/1 0:01 JST は 10 月', () => {
    expect(guards.jstMonthStartIso(new Date('2026-09-30T14:59:00Z'))).toBe('2026-08-31T15:00:00.000Z');
    expect(guards.jstMonthStartIso(new Date('2026-09-30T15:01:00Z'))).toBe('2026-09-30T15:00:00.000Z');
    expect(guards.jstNextMonthStartIso(new Date('2026-12-15T00:00:00Z'))).toBe('2026-12-31T15:00:00.000Z');
  });
});

describe('予算モード切替', () => {
  const OLD = process.env.MONTHLY_ANALYSIS_BUDGET_JPY;
  afterAll(() => { if (OLD === undefined) delete process.env.MONTHLY_ANALYSIS_BUDGET_JPY; else process.env.MONTHLY_ANALYSIS_BUDGET_JPY = OLD; });
  test('未設定なら daily、設定すれば budget', () => {
    delete process.env.MONTHLY_ANALYSIS_BUDGET_JPY;
    expect(guards.isBudgetMode()).toBe(false);
    process.env.MONTHLY_ANALYSIS_BUDGET_JPY = '3000';
    expect(guards.isBudgetMode()).toBe(true);
    expect(guards.getMonthlyBudgetJpy()).toBe(3000);
  });
});

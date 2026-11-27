// utils/prod-db-guard.js — 手元から本番DBを向いていないかの判定（docs/dev-db-setup.md）
// 本番の ref はテスト用の架空の値（本物の ref はコードにもテストにも書かない）。

const {
  extractSupabaseProjectRef,
  getProdProjectRefs,
  isProdTarget,
  describeLocalProdDbRisk,
  warnIfLocalPointsToProd,
  assertNotProdTarget,
} = require('../utils/prod-db-guard');

const PROD = 'prodref0000000000001';
const DEV = 'devref00000000000002';

describe('extractSupabaseProjectRef', () => {
  test('API の URL', () => {
    expect(extractSupabaseProjectRef(`https://${PROD}.supabase.co`)).toBe(PROD);
    expect(extractSupabaseProjectRef(`https://${PROD}.supabase.co/rest/v1/`)).toBe(PROD);
  });
  test('Postgres 直結', () => {
    expect(extractSupabaseProjectRef(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`)).toBe(PROD);
  });
  test('プーラー（ユーザー名に ref）', () => {
    expect(extractSupabaseProjectRef(`postgres://postgres.${DEV}:p%40ss@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`)).toBe(DEV);
  });
  test('大文字・前後の空白は吸収', () => {
    expect(extractSupabaseProjectRef(`  https://${PROD.toUpperCase()}.supabase.co  `)).toBe(PROD);
  });
  test('ref そのもの', () => {
    expect(extractSupabaseProjectRef(PROD)).toBe(PROD);
  });
  test('Supabase 以外・空・壊れた値は null', () => {
    expect(extractSupabaseProjectRef('postgresql://postgres:pw@localhost:5432/postgres')).toBeNull();
    expect(extractSupabaseProjectRef('https://example.com')).toBeNull();
    expect(extractSupabaseProjectRef('')).toBeNull();
    expect(extractSupabaseProjectRef(undefined)).toBeNull();
    expect(extractSupabaseProjectRef('not a url')).toBeNull();
    expect(extractSupabaseProjectRef(`postgres://postgres:pw@aws-0-x.pooler.supabase.com:6543/postgres`)).toBeNull();
  });
});

describe('getProdProjectRefs / isProdTarget', () => {
  test('PROD_SUPABASE_PROJECT_REF（カンマ区切り）と PROD_SUPABASE_URL の両方から集める', () => {
    const refs = getProdProjectRefs({ PROD_SUPABASE_PROJECT_REF: ` ${PROD} , other00000001 `, PROD_SUPABASE_URL: 'https://third0000001.supabase.co' });
    expect([...refs].sort()).toEqual(['other00000001', PROD, 'third0000001'].sort());
  });
  test('本番 ref 未設定なら常に false', () => {
    expect(isProdTarget(`https://${PROD}.supabase.co`, {})).toBe(false);
  });
  test('一致すれば true・開発は false', () => {
    const env = { PROD_SUPABASE_PROJECT_REF: PROD };
    expect(isProdTarget(`https://${PROD}.supabase.co`, env)).toBe(true);
    expect(isProdTarget(`https://${DEV}.supabase.co`, env)).toBe(false);
    expect(isProdTarget('postgresql://postgres@localhost/postgres', env)).toBe(false);
  });
});

describe('describeLocalProdDbRisk', () => {
  const base = { PROD_SUPABASE_PROJECT_REF: PROD };
  test('NODE_ENV=production（Railway）では判定しない', () => {
    const r = describeLocalProdDbRisk({ ...base, NODE_ENV: 'production', SUPABASE_URL: `https://${PROD}.supabase.co` });
    expect(r.checked).toBe(false);
    expect(r.pointsToProd).toBe(false);
  });
  test('本番 ref 未設定なら判定しない', () => {
    const r = describeLocalProdDbRisk({ SUPABASE_URL: `https://${PROD}.supabase.co` });
    expect(r.checked).toBe(false);
  });
  test('SUPABASE_URL / DATABASE_URL のどれが本番かを返す', () => {
    const r = describeLocalProdDbRisk({
      ...base,
      SUPABASE_URL: `https://${PROD}.supabase.co`,
      DATABASE_URL: `postgres://postgres.${PROD}:x@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
    });
    expect(r.pointsToProd).toBe(true);
    expect(r.matchedKeys).toEqual(['SUPABASE_URL', 'DATABASE_URL']);
    expect(r.suppressed).toBe(false);
  });
  test('開発DBなら pointsToProd=false', () => {
    const r = describeLocalProdDbRisk({ ...base, NODE_ENV: 'development', SUPABASE_URL: `https://${DEV}.supabase.co` });
    expect(r.checked).toBe(true);
    expect(r.pointsToProd).toBe(false);
  });
  test('ALLOW_PROD_DB_FROM_LOCAL=1 のときだけ suppressed', () => {
    const env = { ...base, SUPABASE_URL: `https://${PROD}.supabase.co` };
    expect(describeLocalProdDbRisk({ ...env, ALLOW_PROD_DB_FROM_LOCAL: '1' }).suppressed).toBe(true);
    expect(describeLocalProdDbRisk({ ...env, ALLOW_PROD_DB_FROM_LOCAL: 'true' }).suppressed).toBe(false);
  });
});

describe('warnIfLocalPointsToProd', () => {
  const mkLogger = () => ({ error: jest.fn(), warn: jest.fn() });
  test('本番向きなら大きな警告（error）を出す・止めない', () => {
    const logger = mkLogger();
    const r = warnIfLocalPointsToProd({ PROD_SUPABASE_PROJECT_REF: PROD, SUPABASE_URL: `https://${PROD}.supabase.co` }, logger);
    expect(r.pointsToProd).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls.map(c => c[0]).join('\n')).toContain('本番DB');
  });
  test('抑止中は 1 行の warn だけ', () => {
    const logger = mkLogger();
    warnIfLocalPointsToProd({ PROD_SUPABASE_PROJECT_REF: PROD, SUPABASE_URL: `https://${PROD}.supabase.co`, ALLOW_PROD_DB_FROM_LOCAL: '1' }, logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
  test('開発DBなら何も出さない', () => {
    const logger = mkLogger();
    warnIfLocalPointsToProd({ PROD_SUPABASE_PROJECT_REF: PROD, SUPABASE_URL: `https://${DEV}.supabase.co` }, logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('assertNotProdTarget（scripts/dev-db の入口）', () => {
  const env = { PROD_SUPABASE_PROJECT_REF: PROD };
  test('本番なら throw', () => {
    expect(() => assertNotProdTarget(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`, { env })).toThrow(/本番/);
  });
  test('本番 ref 未設定なら throw（判定できないので止める）', () => {
    expect(() => assertNotProdTarget(`https://${DEV}.supabase.co`, { env: {} })).toThrow(/PROD_SUPABASE_PROJECT_REF/);
  });
  test('接続先が空なら throw', () => {
    expect(() => assertNotProdTarget('', { env, label: 'DATABASE_URL' })).toThrow(/DATABASE_URL/);
  });
  test('開発・ローカルは通る', () => {
    expect(assertNotProdTarget(`https://${DEV}.supabase.co`, { env })).toEqual({ ref: DEV });
    expect(assertNotProdTarget('postgresql://postgres@localhost:5432/postgres', { env })).toEqual({ ref: null });
  });
});

describe('buildProdDbWarningLines', () => {
  const { buildProdDbWarningLines } = require('../utils/prod-db-guard');
  test('DATABASE_URL が本番のときだけ schema-sync の注意を足す', () => {
    expect(buildProdDbWarningLines(['SUPABASE_URL']).join('\n')).not.toContain('schema-sync');
    expect(buildProdDbWarningLines(['SUPABASE_URL', 'DATABASE_URL']).join('\n')).toContain('schema-sync');
  });
});

// scripts/dev-db/lib.js・seed-data.js の純関数（docs/dev-db-setup.md）

const lib = require('../scripts/dev-db/lib');
const { buildSeedPlan, seedId, jstPrevMonth, jstDate, SEED_EMAIL_DOMAIN } = require('../scripts/dev-db/seed-data');

const PROD = 'prodref0000000000001';
const DEV = 'devref00000000000002';

describe('stripPsqlMetaCommands', () => {
  test('pg_dump の \\restrict / \\unrestrict 行を消す・SQL は残す', () => {
    const sql = '\\restrict abc\nCREATE TABLE public.t (id int);\n\\unrestrict abc\n';
    expect(lib.stripPsqlMetaCommands(sql)).toBe('CREATE TABLE public.t (id int);\n');
  });
  test('文字列中のバックスラッシュ（行頭でない）は触らない', () => {
    const sql = "SELECT E'a\\\\b';";
    expect(lib.stripPsqlMetaCommands(sql)).toBe(sql);
  });
});

describe('findDataStatements', () => {
  const split = sql => lib.splitSqlStatements(sql);
  test('スキーマのみなら 0 件（関数本体の INSERT は数えない）', () => {
    const sql = `
      CREATE TABLE public.t (id int);
      CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.t VALUES (1); RETURN NEW; END; $$;
      -- INSERT INTO comment only
      ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);`;
    expect(lib.findDataStatements(split(sql))).toEqual([]);
  });
  test('COPY ... FROM stdin と文頭 INSERT を見つける', () => {
    const sql = 'COPY public.users (id) FROM stdin;\n-- note\nINSERT INTO public.t VALUES (1);';
    expect(lib.findDataStatements(split(sql)).map(h => h.kind)).toEqual(['COPY', 'INSERT']);
  });
});

describe('leadingKeyword / isBenignSqlError / parseArgs / maskDbUrl', () => {
  test('コメントを飛ばして先頭キーワード', () => {
    expect(lib.leadingKeyword('/* x */ -- y\n  insert into t values (1)')).toBe('INSERT');
  });
  test('既にある系のエラーは無害扱い', () => {
    expect(lib.isBenignSqlError('relation "users" already exists')).toBe(true);
    expect(lib.isBenignSqlError('relation "users" does not exist')).toBe(false);
  });
  test('引数', () => {
    expect(lib.parseArgs(['--yes', '--from-dump=/a/b.sql', 'x'])).toEqual({ _: ['x'], yes: true, 'from-dump': '/a/b.sql' });
  });
  test('パスワードを伏せる', () => {
    expect(lib.maskDbUrl(`postgresql://postgres.${DEV}:secret@aws-0-x.pooler.supabase.com:5432/postgres`)).not.toContain('secret');
  });
});

describe('resolveDevDatabaseUrl（本番ガード）', () => {
  const prodDb = `postgresql://postgres.${PROD}:x@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
  const devDb = `postgresql://postgres.${DEV}:x@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
  test('DATABASE_URL が本番なら throw', () => {
    expect(() => lib.resolveDevDatabaseUrl({ PROD_SUPABASE_PROJECT_REF: PROD, DATABASE_URL: prodDb })).toThrow(/本番/);
  });
  test('DEV_DATABASE_URL が優先される', () => {
    const r = lib.resolveDevDatabaseUrl({ PROD_SUPABASE_PROJECT_REF: PROD, DATABASE_URL: prodDb, DEV_DATABASE_URL: devDb });
    expect(r).toMatchObject({ label: 'DEV_DATABASE_URL', ref: DEV });
  });
  test('DB は開発でも SUPABASE_URL が本番なら throw', () => {
    expect(() => lib.resolveDevDatabaseUrl({ PROD_SUPABASE_PROJECT_REF: PROD, DATABASE_URL: devDb, SUPABASE_URL: `https://${PROD}.supabase.co` })).toThrow(/SUPABASE_URL/);
  });
  test('本番 ref 未設定なら throw', () => {
    expect(() => lib.resolveDevDatabaseUrl({ DATABASE_URL: devDb })).toThrow(/PROD_SUPABASE_PROJECT_REF/);
  });
});

describe('seed-data', () => {
  const roleIds = { admin: 'r-admin', secretary: 'r-sec', producer: 'r-p', director: 'r-d', editor: 'r-e', designer: 'r-ds', external_director: 'r-ext' };
  const categoryIds = { video: 'c-video', image: 'c-image' };
  const plan = buildSeedPlan({ passwordHash: 'HASH', roleIds, categoryIds, now: new Date('2026-01-05T00:30:00Z') });
  const rowsOf = t => plan.filter(s => s.table === t && s.rows).flatMap(s => s.rows);

  test('全員 example.com・架空の名前', () => {
    const users = rowsOf('users');
    expect(users.length).toBeGreaterThanOrEqual(8);
    users.forEach(u => {
      expect(u.email.endsWith(`@${SEED_EMAIL_DOMAIN}`)).toBe(true);
      expect(u.full_name.startsWith('テスト')).toBe(true);
    });
    expect(new Set(users.map(u => u.email)).size).toBe(users.length);
  });
  test('各ロールがそろう', () => {
    expect(new Set(rowsOf('users').map(u => u.role))).toEqual(new Set(['admin', 'secretary', 'producer', 'director', 'producer_director', 'editor', 'designer', 'external_director']));
  });
  test('外部キーの順: 参照先が先に出てくる', () => {
    const order = plan.map(s => s.table);
    const before = (a, b) => expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before('users', 'teams');
    before('clients', 'projects');
    before('projects', 'project_estimate_lines');
    before('project_estimate_lines', 'project_estimate_line_costs');
    before('project_estimate_lines', 'creatives');
    before('creatives', 'creative_assignments');
    before('invoices', 'invoice_items');
    before('creatives', 'invoice_items');
  });
  test('参照している ID はすべて seed 内に存在する', () => {
    const ids = new Set(plan.filter(s => s.rows).flatMap(s => s.rows.map(r => r.id)));
    const refCols = ['client_id', 'project_id', 'line_id', 'creative_id', 'invoice_id', 'team_id', 'user_id', 'producer_id', 'director_id', 'issuer_id'];
    plan.filter(s => s.rows).forEach(s => s.rows.forEach(r => refCols.forEach(c => {
      if (r[c]) expect(ids.has(r[c])).toBe(true);
    })));
  });
  test('ID は固定（同じ入力なら同じ ID）', () => {
    const again = buildSeedPlan({ passwordHash: 'X', roleIds, categoryIds, now: new Date('2026-01-05T00:30:00Z') });
    expect(again.map(s => (s.rows || []).map(r => r.id))).toEqual(plan.map(s => (s.rows || []).map(r => r.id)));
    expect(seedId('user', 1)).toMatch(/^[0-9a-f]{8}-0000-4000-8000-0{11}1$/);
  });
  test('roles に無いロールは user_roles / 単価行から外す', () => {
    const p = buildSeedPlan({ passwordHash: 'H', roleIds: { admin: 'r-admin', editor: 'r-e' }, categoryIds });
    const ur = p.find(s => s.table === 'user_roles').rows;
    expect(ur.every(r => ['r-admin', 'r-e'].includes(r.role_id))).toBe(true);
    expect(p.find(s => s.table === 'project_estimate_line_costs').rows.every(r => r.role_id === 'r-e')).toBe(true);
  });
  test('先月は JST で数える（UTC だと 1/4 でも JST は 1/5）', () => {
    expect(jstDate(new Date('2026-01-04T16:00:00Z'))).toBe('2026-01-05');
    expect(jstPrevMonth(new Date('2026-01-05T00:30:00Z'))).toEqual({ year: 2025, month: 12 });
    expect(jstPrevMonth(new Date('2026-02-28T15:30:00Z'))).toEqual({ year: 2026, month: 2 }); // JST 3/1
    const inv = rowsOf('invoices');
    inv.forEach(i => expect([i.year, i.month]).toEqual([2025, 12]));
  });
});

// scripts/dev-db/seed-data.js — 開発用DBに入れるダミーデータ（純関数・テスト: tests/dev-db-scripts.test.js）
// =============================================================
// - 名前はすべて「テスト ◯◯」「（架空）」、メールは example.com。実在の人・会社は使わない。
// - ID は固定（何度流しても同じ行＝ON CONFLICT DO NOTHING で増えない）。
// - 外部キーの順に並べる: users → teams → (users.team_id 更新) → team_members → user_roles → clients → client_teams
//   → projects → project_estimate_lines → project_estimate_line_costs → creatives → creative_assignments
//   → invoices → invoice_items
// - roles / creative_categories は supabase_schema.sql の初期行を使う（ID は実行時に引いて渡す）。
// - 日付は JST 基準（「先月」＝日本時間の先月）。
// =============================================================

const SEED_EMAIL_DOMAIN = 'example.com';

/** 種類ごとに頭を変えた固定 UUID（v4 形式） */
function seedId(kind, n) {
  const prefixes = { user: 'd1', team: 'd2', client: 'd3', project: 'd4', line: 'd5', cost: 'd6', creative: 'd7', assign: 'd8', invoice: 'd9', item: 'da', userrole: 'db', member: 'dc', clientteam: 'dd' };
  const p = prefixes[kind];
  if (!p) throw new Error(`unknown seed kind: ${kind}`);
  return `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** JST の年月日（now から days 日ずらす）を 'YYYY-MM-DD' で */
function jstDate(now, days = 0) {
  const d = new Date(now.getTime() + days * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** JST の先月 { year, month } */
function jstPrevMonth(now) {
  const [y, m] = jstDate(now).split('-').map(Number);
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/** JST の 'YYYY-MM-DD' の正午を ISO（UTC）に */
function jstNoonIso(ymd) {
  return new Date(`${ymd}T12:00:00+09:00`).toISOString();
}

/**
 * @param {object} p
 * @param {string} p.passwordHash   bcrypt 済みパスワード（全員共通）
 * @param {Record<string,string>} p.roleIds      roles.code → id
 * @param {Record<string,string>} p.categoryIds  creative_categories.code → id（video / image）
 * @param {Date} [p.now]
 * @returns {Array<{ table: string, rows?: object[], updates?: Array<{ id: string, set: object }> }>}
 */
function buildSeedPlan({ passwordHash, roleIds, categoryIds, now = new Date() }) {
  const U = n => seedId('user', n);
  const users = [
    { n: 1, role: 'admin', name: 'テスト 管理者', nick: 'テスト管理者', roles: ['admin'] },
    { n: 2, role: 'secretary', name: 'テスト 秘書', nick: 'テスト秘書', roles: ['secretary'] },
    { n: 3, role: 'producer', name: 'テスト プロデューサー', nick: 'テストP', roles: ['producer'] },
    { n: 4, role: 'director', name: 'テスト ディレクター', nick: 'テストD', roles: ['director'] },
    { n: 5, role: 'producer_director', name: 'テスト 兼任PD', nick: 'テストPD', roles: ['producer', 'director'] },
    { n: 6, role: 'editor', name: 'テスト 太郎', nick: 'テスト太郎', roles: ['editor'] },
    { n: 7, role: 'editor', name: 'テスト 花子', nick: 'テスト花子', roles: ['editor'] },
    { n: 8, role: 'designer', name: 'テスト デザイナー', nick: 'テストデザ', roles: ['designer'] },
    { n: 9, role: 'external_director', name: 'テスト 外部ディレクター', nick: 'テスト外部D', roles: ['external_director'], external: 'サンプル代理店（架空）' },
  ];
  const userRows = users.map(u => ({
    id: U(u.n),
    email: `test-${u.role.replace(/_/g, '-')}${u.n === 7 ? '2' : ''}@${SEED_EMAIL_DOMAIN}`,
    full_name: u.name,
    nickname: u.nick,
    role: u.role,
    password_hash: u.external ? null : passwordHash,
    is_active: true,
    is_external: !!u.external,
    external_company: u.external || null,
    note: '開発用ダミー（scripts/dev-db/seed.js）',
  }));
  const userRoleRows = [];
  users.forEach(u => u.roles.forEach((code, i) => {
    if (!roleIds[code]) return; // roles マスタに無いロールは飛ばす（seed.js が警告）
    userRoleRows.push({ id: seedId('userrole', u.n * 10 + i), user_id: U(u.n), role_id: roleIds[code], scope_type: null, scope_id: null });
  }));

  const T1 = seedId('team', 1);
  const teams = [{ id: T1, team_code: 'TEST-D1', team_name: 'テスト ディレクターチーム', team_type: 'video', director_id: U(4), is_active: true }];
  const userTeamUpdates = [6, 7, 8].map(n => ({ id: U(n), set: { team_id: T1 } }));
  const teamMembers = [6, 7, 8].map((n, i) => ({ id: seedId('member', i + 1), team_id: T1, user_id: U(n) }));

  const CA = seedId('client', 1);
  const CB = seedId('client', 2);
  const clients = [
    { id: CA, name: 'テスト株式会社（架空）', client_code: 'TEST-A', note: '開発用ダミー', status: 'active' },
    { id: CB, name: 'サンプル商事（架空）', client_code: 'TEST-B', note: '開発用ダミー', status: 'active' },
  ];
  const clientTeams = [CA, CB].map((cid, i) => ({ id: seedId('clientteam', i + 1), client_id: cid, team_id: T1, sort_order: i }));

  const P1 = seedId('project', 1);
  const P2 = seedId('project', 2);
  const projects = [
    { id: P1, client_id: CA, name: 'テスト案件 縦型動画（架空）', status: '進行中', producer_id: U(3), director_id: U(4), start_date: jstDate(now, -40), primary_category_id: categoryIds.video || null },
    { id: P2, client_id: CB, name: 'サンプル案件 PR動画（架空）', status: '進行中', producer_id: U(5), director_id: U(5), start_date: jstDate(now, -20), primary_category_id: categoryIds.video || null },
  ];

  const L = n => seedId('line', n);
  const lines = [
    { id: L(1), project_id: P1, category_id: categoryIds.video || null, name: '縦型動画 15秒', planned_count: 6, client_unit_price: 30000, sort_order: 1, status: 'in_progress' },
    { id: L(2), project_id: P1, category_id: categoryIds.image || null, name: 'バナー静止画', planned_count: 4, client_unit_price: 8000, sort_order: 2, status: 'contracted' },
    { id: L(3), project_id: P2, category_id: categoryIds.video || null, name: 'PR動画 60秒', planned_count: 3, client_unit_price: 50000, sort_order: 1, status: 'in_progress' },
  ];
  const costDefs = [
    [1, L(1), 'editor', U(6), 15000],
    [2, L(1), 'director', U(4), 3000],
    [3, L(2), 'designer', U(8), 4000],
    [4, L(3), 'editor', U(7), 20000],
    [5, L(3), 'director', U(5), 5000],
  ];
  const lineCosts = costDefs
    .filter(([, , role]) => roleIds[role])
    .map(([n, line, role, user, price]) => ({ id: seedId('cost', n), line_id: line, role_id: roleIds[role], user_id: user, unit_price: price, pricing_type: 'fixed_per_unit' }));

  const prev = jstPrevMonth(now);
  const prevDay = `${prev.year}-${String(prev.month).padStart(2, '0')}-20`;
  const C = n => seedId('creative', n);
  const creatives = [
    { n: 1, p: P1, line: L(1), cat: 'video', type: 'video', name: 'TEST_縦型_001', status: '未着手', draft: 5, final: 12 },
    { n: 2, p: P1, line: L(1), cat: 'video', type: 'video', name: 'TEST_縦型_002', status: '制作中（初稿提出前）', draft: -1, final: 6 },
    { n: 3, p: P1, line: L(1), cat: 'video', type: 'video', name: 'TEST_縦型_003', status: '納品', delivered: prevDay, dir: U(4), prod: U(3) },
    { n: 4, p: P1, line: L(1), cat: 'video', type: 'video', name: 'TEST_縦型_004', status: '納品', delivered: prevDay, dir: U(4), prod: U(3) },
    { n: 5, p: P1, line: L(2), cat: 'image', type: 'design', name: 'TEST_バナー_001', status: '未着手', draft: 3, final: 8 },
    { n: 6, p: P2, line: L(3), cat: 'video', type: 'video', name: 'SAMPLE_PR_001', status: '納品', delivered: jstDate(now, -2), dir: U(5), prod: U(5) },
  ].map(c => ({
    id: C(c.n),
    project_id: c.p,
    line_id: c.line,
    category_id: categoryIds[c.cat] || null,
    file_name: c.name,
    creative_type: c.type,
    status: c.status,
    draft_deadline: c.draft != null ? jstDate(now, c.draft) : null,
    final_deadline: c.final != null ? jstDate(now, c.final) : (c.delivered || null),
    delivered_at: c.delivered ? jstNoonIso(c.delivered) : null,
    delivered_director_ids: c.dir ? [c.dir] : null,
    delivered_producer_ids: c.prod ? [c.prod] : null,
    note: '開発用ダミー',
  }));
  const assignDefs = [
    [1, C(1), U(6), 'editor'], [2, C(2), U(6), 'editor'], [3, C(3), U(6), 'editor'], [4, C(4), U(6), 'editor'],
    [5, C(5), U(8), 'designer'], [6, C(6), U(7), 'editor'],
    [7, C(1), U(4), 'director'], [8, C(2), U(4), 'director'], [9, C(3), U(4), 'director'], [10, C(4), U(4), 'director'],
    [11, C(5), U(4), 'director'], [12, C(6), U(5), 'director'],
  ];
  const assignments = assignDefs.map(([n, cr, user, role]) => ({ id: seedId('assign', n), creative_id: cr, user_id: user, role }));

  const I1 = seedId('invoice', 1);
  const I2 = seedId('invoice', 2);
  const invoices = [
    { id: I1, invoice_number: 'TEST-INV-0001', issuer_id: U(6), project_id: null, total_amount: 30000, status: 'submitted', invoice_type: 'member', year: prev.year, month: prev.month, tax_mode: 'inclusive', submitted_at: jstNoonIso(jstDate(now, -1)) },
    { id: I2, invoice_number: 'TEST-INV-0002', issuer_id: U(7), project_id: null, total_amount: 20000, status: 'draft', invoice_type: 'member', year: prev.year, month: prev.month, tax_mode: 'inclusive' },
  ];
  const items = [
    { id: seedId('item', 1), invoice_id: I1, creative_id: C(3), label: 'TEST_縦型_003', unit_price: 15000, quantity: 1, total_amount: 15000, sort_order: 1 },
    { id: seedId('item', 2), invoice_id: I1, creative_id: C(4), label: 'TEST_縦型_004', unit_price: 15000, quantity: 1, total_amount: 15000, sort_order: 2 },
    { id: seedId('item', 3), invoice_id: I2, creative_id: C(6), label: 'SAMPLE_PR_001', unit_price: 20000, quantity: 1, total_amount: 20000, sort_order: 1 },
  ];

  return [
    { table: 'users', rows: userRows },
    { table: 'teams', rows: teams },
    { table: 'users', updates: userTeamUpdates },
    { table: 'team_members', rows: teamMembers },
    { table: 'user_roles', rows: userRoleRows },
    { table: 'clients', rows: clients },
    { table: 'client_teams', rows: clientTeams },
    { table: 'projects', rows: projects },
    { table: 'project_estimate_lines', rows: lines },
    { table: 'project_estimate_line_costs', rows: lineCosts },
    { table: 'creatives', rows: creatives },
    { table: 'creative_assignments', rows: assignments },
    { table: 'invoices', rows: invoices },
    { table: 'invoice_items', rows: items },
  ];
}

module.exports = { SEED_EMAIL_DOMAIN, seedId, jstDate, jstPrevMonth, jstNoonIso, buildSeedPlan };

// 納品の取り消し: 実効ロールの集合 × 担当判定 の組み合わせ（ADR 015・最低 3 ロール）。
// utils/roles.js の roleCodesHavePermission / roleCodesMatchAny を本物で使い、role_permissions だけモックする。
jest.mock('../../supabase', () => {
  let rows = [];
  function makeBuilder() {
    const b = {
      select() { return b; }, eq() { return b; }, in() { return b; },
      then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
    };
    return b;
  }
  return { from: jest.fn(() => makeBuilder()), __setRows(r) { rows = r; } };
});

const supabase = require('../../supabase');
const roles = require('../../utils/roles');
const DR = require('../../utils/delivery-revert');

const now = new Date('2026-11-24T03:00:00Z');
const thisMonth = { status: '納品', delivered_at: '2026-11-20T01:00:00Z' };
const lastMonth = { status: '納品', delivered_at: '2026-10-20T01:00:00Z' };

async function decide(codes, { isLeader, creative = thisMonth }) {
  const canRevertAny = await DR.resolveCanRevertAny(codes, roles);
  return DR.decideDeliveryRevert({ creative, canRevertAny, isLeader, issuedInvoices: [], now });
}

beforeEach(() => {
  supabase.__setRows([]);
  roles.invalidatePermissionsCache();
});

describe('ロール別（権限行なし＝既定）', () => {
  test('admin: 担当外・先月分も戻せる', async () => {
    expect(await decide(['admin'], { isLeader: false, creative: lastMonth })).toMatchObject({ canRevert: true, scope: 'any' });
  });
  test('producer_director（producer＋director 兼任）: 担当外・先月分も戻せる', async () => {
    expect(await decide(['producer', 'director'], { isLeader: false, creative: lastMonth })).toMatchObject({ canRevert: true, scope: 'any' });
    expect(await decide(['producer_director'], { isLeader: false })).toMatchObject({ canRevert: true, scope: 'any' });
  });
  test('director: 担当なら今月分だけ・担当外は不可', async () => {
    expect(await decide(['director'], { isLeader: true })).toMatchObject({ canRevert: true, scope: 'own' });
    expect(await decide(['director'], { isLeader: true, creative: lastMonth })).toMatchObject({ canRevert: false, scope: 'own' });
    expect(await decide(['director'], { isLeader: false })).toMatchObject({ canRevert: false, scope: null });
  });
  test('producer 単独: 担当なら今月分だけ', async () => {
    expect(await decide(['producer'], { isLeader: true })).toMatchObject({ canRevert: true, scope: 'own' });
    expect(await decide(['producer'], { isLeader: false })).toMatchObject({ canRevert: false, scope: null });
  });
  test('editor / designer / secretary: 担当リーダーでなければ不可', async () => {
    for (const codes of [['editor'], ['designer'], ['secretary']]) {
      expect(await decide(codes, { isLeader: false })).toMatchObject({ canRevert: false, scope: null });
    }
  });
});

describe('権限管理で creative.delivery_revert_any を ON にしたロール', () => {
  test('secretary に ON → 担当外・先月分も戻せる', async () => {
    supabase.__setRows([{ role: 'secretary', permission_key: DR.DELIVERY_REVERT_ANY_KEY, allowed: true, role_id: null, roles: null }]);
    roles.invalidatePermissionsCache();
    expect(await decide(['secretary'], { isLeader: false, creative: lastMonth })).toMatchObject({ canRevert: true, scope: 'any' });
    expect(await decide(['editor'], { isLeader: false })).toMatchObject({ canRevert: false });
  });
});

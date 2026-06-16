// tests/utils/roles.test.js
// utils/roles.js (ADR 003) のユニットテスト。
// Supabase 依存は jest.mock でモックし、純粋関数はそのまま検証する。

// roles.js が require する '../supabase' をチェーン可能なモックに差し替える。
// from(table).select(...).eq/in(...) いずれの段階でも await できる thenable を返す。
jest.mock('../../supabase', () => {
  const responses = new Map(); // table -> { data, error }

  function getResponse(table) {
    return responses.get(table) || { data: [], error: null };
  }

  function makeBuilder(table) {
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      in() { return builder; },
      then(resolve, reject) {
        return Promise.resolve(getResponse(table)).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse(table, response) { responses.set(table, response); },
    __reset() { responses.clear(); },
  };
});

const supabase = require('../../supabase');
const roles = require('../../utils/roles');

beforeEach(() => {
  supabase.__reset();
  roles.invalidateRolesCache();
  roles.invalidatePermissionsCache();
  roles.invalidateUserRolesCache(); // user_id → codes 短TTLキャッシュも全クリア
  jest.spyOn(console, 'error').mockImplementation(() => {}); // エラーログを抑制
});

afterEach(() => {
  console.error.mockRestore();
});

// ---------- 純粋関数 ----------

describe('ROLE_LEVEL / getRoleLevel', () => {
  test('既存ロールの level マッピングを固定', () => {
    expect(roles.ROLE_LEVEL).toEqual({
      admin: 5,
      secretary: 4,
      producer: 3,
      producer_director: 3,
      director: 3,
      editor: 2,
      designer: 2,
      client: 1,
    });
  });

  test('未知コード / null は 0', () => {
    expect(roles.getRoleLevel('unknown')).toBe(0);
    expect(roles.getRoleLevel(null)).toBe(0);
    expect(roles.getRoleLevel('')).toBe(0);
  });
});

describe('getMaxRoleLevel', () => {
  test('複数コードの最大 level を返す', () => {
    expect(roles.getMaxRoleLevel(['editor', 'secretary'])).toBe(4);
    expect(roles.getMaxRoleLevel(['client'])).toBe(1);
  });

  test('producer_director は producer/director に展開して最大を取る（=3）', () => {
    expect(roles.getMaxRoleLevel(['producer_director'])).toBe(3);
  });

  test('空配列 / 非配列は 0', () => {
    expect(roles.getMaxRoleLevel([])).toBe(0);
    expect(roles.getMaxRoleLevel(null)).toBe(0);
  });
});

describe('pickPrimaryRoleCode', () => {
  test('admin が最優先', () => {
    expect(roles.pickPrimaryRoleCode(['editor', 'admin'])).toBe('admin');
  });

  test('次に secretary', () => {
    expect(roles.pickPrimaryRoleCode(['editor', 'secretary'])).toBe('secretary');
  });

  test('producer + director は合成値 producer_director', () => {
    expect(roles.pickPrimaryRoleCode(['producer', 'director'])).toBe('producer_director');
  });

  test('producer_director 単体もそのまま', () => {
    expect(roles.pickPrimaryRoleCode(['producer_director'])).toBe('producer_director');
  });

  test('それ以外は先頭要素（sort_order 昇順の先頭想定）', () => {
    expect(roles.pickPrimaryRoleCode(['director', 'editor'])).toBe('director');
  });

  test('空 / 非配列は null', () => {
    expect(roles.pickPrimaryRoleCode([])).toBeNull();
    expect(roles.pickPrimaryRoleCode(null)).toBeNull();
  });
});

describe('roleCodesMatchAny', () => {
  test('単純包含で true', () => {
    expect(roles.roleCodesMatchAny(['editor'], ['editor', 'admin'])).toBe(true);
  });

  test('包含なしは false', () => {
    expect(roles.roleCodesMatchAny(['editor'], ['admin'])).toBe(false);
  });

  test('allowed に producer_director があり producer+director 両方持ちなら true', () => {
    expect(roles.roleCodesMatchAny(['producer', 'director'], ['producer_director'])).toBe(true);
    expect(roles.roleCodesMatchAny(['producer'], ['producer_director'])).toBe(false);
  });

  test('合成値 producer_director 持ちは producer / director どちらの allowed にもマッチ', () => {
    expect(roles.roleCodesMatchAny(['producer_director'], ['producer'])).toBe(true);
    expect(roles.roleCodesMatchAny(['producer_director'], ['director'])).toBe(true);
    expect(roles.roleCodesMatchAny(['producer_director'], ['editor'])).toBe(false);
  });

  test('userCodes / allowedCodes が空なら false（admin でも自動 true にしない）', () => {
    expect(roles.roleCodesMatchAny([], ['admin'])).toBe(false);
    expect(roles.roleCodesMatchAny(['admin'], [])).toBe(false);
    expect(roles.roleCodesMatchAny(null, ['admin'])).toBe(false);
  });
});

describe('VALID_PREVIEW_ROLES', () => {
  test('X-View-As 許可ロールの集合を固定（client は含まない）', () => {
    expect(Array.from(roles.VALID_PREVIEW_ROLES).sort()).toEqual([
      'admin', 'designer', 'director', 'editor',
      'producer', 'producer_director', 'secretary',
    ].sort());
    expect(roles.VALID_PREVIEW_ROLES.has('client')).toBe(false);
  });
});

// ---------- Supabase 依存（モック） ----------

describe('getUserRoleCodes', () => {
  test('userId なしは空配列（クエリ発行なし）', async () => {
    expect(await roles.getUserRoleCodes(null)).toEqual([]);
  });

  test('sort_order 昇順 + 重複除去でコード配列を返す', async () => {
    supabase.__setResponse('user_roles', {
      data: [
        { role_id: 'r2', roles: { code: 'director', sort_order: 2 } },
        { role_id: 'r1', roles: { code: 'admin', sort_order: 1 } },
        { role_id: 'r2b', roles: { code: 'director', sort_order: 2 } }, // 重複
        { role_id: 'rx', roles: null },                                  // JOIN 欠け
      ],
      error: null,
    });
    expect(await roles.getUserRoleCodes('u1')).toEqual(['admin', 'director']);
  });

  test('クエリエラー時は空配列', async () => {
    supabase.__setResponse('user_roles', { data: null, error: { message: 'boom' } });
    expect(await roles.getUserRoleCodes('u1')).toEqual([]);
  });
});

describe('getUserRoleCodes の短TTLキャッシュ', () => {
  const editorRow = { data: [{ roles: { code: 'editor', sort_order: 1 } }], error: null };
  const adminRow  = { data: [{ roles: { code: 'admin',  sort_order: 1 } }], error: null };

  test('TTL 内の同一 userId は再クエリしない', async () => {
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    const callsAfterFirst = supabase.from.mock.calls.length;
    // DB 側を書き換えても TTL 内はキャッシュ値が返る（=クエリ回数が増えない）
    supabase.__setResponse('user_roles', adminRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    expect(supabase.from.mock.calls.length).toBe(callsAfterFirst);
  });

  test('userId ごとに独立してキャッシュされる', async () => {
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    supabase.__setResponse('user_roles', adminRow);
    expect(await roles.getUserRoleCodes('u2')).toEqual(['admin']); // 別 userId は新規クエリ
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']); // u1 はキャッシュ維持
  });

  test('invalidateUserRolesCache(userId) で当該ユーザーのみ即時無効化', async () => {
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    expect(await roles.getUserRoleCodes('u2')).toEqual(['editor']);
    supabase.__setResponse('user_roles', adminRow);
    roles.invalidateUserRolesCache('u1');
    expect(await roles.getUserRoleCodes('u1')).toEqual(['admin']);  // 再クエリされる
    expect(await roles.getUserRoleCodes('u2')).toEqual(['editor']); // u2 はキャッシュのまま
  });

  test('引数なし invalidateUserRolesCache() は全クリア', async () => {
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    supabase.__setResponse('user_roles', adminRow);
    roles.invalidateUserRolesCache();
    expect(await roles.getUserRoleCodes('u1')).toEqual(['admin']);
  });

  test('クエリエラーはキャッシュしない（復旧後に正しい値へ戻る）', async () => {
    supabase.__setResponse('user_roles', { data: null, error: { message: 'boom' } });
    expect(await roles.getUserRoleCodes('u1')).toEqual([]);
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']); // エラー結果が残らない
  });

  test('空配列（user_roles 未移行ユーザー）もキャッシュされる', async () => {
    supabase.__setResponse('user_roles', { data: [], error: null });
    expect(await roles.getUserRoleCodes('u1')).toEqual([]);
    const callsAfterFirst = supabase.from.mock.calls.length;
    expect(await roles.getUserRoleCodes('u1')).toEqual([]);
    expect(supabase.from.mock.calls.length).toBe(callsAfterFirst);
  });

  test('X-View-As プレビュー（getEffectiveRoleCodes）はキャッシュに乗らない・汚染しない', async () => {
    // 実ロール editor をキャッシュ
    supabase.__setResponse('user_roles', editorRow);
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
    // 最高管理者の view-as はキャッシュ手前で分岐して preview ロールを返す
    const req = { user: { id: 'u1', role: 'admin' }, headers: { 'x-view-as': 'designer' } };
    const codes = await roles.getEffectiveRoleCodes(req, { isSuperAdminUser: () => true });
    expect(codes).toEqual(['designer']);
    // 実ロールのキャッシュは無傷
    expect(await roles.getUserRoleCodes('u1')).toEqual(['editor']);
  });
});

describe('userHasRole / isProducerDirector', () => {
  test('userHasRole は保有コードの includes 判定', async () => {
    supabase.__setResponse('user_roles', {
      data: [{ roles: { code: 'editor', sort_order: 1 } }],
      error: null,
    });
    expect(await roles.userHasRole('u1', 'editor')).toBe(true);
    expect(await roles.userHasRole('u1', 'admin')).toBe(false);
    expect(await roles.userHasRole(null, 'editor')).toBe(false);
    expect(await roles.userHasRole('u1', null)).toBe(false);
  });

  test('isProducerDirector は producer と director の両方保有で true', async () => {
    supabase.__setResponse('user_roles', {
      data: [
        { roles: { code: 'producer', sort_order: 1 } },
        { roles: { code: 'director', sort_order: 2 } },
      ],
      error: null,
    });
    expect(await roles.isProducerDirector('u1')).toBe(true);

    // 短TTLキャッシュ導入後は、同一 userId のロール変更を即時反映させるには
    // invalidateUserRolesCache を呼ぶ（本番では user_roles 書き換え箇所が呼ぶ）
    roles.invalidateUserRolesCache('u1');
    supabase.__setResponse('user_roles', {
      data: [{ roles: { code: 'producer', sort_order: 1 } }],
      error: null,
    });
    expect(await roles.isProducerDirector('u1')).toBe(false);
  });
});

describe('getUsersRolesMap', () => {
  test('userId ごとのコード配列を Map で返す（該当なしは空配列）', async () => {
    supabase.__setResponse('user_roles', {
      data: [
        { user_id: 'u1', roles: { code: 'editor', sort_order: 2 } },
        { user_id: 'u1', roles: { code: 'admin', sort_order: 1 } },
        { user_id: 'u2', roles: null },
      ],
      error: null,
    });
    const map = await roles.getUsersRolesMap(['u1', 'u2', 'u1', null]);
    expect(map.get('u1')).toEqual(['admin', 'editor']);
    expect(map.get('u2')).toEqual([]);
  });

  test('空入力 / 非配列は空 Map', async () => {
    expect((await roles.getUsersRolesMap([])).size).toBe(0);
    expect((await roles.getUsersRolesMap(null)).size).toBe(0);
  });

  test('クエリエラー時は空 Map', async () => {
    supabase.__setResponse('user_roles', { data: null, error: { message: 'boom' } });
    expect((await roles.getUsersRolesMap(['u1'])).size).toBe(0);
  });
});

describe('getEffectiveRoleCodes', () => {
  test('req / req.user なしは空配列', async () => {
    expect(await roles.getEffectiveRoleCodes(null)).toEqual([]);
    expect(await roles.getEffectiveRoleCodes({})).toEqual([]);
  });

  test('最高管理者の X-View-As ヘッダを尊重する', async () => {
    const req = {
      user: { id: 'u1', role: 'admin' },
      headers: { 'x-view-as': 'editor' },
    };
    const codes = await roles.getEffectiveRoleCodes(req, { isSuperAdminUser: () => true });
    expect(codes).toEqual(['editor']);
  });

  test('X-View-As: producer_director は ["producer","director"] に展開', async () => {
    const req = {
      user: { id: 'u1', role: 'admin' },
      headers: { 'x-view-as': 'Producer_Director' }, // 大文字小文字は正規化される
    };
    const codes = await roles.getEffectiveRoleCodes(req, { isSuperAdminUser: () => true });
    expect(codes).toEqual(['producer', 'director']);
  });

  test('最高管理者でなければ X-View-As は無視して user_roles を読む', async () => {
    supabase.__setResponse('user_roles', {
      data: [{ roles: { code: 'editor', sort_order: 1 } }],
      error: null,
    });
    const req = {
      user: { id: 'u1', role: 'editor' },
      headers: { 'x-view-as': 'admin' },
    };
    const codes = await roles.getEffectiveRoleCodes(req, { isSuperAdminUser: () => false });
    expect(codes).toEqual(['editor']);
  });

  test('user_roles が空なら dual-read fallback で users.role を返す', async () => {
    supabase.__setResponse('user_roles', { data: [], error: null });
    const req = { user: { id: 'u1', role: 'secretary' }, headers: {} };
    expect(await roles.getEffectiveRoleCodes(req)).toEqual(['secretary']);
  });

  test('fallback の users.role が producer_director なら展開される', async () => {
    supabase.__setResponse('user_roles', { data: [], error: null });
    const req = { user: { id: 'u1', role: 'producer_director' }, headers: {} };
    expect(await roles.getEffectiveRoleCodes(req)).toEqual(['producer', 'director']);
  });

  test('user_roles も users.role も無ければ空配列', async () => {
    supabase.__setResponse('user_roles', { data: [], error: null });
    const req = { user: { id: 'u1' }, headers: {} };
    expect(await roles.getEffectiveRoleCodes(req)).toEqual([]);
  });
});

describe('loadRoles / getRolesMap', () => {
  test('roles テーブルから code/id の Map を作る', async () => {
    supabase.__setResponse('roles', {
      data: [
        { id: 'r1', code: 'admin', label: '管理者' },
        { id: 'r2', code: 'editor', label: '編集者' },
      ],
      error: null,
    });
    const byCode = await roles.getRolesMap();
    expect(byCode.get('admin').id).toBe('r1');
    expect(byCode.get('editor').label).toBe('編集者');
  });

  test('TTL 内はキャッシュを返す（再クエリしない）', async () => {
    supabase.__setResponse('roles', {
      data: [{ id: 'r1', code: 'admin' }],
      error: null,
    });
    await roles.getRolesMap();
    const callsAfterFirst = supabase.from.mock.calls.length;
    await roles.getRolesMap();
    expect(supabase.from.mock.calls.length).toBe(callsAfterFirst);
  });

  test('ロード失敗時は前回成功時のキャッシュを温存する（throw しない）', async () => {
    supabase.__setResponse('roles', {
      data: [{ id: 'r1', code: 'admin' }],
      error: null,
    });
    await roles.getRolesMap();
    roles.invalidateRolesCache();
    supabase.__setResponse('roles', { data: null, error: { message: 'down' } });
    const byCode = await roles.getRolesMap();
    expect(byCode.get('admin').id).toBe('r1'); // 古いキャッシュが残る
  });

  test('一度も成功していない状態でのロード失敗は空 Map（throw しない）', async () => {
    jest.resetModules();
    const freshSupabase = require('../../supabase'); // jest.mock により再生成されたモック
    freshSupabase.__setResponse('roles', { data: null, error: { message: 'down' } });
    const freshRoles = require('../../utils/roles');
    const byCode = await freshRoles.getRolesMap();
    expect(byCode.size).toBe(0);
  });
});

describe('roleCodesHavePermission', () => {
  function setPerms(rows) {
    supabase.__setResponse('role_permissions', { data: rows, error: null });
  }

  test('admin を含めば role_permissions を見ずに常に true', async () => {
    setPerms([]);
    expect(await roles.roleCodesHavePermission(['admin'], 'projects.delete')).toBe(true);
  });

  test('allowed=true の行があるロールは true', async () => {
    setPerms([
      { role: null, role_id: 'r1', roles: { code: 'editor' }, permission_key: 'creatives.edit', allowed: true },
    ]);
    expect(await roles.roleCodesHavePermission(['editor'], 'creatives.edit')).toBe(true);
    expect(await roles.roleCodesHavePermission(['editor'], 'projects.delete')).toBe(false);
  });

  test('allowed=false は false', async () => {
    setPerms([
      { role: null, role_id: 'r1', roles: { code: 'editor' }, permission_key: 'creatives.edit', allowed: false },
    ]);
    expect(await roles.roleCodesHavePermission(['editor'], 'creatives.edit')).toBe(false);
  });

  test('旧 TEXT 行（role 列）でも引ける', async () => {
    setPerms([
      { role: 'director', role_id: null, roles: null, permission_key: 'projects.view', allowed: true },
    ]);
    expect(await roles.roleCodesHavePermission(['director'], 'projects.view')).toBe(true);
  });

  test('producer / director 保有者には producer_director TEXT 行の許可も適用', async () => {
    setPerms([
      { role: 'producer_director', role_id: null, roles: null, permission_key: 'invoices.view', allowed: true },
    ]);
    expect(await roles.roleCodesHavePermission(['producer'], 'invoices.view')).toBe(true);
    expect(await roles.roleCodesHavePermission(['director'], 'invoices.view')).toBe(true);
    expect(await roles.roleCodesHavePermission(['editor'], 'invoices.view')).toBe(false);
  });

  test('producer_director を直接渡すと producer+director に展開して判定', async () => {
    setPerms([
      { role: null, role_id: 'r1', roles: { code: 'producer' }, permission_key: 'invoices.view', allowed: true },
    ]);
    expect(await roles.roleCodesHavePermission(['producer_director'], 'invoices.view')).toBe(true);
  });

  test('空 codes / key なしは false', async () => {
    expect(await roles.roleCodesHavePermission([], 'x')).toBe(false);
    expect(await roles.roleCodesHavePermission(['editor'], null)).toBe(false);
  });
});

describe('userHasPermission', () => {
  test('user_roles から引いたコードで permission 判定する', async () => {
    supabase.__setResponse('user_roles', {
      data: [{ roles: { code: 'editor', sort_order: 1 } }],
      error: null,
    });
    supabase.__setResponse('role_permissions', {
      data: [
        { role: null, role_id: 'r1', roles: { code: 'editor' }, permission_key: 'creatives.edit', allowed: true },
      ],
      error: null,
    });
    expect(await roles.userHasPermission('u1', 'creatives.edit')).toBe(true);
    expect(await roles.userHasPermission('u1', 'projects.delete')).toBe(false);
  });

  test('ロール未保有ユーザーは false（フォールバックは呼び出し側責務）', async () => {
    supabase.__setResponse('user_roles', { data: [], error: null });
    expect(await roles.userHasPermission('u1', 'creatives.edit')).toBe(false);
  });

  test('userId / key なしは false', async () => {
    expect(await roles.userHasPermission(null, 'x')).toBe(false);
    expect(await roles.userHasPermission('u1', null)).toBe(false);
  });
});

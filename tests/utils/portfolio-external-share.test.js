const { PERM_PROP, grantPublicRead, revokePublicRead, grantPublicReadIfStillUsed } = require('../../utils/portfolio-external-share');

function mockDrive({ appProperties = {}, permissions = [], getError = null, deleteError = null, createError = null } = {}) {
  const state = { appProperties: { ...appProperties }, permissions: permissions.map(p => ({ ...p })) };
  const drive = {
    state,
    permissions: {
      create: jest.fn(async () => {
        if (createError) throw createError;
        const p = { id: 'anyoneWithLink', type: 'anyone', role: 'reader' };
        state.permissions.push(p);
        return { data: { id: p.id } };
      }),
      list: jest.fn(async () => ({ data: { permissions: state.permissions } })),
      delete: jest.fn(async ({ permissionId }) => {
        if (deleteError) throw deleteError;
        state.permissions = state.permissions.filter(p => p.id !== permissionId);
        return {};
      }),
    },
    files: {
      get: jest.fn(async () => { if (getError) throw getError; return { data: { id: 'f1', appProperties: state.appProperties } }; }),
      update: jest.fn(async ({ requestBody }) => {
        for (const [k, v] of Object.entries(requestBody.appProperties || {})) {
          if (v === null) delete state.appProperties[k]; else state.appProperties[k] = v;
        }
        return {};
      }),
    },
  };
  return drive;
}

describe('grantPublicRead', () => {
  test('anyone-reader を付けて、権限 ID をファイルに記録する', async () => {
    const drive = mockDrive({ appProperties: { hfs_kind: 'portfolio_external' } });
    const r = await grantPublicRead(drive, 'f1');
    expect(r).toEqual({ ok: true, permissionId: 'anyoneWithLink' });
    expect(drive.permissions.create.mock.calls[0][0].requestBody).toEqual({ role: 'reader', type: 'anyone' });
    expect(drive.state.appProperties[PERM_PROP]).toBe('anyoneWithLink');
  });
  test('付けられなければ ok:false（例外は投げない）', async () => {
    const drive = mockDrive({ createError: new Error('forbidden') });
    expect(await grantPublicRead(drive, 'f1')).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

describe('revokePublicRead', () => {
  test('記録した権限だけを外す（他の共有は残す）', async () => {
    const drive = mockDrive({
      appProperties: { hfs_kind: 'portfolio_external', [PERM_PROP]: 'anyoneWithLink' },
      permissions: [{ id: 'anyoneWithLink', type: 'anyone' }, { id: 'u1', type: 'user', role: 'writer' }, { id: 'd1', type: 'domain' }],
    });
    const r = await revokePublicRead(drive, 'f1');
    expect(r).toEqual({ ok: true, removed: ['anyoneWithLink'] });
    expect(drive.state.permissions.map(p => p.id)).toEqual(['u1', 'd1']);
    expect(drive.state.appProperties[PERM_PROP]).toBeUndefined();
  });
  test('記録の無い古い登録は、HFS が直送したファイルに限って anyone を外す', async () => {
    const drive = mockDrive({
      appProperties: { hfs_kind: 'portfolio_external' },
      permissions: [{ id: 'anyoneWithLink', type: 'anyone' }, { id: 'u1', type: 'user' }],
    });
    expect((await revokePublicRead(drive, 'f1')).removed).toEqual(['anyoneWithLink']);
    expect(drive.state.permissions.map(p => p.id)).toEqual(['u1']);
  });
  test('HFS が直送した印の無いファイルの共有には触らない', async () => {
    const drive = mockDrive({ permissions: [{ id: 'anyoneWithLink', type: 'anyone' }] });
    expect(await revokePublicRead(drive, 'f1')).toEqual({ ok: true, removed: [] });
    expect(drive.permissions.delete).not.toHaveBeenCalled();
  });
  test('ファイルが既に無い（404）なら ok', async () => {
    const e = new Error('not found'); e.code = 404;
    expect(await revokePublicRead(mockDrive({ getError: e }), 'f1')).toEqual({ ok: true, removed: [] });
  });
  test('外せなかったら ok:false（呼び出し側は削除を止める）', async () => {
    const e = new Error('backend'); e.code = 500;
    const drive = mockDrive({
      appProperties: { hfs_kind: 'portfolio_external', [PERM_PROP]: 'anyoneWithLink' },
      permissions: [{ id: 'anyoneWithLink', type: 'anyone' }],
      deleteError: e,
    });
    expect(await revokePublicRead(drive, 'f1')).toMatchObject({ ok: false, error: 'backend' });
  });
});

describe('grantPublicReadIfStillUsed（付与と削除が重なったとき）', () => {
  test('作品が残っていれば共有を付けたまま', async () => {
    const drive = mockDrive({ appProperties: { hfs_kind: 'portfolio_external' } });
    const r = await grantPublicReadIfStillUsed(drive, 'f1', async () => true);
    expect(r).toMatchObject({ ok: true, granted: true, revoked: false });
    expect(drive.state.permissions.map(p => p.id)).toEqual(['anyoneWithLink']);
  });
  test('付与のあいだに作品が削除されていたら、付けた共有を外す', async () => {
    const drive = mockDrive({ appProperties: { hfs_kind: 'portfolio_external' }, permissions: [{ id: 'owner1', type: 'user', role: 'owner' }] });
    const r = await grantPublicReadIfStillUsed(drive, 'f1', async () => false);
    expect(r).toMatchObject({ ok: true, granted: true, revoked: true });
    expect(drive.state.permissions.map(p => p.id)).toEqual(['owner1']);
    expect(drive.state.appProperties[PERM_PROP]).toBeUndefined();
  });
  test('残りの確認に失敗したら安全側で外す', async () => {
    const drive = mockDrive({ appProperties: { hfs_kind: 'portfolio_external' } });
    const check = jest.fn(async () => { throw new Error('db down'); });
    const r = await grantPublicReadIfStillUsed(drive, 'f1', check, { sleep: async () => {} });
    expect(check).toHaveBeenCalledTimes(3); // やり直してから諦める
    expect(r.revoked).toBe(true);
    expect(drive.state.permissions).toEqual([]);
  });
  test('確認の一時的な失敗はやり直し、生きている作品の共有は外さない', async () => {
    const drive = mockDrive({ appProperties: { hfs_kind: 'portfolio_external' } });
    let n = 0;
    const r = await grantPublicReadIfStillUsed(drive, 'f1', async () => { n += 1; if (n === 1) throw new Error('blip'); return true; }, { sleep: async () => {} });
    expect(r).toMatchObject({ ok: true, revoked: false });
    expect(drive.state.permissions.map(p => p.id)).toEqual(['anyoneWithLink']);
  });
  test('付与に失敗したら確認も解除もしない', async () => {
    const drive = mockDrive({ createError: new Error('forbidden') });
    const check = jest.fn(async () => true);
    expect(await grantPublicReadIfStillUsed(drive, 'f1', check)).toMatchObject({ ok: false, granted: false });
    expect(check).not.toHaveBeenCalled();
  });
});

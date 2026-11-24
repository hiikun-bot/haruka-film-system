// utils/creative-file-unshare.js（消えたクリエイティブのファイルの「リンクを知っている全員」を外す）の単体テスト。
// supabase はメモリ上の偽物（select / in / is / or の最小限）、Drive も偽物。
const U = require('../utils/creative-file-unshare');

const A = 'fileA_0123456789';
const B = 'fileB_0123456789';
const C = 'fileC_0123456789';
const D = 'fileD_0123456789';

function fakeSupabase(tables, { failTable = null } = {}) {
  return {
    from(table) {
      const filters = [];
      const b = {
        select() { return b; },
        in(k, vs) { filters.push(r => vs.includes(r[k])); return b; },
        is(k, v) { filters.push(r => (r[k] ?? null) === v); return b; },
        // 本物の or() の 2 形だけ解釈する: "<col>.in.(a,b)" / "<col>.ilike.*x*"
        or(expr) {
          const parts = String(expr).match(/[a-z_]+\.(?:in\.\([^)]*\)|ilike\.\*[^,]*\*)/g) || [];
          filters.push(r => parts.some(p => {
            const m1 = p.match(/^([a-z_]+)\.in\.\(([^)]*)\)$/);
            if (m1) return m1[2].split(',').includes(r[m1[1]]);
            const m2 = p.match(/^([a-z_]+)\.ilike\.\*(.*)\*$/);
            return m2 ? String(r[m2[1]] || '').toLowerCase().includes(m2[2].toLowerCase()) : false;
          }));
          return b;
        },
        then(res, rej) {
          if (failTable === table) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej);
          const rows = (tables[table] || []).filter(r => filters.every(f => f(r)));
          return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

function fakeDrive(perms) {
  const calls = { deleted: [] };
  const api = {
    permissions: {
      list: async ({ fileId }) => {
        if (!(fileId in perms)) { const e = new Error('not found'); e.code = 404; throw e; }
        if (perms[fileId] === 'error') { const e = new Error('rate limit'); e.code = 429; throw e; }
        return { data: { permissions: perms[fileId] } };
      },
      delete: async ({ fileId, permissionId }) => { calls.deleted.push(`${fileId}:${permissionId}`); return {}; },
    },
  };
  return { api, calls };
}

const quiet = { info: () => {}, warn: () => {} };

describe('collectDriveIds', () => {
  test('原本と高速化版を重複なしで集める', () => {
    expect(U.collectDriveIds([
      { drive_file_id: A, faststart_drive_file_id: B },
      { drive_file_id: A },
      { drive_file_id: null },
      null,
    ]).sort()).toEqual([A, B].sort());
  });
});

describe('revokeAnyoneReader', () => {
  test('ファイル自身に付いた anyone/reader だけを外す（引き継いだもの・ユーザー・編集権限は触らない）', async () => {
    const { api, calls } = fakeDrive({
      [A]: [
        { id: 'anyoneR', type: 'anyone', role: 'reader' },
        { id: 'anyoneW', type: 'anyone', role: 'writer' },
        { id: 'user1', type: 'user', role: 'reader' },
        { id: 'inherited', type: 'anyone', role: 'reader', permissionDetails: [{ inherited: true }] },
        { id: 'direct', type: 'anyone', role: 'reader', permissionDetails: [{ inherited: false }] },
      ],
    });
    const r = await U.revokeAnyoneReader(api, A);
    expect(r.ok).toBe(true);
    expect(calls.deleted.sort()).toEqual([`${A}:anyoneR`, `${A}:direct`].sort());
  });

  test('ファイルが無い（404）なら外す物が無いので ok', async () => {
    const { api } = fakeDrive({});
    const r = await U.revokeAnyoneReader(api, A);
    expect(r).toEqual({ ok: true, removed: [], gone: true });
  });

  test('Drive の失敗は ok:false で返す（throw しない）', async () => {
    const { api } = fakeDrive({ [A]: 'error' });
    const r = await U.revokeAnyoneReader(api, A);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rate limit/);
  });
});

describe('revokeSharingForRemovedFiles', () => {
  const anyone = [{ id: 'p1', type: 'anyone', role: 'reader' }];

  test('ほかで使っていないファイルだけ外す（他の行・高速化版・クライアント確認 URL・素材広場・外部作品は残す）', async () => {
    const E = 'fileE_0123456789';
    const F = 'fileF_0123456789';
    const G = 'fileG_0123456789';
    const tables = {
      creative_files: [{ drive_file_id: B }, { faststart_drive_file_id: C }],
      creatives: [{ client_review_url: `https://drive.google.com/file/d/${D}/view?usp=drivesdk` }],
      video_file_organization_tests: [{ drive_file_id: 'zzz', preview_drive_file_id: E }],
      portfolio_external_works: [{ drive_file_id: F, deleted_at: null }, { drive_file_id: G, deleted_at: '2026-11-01' }],
    };
    const { api, calls } = fakeDrive({ [A]: anyone, [B]: anyone, [C]: anyone, [D]: anyone, [E]: anyone, [F]: anyone, [G]: anyone });
    const revoked = [];
    const r = await U.revokeSharingForRemovedFiles({
      supabase: fakeSupabase(tables), getDrive: async () => api, logger: quiet,
      rows: [{ drive_file_id: A, faststart_drive_file_id: B }, { drive_file_id: C }, { drive_file_id: D }],
      driveIds: [E, F, G],
      reason: 'test', onRevoked: (id) => revoked.push(id),
    });
    expect(r.ok).toBe(true);
    // A と G（外部作品は削除済み）だけ外す
    expect(calls.deleted.sort()).toEqual([`${A}:p1`, `${G}:p1`].sort());
    expect(r.skippedInUse).toBe(5);
    expect(revoked.sort()).toEqual([A, G].sort());
  });

  test('使用中かの確認に失敗したら何も外さず、自動エラー通知を出す', async () => {
    const { api, calls } = fakeDrive({ [A]: anyone });
    const notes = [];
    const r = await U.revokeSharingForRemovedFiles({
      supabase: fakeSupabase({}, { failTable: 'creatives' }), getDrive: async () => api, logger: quiet,
      rows: [{ drive_file_id: A }], reason: 'test', notifyError: async (p) => notes.push(p),
    });
    expect(r.ok).toBe(false);
    expect(calls.deleted).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ source: 'server', kind: 'drive-unshare-failed' });
  });

  test('外部作品の表がまだ無い環境では、その確認だけ飛ばして続ける', async () => {
    const { api, calls } = fakeDrive({ [A]: anyone });
    const sb = fakeSupabase({});
    const orig = sb.from.bind(sb);
    sb.from = (t) => {
      if (t !== 'portfolio_external_works') return orig(t);
      const b = orig(t);
      b.then = (res, rej) => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "portfolio_external_works" does not exist' } }).then(res, rej);
      return b;
    };
    const r = await U.revokeSharingForRemovedFiles({ supabase: sb, getDrive: async () => api, logger: quiet, rows: [{ drive_file_id: A }], reason: 'test' });
    expect(r.ok).toBe(true);
    expect(calls.deleted).toEqual([`${A}:p1`]);
  });

  test('Drive で外せなかったファイルは通知し、ほかのファイルは外す（例外は投げない）', async () => {
    const { api, calls } = fakeDrive({ [A]: 'error', [B]: anyone });
    const notes = [];
    const r = await U.revokeSharingForRemovedFiles({
      supabase: fakeSupabase({}), getDrive: async () => api, logger: quiet,
      rows: [{ drive_file_id: A }, { drive_file_id: B }], reason: 'test', notifyError: async (p) => notes.push(p),
    });
    expect(r.ok).toBe(false);
    expect(r.failed.map(f => f.fileId)).toEqual([A]);
    expect(calls.deleted).toEqual([`${B}:p1`]);
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/DB の削除は完了済み/);
    expect(notes[0].stack).toContain(A);
  });

  test('Drive ID として不正な文字列は触らない（or() に埋め込まない）', async () => {
    const { api, calls } = fakeDrive({});
    const r = await U.revokeSharingForRemovedFiles({
      supabase: fakeSupabase({}), getDrive: async () => { throw new Error('呼ばれないはず'); }, logger: quiet,
      rows: [{ drive_file_id: 'bad,id),creatives.id.not.is.null' }], reason: 'test',
    });
    expect(r.ok).toBe(true);
    expect(r.skippedInUse).toBe(1);
    expect(calls.deleted).toEqual([]);
  });

  test('対象が無ければ何もしない', async () => {
    const r = await U.revokeSharingForRemovedFiles({ supabase: fakeSupabase({}), getDrive: async () => { throw new Error('x'); }, rows: [], reason: 'test' });
    expect(r).toMatchObject({ ok: true, checked: 0 });
  });
});

// tests/r2-playback.test.js
// R2 再生キャッシュ（lib/r2.js）のユニットテスト。
//
// 検証の柱（費用ガードが最重要）:
//   1. R2_PLAYBACK_ENABLED=true が明示されない限り、キーが揃っていても一切のR2処理が走らない
//      （キー存在チェックでの自動有効化は禁止 — 社内ルール）
//   2. 10GB 無料枠の予算ガード: 超過見込みなら sweep 試行 → それでも超えるなら複製スキップ
//   3. R2 ヒット時は署名URLを返し、ミス時（未複製/evicted/失敗）は null（=Driveフォールバック）
//   4. 納品遷移の排出（evictCreativeR2Replicas）で R2 オブジェクト削除 + r2_status='evicted'
//
// supabase.js は env 必須（欠落時 process.exit）のためモック。@aws-sdk / googleapis もモックし、
// 実 R2 への接続は行わない（アカウント未設定のため。実機確認手順は PR 本文参照）。

jest.mock('../supabase', () => {
  const state = { resolver: () => ({ data: null, error: null }), calls: [] };
  function createQuery(table) {
    const q = { table, calls: [] };
    ['select', 'eq', 'or', 'limit', 'order', 'not', 'update', 'insert', 'delete'].forEach((m) => {
      q[m] = (...args) => { q.calls.push([m, ...args]); return q; };
    });
    const resolve = () => Promise.resolve(state.resolver(q));
    q.maybeSingle = () => resolve();
    q.single = () => resolve();
    q.then = (onF, onR) => resolve().then(onF, onR);
    state.calls.push(q);
    return q;
  }
  return { from: jest.fn((table) => createQuery(table)), __state: state };
});

jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn(async () => ({}));
  return {
    __send: send,
    S3Client: jest.fn(() => ({ send })),
    GetObjectCommand: jest.fn(function (p) { this.__type = 'Get'; this.params = p; }),
    DeleteObjectCommand: jest.fn(function (p) { this.__type = 'Delete'; this.params = p; }),
    HeadObjectCommand: jest.fn(function (p) { this.__type = 'Head'; this.params = p; }),
  };
});

jest.mock('@aws-sdk/lib-storage', () => {
  const done = jest.fn(async () => ({}));
  return {
    __done: done,
    Upload: jest.fn(function (opts) { this.opts = opts; this.done = done; }),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://r2.example.com/creative-preview/x.mp4?sig=abc'),
}));

jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: jest.fn(function () {}) },
    drive: jest.fn(() => ({
      files: {
        get: jest.fn(async (params, opts) => {
          if (opts?.responseType === 'stream') return { data: { __stream: true } };
          return { data: { size: '104857600' } }; // 100MB
        }),
      },
    })),
  },
}));

const supabaseMock = require('../supabase');
const s3 = require('@aws-sdk/client-s3');
const libStorage = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const GB = 1024 * 1024 * 1024;
const ENV_KEYS = [
  'R2_PLAYBACK_ENABLED', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET', 'R2_BUDGET_BYTES', 'R2_SIGNED_URL_TTL_SECONDS', 'GOOGLE_SERVICE_ACCOUNT_KEY',
];
const envBackup = {};

function setR2Creds() {
  process.env.R2_ACCOUNT_ID = 'acct';
  process.env.R2_ACCESS_KEY_ID = 'key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  process.env.R2_BUCKET = 'haruka-playback';
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'sa@example.com', private_key: 'k' });
}

const r2 = require('../lib/r2');
beforeEach(() => {
  ENV_KEYS.forEach((k) => { envBackup[k] = process.env[k]; delete process.env[k]; });
  jest.clearAllMocks();
  supabaseMock.__state.resolver = () => ({ data: null, error: null });
  supabaseMock.__state.calls.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  });
  jest.restoreAllMocks();
});

describe('フラグゲート（R2_PLAYBACK_ENABLED）', () => {
  test('キーが全部揃っていてもフラグ未設定なら無効（自動有効化の禁止）', () => {
    setR2Creds();
    expect(r2.isEnabled()).toBe(false);
  });

  test('フラグ=true でもキー不足なら無効', () => {
    process.env.R2_PLAYBACK_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = 'acct'; // 他のキーは未設定
    expect(r2.isEnabled()).toBe(false);
  });

  test('フラグ=true + キー全部で有効', () => {
    process.env.R2_PLAYBACK_ENABLED = 'true';
    setR2Creds();
    expect(r2.isEnabled()).toBe(true);
  });

  test('フラグOFF時: replicate/sweep/evict/getPlaybackUrl が一切のR2コード・DBアクセスを実行しない', async () => {
    setR2Creds(); // フラグだけ無し

    const rep = await r2.replicateCreativeFileToR2('cf-1');
    expect(rep).toEqual({ skipped: true, reason: 'r2-disabled' });

    const swp = await r2.sweepDeliveredR2();
    expect(swp).toEqual({ skipped: true, reason: 'r2-disabled' });

    const ev = await r2.evictCreativeR2Replicas('c-1');
    expect(ev).toEqual({ skipped: true, reason: 'r2-disabled' });

    const url = await r2.getPlaybackUrl({ r2_status: 'active', r2_key: 'creative-preview/x.mp4' });
    expect(url).toBeNull();

    expect(supabaseMock.from).not.toHaveBeenCalled();
    expect(s3.S3Client).not.toHaveBeenCalled();
    expect(libStorage.Upload).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('getPlaybackUrl（R2ヒット/ミス）', () => {
  beforeEach(() => {
    process.env.R2_PLAYBACK_ENABLED = 'true';
    setR2Creds();
  });

  test('R2ヒット（r2_status=active）なら署名URLを返す', async () => {
    const url = await r2.getPlaybackUrl({ r2_status: 'active', r2_key: 'creative-preview/cf-1.mp4' });
    expect(url).toBe('https://r2.example.com/creative-preview/x.mp4?sig=abc');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    // 有効期限はフロント先読みキャッシュ(3分)より十分長い（最低1時間）
    const opts = getSignedUrl.mock.calls[0][2];
    expect(opts.expiresIn).toBeGreaterThanOrEqual(3600);
  });

  test('R2ミス（未複製/evicted/行なし）は null（=Driveフォールバック）', async () => {
    expect(await r2.getPlaybackUrl(null)).toBeNull();
    expect(await r2.getPlaybackUrl({ r2_status: null, r2_key: null })).toBeNull();
    expect(await r2.getPlaybackUrl({ r2_status: 'evicted', r2_key: 'creative-preview/cf-1.mp4' })).toBeNull();
    expect(await r2.getPlaybackUrl({ r2_status: 'active', r2_key: null })).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('署名発行が例外でも throw せず null（再生を止めない）', async () => {
    getSignedUrl.mockRejectedValueOnce(new Error('boom'));
    const url = await r2.getPlaybackUrl({ r2_status: 'active', r2_key: 'creative-preview/cf-1.mp4' });
    expect(url).toBeNull();
  });
});

// replicateCreativeFileToR2 用の supabase resolver を組み立てるヘルパ。
// usageSequence: getR2UsageBytes の呼び出しごとに返す「active 行の r2_size_bytes 配列」
function setupReplicateResolver({ cf, usageSequence, sweepRows = [] }) {
  let usageCall = 0;
  const updates = [];
  supabaseMock.__state.resolver = (q) => {
    const sel = q.calls.find(c => c[0] === 'select');
    const upd = q.calls.find(c => c[0] === 'update');
    if (upd) { updates.push({ table: q.table, patch: upd[1], calls: q.calls }); return { data: null, error: null }; }
    const selCols = sel ? String(sel[1]) : '';
    if (selCols.includes('r2_size_bytes')) {
      const rows = usageSequence[Math.min(usageCall, usageSequence.length - 1)];
      usageCall++;
      return { data: rows.map(n => ({ r2_size_bytes: n })), error: null };
    }
    if (selCols.includes('creatives:creative_id(status)')) {
      return { data: sweepRows, error: null };
    }
    if (selCols.includes('drive_file_id')) {
      return { data: cf, error: null };
    }
    if (selCols.includes('r2_key')) {
      // evictCreativeFileFromR2 の select
      return { data: { id: q.calls.find(c => c[0] === 'eq')?.[2], r2_key: 'creative-preview/old.mp4', r2_status: 'active' }, error: null };
    }
    return { data: null, error: null };
  };
  return updates;
}

describe('10GB無料枠の予算ガード', () => {
  const cfBase = {
    id: 'cf-1',
    drive_file_id: 'drv-orig',
    faststart_drive_file_id: 'drv-fast',
    faststart_status: 'done',
    faststart_file_size: 2 * GB,
    file_size: 3 * GB,
    mime_type: 'video/mp4',
    r2_status: null,
  };

  beforeEach(() => {
    process.env.R2_PLAYBACK_ENABLED = 'true';
    setR2Creds();
  });

  test('予算内なら複製し、r2_status=active + サイズを記録する', async () => {
    const updates = setupReplicateResolver({ cf: cfBase, usageSequence: [[1 * GB, 2 * GB]] }); // 使用3GB + 2GB <= 9GB
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result.ok).toBe(true);
    expect(libStorage.Upload).toHaveBeenCalledTimes(1);
    const patch = updates.find(u => u.patch?.r2_status === 'active')?.patch;
    expect(patch).toBeDefined();
    expect(patch.r2_key).toBe('creative-preview/cf-1.mp4');
    expect(patch.r2_size_bytes).toBe(2 * GB); // faststart 版のサイズで計上
  });

  test('超過見込み: sweep しても入らなければ複製をスキップ（Drive配信のまま・課金ゼロ）', async () => {
    // 使用 8GB + 2GB = 10GB > 予算9GB。sweep 後も 8GB のまま → スキップ
    setupReplicateResolver({ cf: cfBase, usageSequence: [[8 * GB], [8 * GB]], sweepRows: [] });
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('budget-exceeded');
    expect(libStorage.Upload).not.toHaveBeenCalled(); // 1バイトもアップロードしない
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('予算超過のため複製スキップ'), expect.anything()
    );
  });

  test('超過見込み → sweep で納品済みが排出されて空けば複製する', async () => {
    // 1回目集計: 8GB（超過見込み）→ sweep が納品済みを evict → 2回目集計: 3GB → 複製OK
    setupReplicateResolver({
      cf: cfBase,
      usageSequence: [[8 * GB], [3 * GB]],
      sweepRows: [
        { id: 'cf-old', creatives: { status: '納品' } },
        { id: 'cf-live', creatives: { status: 'Dチェック' } },
      ],
    });
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result.ok).toBe(true);
    // sweep が納品済み(cf-old)の R2 オブジェクトを削除している（レビュー中 cf-live は残す）
    const deletes = s3.__send.mock.calls.filter(c => c[0]?.__type === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(libStorage.Upload).toHaveBeenCalledTimes(1);
  });

  test('R2_BUDGET_BYTES で予算を上書きできる（デフォルトは9GB）', async () => {
    expect(r2.budgetBytes()).toBe(9 * GB);
    process.env.R2_BUDGET_BYTES = String(5 * GB);
    expect(r2.budgetBytes()).toBe(5 * GB);
    // 使用 4GB + 2GB > 5GB → スキップ
    setupReplicateResolver({ cf: cfBase, usageSequence: [[4 * GB], [4 * GB]] });
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('budget-exceeded');
  });

  test('使用量集計に失敗（列未適用など）したら安全側で複製しない', async () => {
    supabaseMock.__state.resolver = (q) => {
      const sel = q.calls.find(c => c[0] === 'select');
      const selCols = sel ? String(sel[1]) : '';
      if (selCols.includes('r2_size_bytes')) return { data: null, error: { message: 'column creative_files.r2_size_bytes does not exist' } };
      if (selCols.includes('drive_file_id')) return { data: cfBase, error: null };
      if (selCols.includes('creatives:creative_id(status)')) return { data: [], error: null };
      return { data: null, error: null };
    };
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result.skipped).toBe(true);
    expect(libStorage.Upload).not.toHaveBeenCalled();
  });

  test('サイズ不明なら複製しない（予算を破らない）', async () => {
    const cf = { ...cfBase, faststart_file_size: null, file_size: null };
    supabaseMock.__state.resolver = (q) => {
      const sel = q.calls.find(c => c[0] === 'select');
      if (sel && String(sel[1]).includes('drive_file_id')) return { data: cf, error: null };
      return { data: [], error: null };
    };
    // Drive メタも size を返さないようにする
    const { google } = require('googleapis');
    google.drive.mockReturnValueOnce({ files: { get: jest.fn(async () => ({ data: {} })) } });
    const result = await r2.replicateCreativeFileToR2('cf-1');
    expect(result).toEqual({ skipped: true, reason: 'size-unknown' });
    expect(libStorage.Upload).not.toHaveBeenCalled();
  });
});

describe('納品遷移の排出（evict）', () => {
  beforeEach(() => {
    process.env.R2_PLAYBACK_ENABLED = 'true';
    setR2Creds();
  });

  test('evictCreativeR2Replicas: active な複製を全て削除し r2_status=evicted にする', async () => {
    const updates = [];
    supabaseMock.__state.resolver = (q) => {
      const upd = q.calls.find(c => c[0] === 'update');
      if (upd) { updates.push({ table: q.table, patch: upd[1] }); return { data: null, error: null }; }
      const sel = q.calls.find(c => c[0] === 'select');
      const selCols = sel ? String(sel[1]) : '';
      if (selCols === 'id') return { data: [{ id: 'cf-1' }, { id: 'cf-2' }], error: null };
      if (selCols.includes('r2_key')) {
        const id = q.calls.find(c => c[0] === 'eq' && c[1] === 'id')?.[2];
        return { data: { id, r2_key: `creative-preview/${id}.mp4`, r2_status: 'active' }, error: null };
      }
      return { data: null, error: null };
    };
    const result = await r2.evictCreativeR2Replicas('creative-9');
    expect(result.evicted).toBe(2);
    const deletes = s3.__send.mock.calls.filter(c => c[0]?.__type === 'Delete');
    expect(deletes).toHaveLength(2);
    expect(deletes.map(c => c[0].params.Key).sort()).toEqual([
      'creative-preview/cf-1.mp4', 'creative-preview/cf-2.mp4',
    ]);
    expect(updates.filter(u => u.patch?.r2_status === 'evicted')).toHaveLength(2);
  });

  test('R2削除が失敗(非404)したら active のまま残す（使用量集計から漏らさない）', async () => {
    const updates = [];
    supabaseMock.__state.resolver = (q) => {
      const upd = q.calls.find(c => c[0] === 'update');
      if (upd) { updates.push(upd[1]); return { data: null, error: null }; }
      return { data: { id: 'cf-1', r2_key: 'creative-preview/cf-1.mp4', r2_status: 'active' }, error: null };
    };
    s3.__send.mockRejectedValueOnce(Object.assign(new Error('500'), { $metadata: { httpStatusCode: 500 } }));
    const result = await r2.evictCreativeFileFromR2('cf-1');
    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(0); // evicted に更新しない → sweep が再試行
  });

  test('R2削除が404なら evicted 扱いにする（既に消えている）', async () => {
    const updates = [];
    supabaseMock.__state.resolver = (q) => {
      const upd = q.calls.find(c => c[0] === 'update');
      if (upd) { updates.push(upd[1]); return { data: null, error: null }; }
      return { data: { id: 'cf-1', r2_key: 'creative-preview/cf-1.mp4', r2_status: 'active' }, error: null };
    };
    s3.__send.mockRejectedValueOnce(Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    const result = await r2.evictCreativeFileFromR2('cf-1');
    expect(result.ok).toBe(true);
    expect(updates[0]?.r2_status).toBe('evicted');
  });
});

describe('署名URLの有効期限', () => {
  test('デフォルト6時間・env指定は最低1時間を強制', () => {
    expect(r2.signedUrlTtlSeconds()).toBe(6 * 60 * 60);
    process.env.R2_SIGNED_URL_TTL_SECONDS = '60'; // 1時間未満は無視してデフォルト
    expect(r2.signedUrlTtlSeconds()).toBe(6 * 60 * 60);
    process.env.R2_SIGNED_URL_TTL_SECONDS = '7200';
    expect(r2.signedUrlTtlSeconds()).toBe(7200);
  });
});

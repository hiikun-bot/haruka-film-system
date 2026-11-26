// 銀行 API トークンの期限切れ削除（utils/aozora-token-expiry.js・aozora-api.js の接続取得時削除）のテスト
// supabase はメモリ上の簡易フェイクに差し替える。時刻は epoch ms / ISO（UTC）で渡すので TZ に依存しない。

jest.mock('../supabase', () => require('./helpers/bank-connections-fake').supabase);
jest.mock('axios');

const axios = require('axios');
const fake = require('./helpers/bank-connections-fake');
const expiry = require('../utils/aozora-token-expiry');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T01:00:00Z'); // JST 10:00
const TTL = 90 * DAY;
const iso = (ms) => new Date(ms).toISOString();

function conn(over = {}) {
  return {
    id: 'c1', provider: 'gmo_aozora', environment: 'staging', account_id: '123456789012', account_label: 'x',
    scopes: 'openid', connected_by: null, last_used_at: null,
    access_token_enc: 'A', access_token_iv: 'Ai', access_token_tag: 'At',
    refresh_token_enc: 'R', refresh_token_iv: 'Ri', refresh_token_tag: 'Rt',
    access_token_expires_at: iso(NOW + 10 * DAY),
    connected_at: iso(NOW - 20 * DAY),
    updated_at: iso(NOW - 20 * DAY),
    revoked_at: null,
    ...over,
  };
}

beforeEach(() => { fake.reset(); delete process.env.AOZORA_REFRESH_TOKEN_TTL_DAYS; });

describe('有効期間・期限の判定（純関数）', () => {
  test('リフレッシュトークンの有効期間は既定 90 日・環境変数で上書き・不正値は既定', () => {
    expect(expiry.refreshTokenTtlMs({})).toBe(90 * DAY);
    expect(expiry.refreshTokenTtlMs({ AOZORA_REFRESH_TOKEN_TTL_DAYS: '365' })).toBe(365 * DAY);
    expect(expiry.refreshTokenTtlMs({ AOZORA_REFRESH_TOKEN_TTL_DAYS: '0' })).toBe(90 * DAY);
    expect(expiry.refreshTokenTtlMs({ AOZORA_REFRESH_TOKEN_TTL_DAYS: 'abc' })).toBe(90 * DAY);
  });
  test('リフレッシュトークンの発行時刻は updated_at → connected_at', () => {
    expect(expiry.refreshTokenIssuedAtMs(conn({ updated_at: iso(NOW - DAY) }))).toBe(NOW - DAY);
    expect(expiry.refreshTokenIssuedAtMs(conn({ updated_at: null, connected_at: iso(NOW - 2 * DAY) }))).toBe(NOW - 2 * DAY);
  });
  test('アクセストークン: 期限ちょうどで期限切れ・期限列が無ければ期限切れ・暗号文が無ければ対象外', () => {
    expect(expiry.isAccessTokenExpired(conn({ access_token_expires_at: iso(NOW) }), NOW)).toBe(true);
    expect(expiry.isAccessTokenExpired(conn({ access_token_expires_at: iso(NOW + 1) }), NOW)).toBe(false);
    expect(expiry.isAccessTokenExpired(conn({ access_token_expires_at: null }), NOW)).toBe(true);
    expect(expiry.isAccessTokenExpired(conn({ access_token_enc: null, access_token_expires_at: iso(NOW - DAY) }), NOW)).toBe(false);
  });
  test('JST 表記の時刻でも epoch で比べる（+09:00 と Z が同じ瞬間なら同じ判定）', () => {
    const a = conn({ access_token_expires_at: '2026-11-27T10:00:00+09:00' });
    const b = conn({ access_token_expires_at: '2026-11-27T01:00:00Z' });
    expect(expiry.isAccessTokenExpired(a, NOW)).toBe(true);
    expect(expiry.isAccessTokenExpired(b, NOW)).toBe(true);
    expect(expiry.isAccessTokenExpired(a, NOW - 1)).toBe(false);
  });
});

describe('planTokenPurge: 何を消すか', () => {
  test('どちらも有効 → 何もしない', () => {
    expect(expiry.planTokenPurge(conn(), { now: NOW, ttlMs: TTL })).toBeNull();
  });
  test('アクセストークンだけ期限切れ → アクセストークンだけ消して接続は維持', () => {
    const p = expiry.planTokenPurge(conn({ access_token_expires_at: iso(NOW - 1) }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: true, purgeRefresh: false, revoke: false, reason: 'access_token_expired' });
  });
  test('両方期限切れ → 両方消して未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ access_token_expires_at: iso(NOW - 1), updated_at: iso(NOW - TTL) }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: true, purgeRefresh: true, revoke: true, reason: 'refresh_token_expired' });
  });
  test('リフレッシュトークンだけ期限切れ（アクセスはまだ有効）→ リフレッシュだけ消す', () => {
    const p = expiry.planTokenPurge(conn({ updated_at: iso(NOW - TTL - 1) }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: false, purgeRefresh: true, revoke: false, reason: 'refresh_token_expired' });
  });
  test('アクセストークンが既に無く、リフレッシュが期限切れ → 未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ access_token_enc: null, access_token_iv: null, access_token_tag: null, updated_at: iso(NOW - TTL) }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ purgeRefresh: true, revoke: true });
  });
  test('リフレッシュトークンが無い接続でアクセスが切れた → 未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ refresh_token_enc: null, refresh_token_iv: null, refresh_token_tag: null, access_token_expires_at: iso(NOW - 1) }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ purgeAccess: true, revoke: true, reason: 'access_token_expired' });
  });
  test('銀行が invalid_grant を返した → 期限内でもリフレッシュを消す', () => {
    const p = expiry.planTokenPurge(conn(), { now: NOW, ttlMs: TTL, refreshRejected: true });
    expect(p).toEqual({ purgeAccess: false, purgeRefresh: true, revoke: false, reason: 'refresh_rejected' });
  });
  test('切断済みの行にトークンが残っていれば消す（revoked_at は触らない）', () => {
    const p = expiry.planTokenPurge(conn({ revoked_at: iso(NOW - DAY) }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: true, purgeRefresh: true, revoke: false, reason: 'revoked' });
    expect(expiry.planTokenPurge(conn({ revoked_at: iso(NOW - DAY), access_token_enc: null, refresh_token_enc: null }), { now: NOW })).toBeNull();
  });
  test('有効な接続なのにトークンが何も無い → 未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ access_token_enc: null, refresh_token_enc: null }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: false, purgeRefresh: false, revoke: true, reason: 'no_tokens' });
  });
});

describe('buildPurgePatch / buildAuditEntry', () => {
  test('アクセスだけ消すときは updated_at を動かさない（リフレッシュの期限が延びない）', () => {
    const patch = expiry.buildPurgePatch({ purgeAccess: true, purgeRefresh: false, revoke: false }, iso(NOW));
    expect(patch).toEqual({ access_token_enc: null, access_token_iv: null, access_token_tag: null });
  });
  test('revoke は 6 列すべて NULL ＋ revoked_at', () => {
    const patch = expiry.buildPurgePatch({ purgeAccess: false, purgeRefresh: true, revoke: true }, iso(NOW));
    expect(patch).toMatchObject({
      access_token_enc: null, access_token_iv: null, access_token_tag: null,
      refresh_token_enc: null, refresh_token_iv: null, refresh_token_tag: null,
      revoked_at: iso(NOW),
    });
  });
  test('監査ログ: 接続維持は token_refresh・未接続化は disconnect。トークン値は入れない', () => {
    const c = conn({ access_token_expires_at: iso(NOW - 1) });
    const e1 = expiry.buildAuditEntry(c, { purgeAccess: true, purgeRefresh: false, revoke: false, reason: 'access_token_expired' }, { source: 'sweeper', now: NOW, ttlMs: TTL });
    expect(e1.action).toBe('token_refresh');
    expect(e1.detail).toMatchObject({ event: 'expired_token_purged', purged: ['access_token'], revoked: false, source: 'sweeper' });
    const e2 = expiry.buildAuditEntry(c, { purgeAccess: true, purgeRefresh: true, revoke: true, reason: 'refresh_token_expired' }, { now: NOW, ttlMs: TTL });
    expect(e2.action).toBe('disconnect');
    expect(e2.detail.purged).toEqual(['access_token', 'refresh_token']);
    expect(JSON.stringify(e2)).not.toMatch(/"A"|"R"|Ai|Rt/);
  });
});

describe('applyTokenPurge / purgeExpiredTokens（DB 反映）', () => {
  test('アクセスだけ期限切れ: 暗号文 3 列を NULL・updated_at と refresh は残す・監査ログ 1 件', async () => {
    const row = conn({ access_token_expires_at: iso(NOW - 1) });
    fake.seed([row]);
    const r = await expiry.applyTokenPurge(row, { now: NOW, ttlMs: TTL, source: 'on_use' });
    expect(r.applied).toBe(true);
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved).toMatchObject({ access_token_enc: null, access_token_iv: null, access_token_tag: null, refresh_token_enc: 'R', revoked_at: null, updated_at: row.updated_at });
    const logs = fake.rows('bank_api_audit_logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'token_refresh', connection_id: 'c1', actor_user_id: null });
  });
  test('両方期限切れ: 6 列 NULL・revoked_at が立つ・disconnect を記録', async () => {
    const row = conn({ access_token_expires_at: iso(NOW - 1), updated_at: iso(NOW - TTL - DAY) });
    fake.seed([row]);
    await expiry.applyTokenPurge(row, { now: NOW, ttlMs: TTL });
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved.refresh_token_enc).toBeNull();
    expect(saved.access_token_enc).toBeNull();
    expect(saved.revoked_at).toBe(iso(NOW));
    expect(fake.rows('bank_api_audit_logs')[0].action).toBe('disconnect');
  });
  test('読んだ後に別プロセスがトークンを更新していたら消さない（compare-and-set）', async () => {
    const stale = conn({ access_token_expires_at: iso(NOW - 1) });
    fake.seed([{ ...stale, access_token_enc: 'A2', access_token_expires_at: iso(NOW + 30 * DAY), refresh_token_enc: 'R2' }]);
    const r = await expiry.applyTokenPurge(stale, { now: NOW, ttlMs: TTL });
    expect(r.applied).toBe(false);
    expect(fake.rows('bank_api_connections')[0].access_token_enc).toBe('A2');
    expect(fake.rows('bank_api_audit_logs')).toHaveLength(0);
  });
  test('定期処理: トークンが残る行だけ見て、期限切れを消す', async () => {
    fake.seed([
      conn({ id: 'ok' }),
      conn({ id: 'acc', access_token_expires_at: iso(NOW - 1) }),
      conn({ id: 'both', access_token_expires_at: iso(NOW - 1), updated_at: iso(NOW - TTL) }),
      conn({ id: 'old', revoked_at: iso(NOW - 3 * DAY) }),
      conn({ id: 'empty', revoked_at: iso(NOW - 3 * DAY), access_token_enc: null, refresh_token_enc: null }),
    ]);
    const r = await expiry.purgeExpiredTokens({ now: NOW, ttlMs: TTL });
    expect(r).toEqual({ checked: 4, purged: 3, revoked: 1 });
    const byId = Object.fromEntries(fake.rows('bank_api_connections').map(x => [x.id, x]));
    expect(byId.ok.access_token_enc).toBe('A');
    expect(byId.acc).toMatchObject({ access_token_enc: null, refresh_token_enc: 'R', revoked_at: null });
    expect(byId.both).toMatchObject({ access_token_enc: null, refresh_token_enc: null, revoked_at: iso(NOW) });
    expect(byId.old).toMatchObject({ access_token_enc: null, refresh_token_enc: null, revoked_at: iso(NOW - 3 * DAY) });
    expect(fake.rows('bank_api_audit_logs').map(l => l.action).sort()).toEqual(['disconnect', 'disconnect', 'token_refresh']);
  });
});

describe('aozora-api: 接続取得時・トークン利用直前にも消す', () => {
  let aozora;
  beforeAll(() => {
    process.env.AOZORA_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.AOZORA_CLIENT_ID = 'cid';
    process.env.AOZORA_CLIENT_SECRET = 'secret';
    aozora = require('../utils/aozora-api');
  });
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('両方期限切れ → loadActiveConnection は null（未接続）を返し、行は revoked になる', async () => {
    fake.seed([conn({ access_token_expires_at: iso(NOW - 1), updated_at: iso(NOW - TTL) })]);
    expect(await aozora.loadActiveConnection()).toBeNull();
    expect(fake.rows('bank_api_connections')[0].revoked_at).not.toBeNull();
  });
  test('アクセスだけ期限切れ → 接続は返る（アクセス列は空・リフレッシュは残る）', async () => {
    fake.seed([conn({ access_token_expires_at: iso(NOW - 1) })]);
    const c = await aozora.loadActiveConnection();
    expect(c).toMatchObject({ id: 'c1', access_token_enc: null, refresh_token_enc: 'R' });
  });
  test('有効な接続はそのまま・監査ログも書かない', async () => {
    fake.seed([conn()]);
    expect((await aozora.loadActiveConnection()).access_token_enc).toBe('A');
    expect(fake.rows('bank_api_audit_logs')).toHaveLength(0);
  });
  test('refresh で銀行が invalid_grant → リフレッシュトークンを消して未接続に戻し、エラーを返す', async () => {
    const { createCipher } = require('../utils/crypto-aes');
    const cipher = createCipher('AOZORA_TOKEN_ENCRYPTION_KEY');
    const r = cipher.encrypt('refresh-secret');
    fake.seed([conn({
      access_token_enc: null, access_token_iv: null, access_token_tag: null,
      access_token_expires_at: iso(NOW - DAY),
      refresh_token_enc: r.ciphertext, refresh_token_iv: r.iv, refresh_token_tag: r.authTag,
    })]);
    axios.post.mockResolvedValue({ status: 400, data: { error: 'invalid_grant', error_description: 'expired' } });
    const c = await aozora.loadActiveConnection();
    expect(c).not.toBeNull();
    await expect(aozora.getValidAccessToken(c)).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved.refresh_token_enc).toBeNull();
    expect(saved.revoked_at).not.toBeNull();
    expect(fake.rows('bank_api_audit_logs').at(-1).detail).toMatchObject({ reason: 'refresh_rejected', source: 'refresh_rejected' });
  });
  test('推定期限切れのリフレッシュトークンは銀行へ送らずに消す', async () => {
    const row = conn({ access_token_expires_at: iso(NOW + 60 * 1000), updated_at: iso(NOW - TTL) });
    fake.seed([row]);
    axios.post.mockClear();
    await expect(aozora.getValidAccessToken(row)).rejects.toMatchObject({ errorCode: 'no_refresh_token' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(fake.rows('bank_api_connections')[0].refresh_token_enc).toBeNull();
  });
});

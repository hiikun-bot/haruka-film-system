// 銀行 API トークンの期限切れ削除（utils/aozora-token-expiry.js・aozora-api.js の接続取得時削除・poller の未接続処理）のテスト
// supabase はメモリ上の簡易フェイクに差し替える。時刻は epoch ms / ISO（UTC）で渡すので TZ に依存しない。

jest.mock('../supabase', () => require('./helpers/bank-connections-fake').supabase);
jest.mock('axios');
jest.mock('../utils/bank-transfer', () => ({
  sendAdminMyChat: jest.fn(async () => ({ ok: true })),
  todayJst: (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
  BATCH_COLUMNS: '*',
  REQUESTING_RETRY_AFTER_MS: 15 * 60_000,
}));

const axios = require('axios');
const fake = require('./helpers/bank-connections-fake');
const bt = require('../utils/bank-transfer');
const expiry = require('../utils/aozora-token-expiry');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T01:00:00Z'); // JST 10:00
const TTL = 90 * DAY;
const GRACE = expiry.REFRESH_GRACE_MS;
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
const HARD_OLD = iso(NOW - TTL - GRACE); // 推定期限＋猶予も過ぎた発行時刻
const STALE = iso(NOW - TTL - DAY);      // 推定期限は過ぎたが猶予内

beforeEach(() => { fake.reset(); delete process.env.AOZORA_REFRESH_TOKEN_TTL_DAYS; bt.sendAdminMyChat.mockClear(); });

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
  test('リフレッシュ: 推定期限で stale・推定期限＋7日で hard', () => {
    const c = conn({ updated_at: iso(NOW - TTL) });
    expect(expiry.isRefreshTokenStale(c, NOW, TTL)).toBe(true);
    expect(expiry.isRefreshTokenHardExpired(c, NOW, TTL)).toBe(false);
    expect(expiry.isRefreshTokenHardExpired(conn({ updated_at: HARD_OLD }), NOW, TTL)).toBe(true);
    expect(expiry.isRefreshTokenStale(conn({ updated_at: iso(NOW - TTL + 1) }), NOW, TTL)).toBe(false);
  });
});

describe('planTokenPurge: 何を消すか', () => {
  test('どちらも有効 → 何もしない', () => {
    expect(expiry.planTokenPurge(conn(), { now: NOW, ttlMs: TTL })).toBeNull();
  });
  test('アクセストークンだけ期限切れ → アクセストークンだけ消して接続は維持', () => {
    const p = expiry.planTokenPurge(conn({ access_token_expires_at: iso(NOW - 1) }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: true, purgeRefresh: false, revoke: false, checkRefresh: false, reason: 'access_token_expired' });
  });
  test('リフレッシュが推定期限切れ（猶予内）→ 消さずに「一度リフレッシュを試す」', () => {
    const p = expiry.planTokenPurge(conn({ updated_at: STALE }), { now: NOW, ttlMs: TTL });
    expect(p).toEqual({ purgeAccess: false, purgeRefresh: false, revoke: false, checkRefresh: true, reason: 'refresh_token_stale' });
  });
  test('両方期限切れ（リフレッシュは推定期限＋猶予も過ぎた）→ 両方消して未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ purgeAccess: true, purgeRefresh: true, revoke: true, reason: 'refresh_token_expired' });
  });
  test('リフレッシュトークンが無い接続でアクセスが切れた → 未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ refresh_token_enc: null, refresh_token_iv: null, refresh_token_tag: null, access_token_expires_at: iso(NOW - 1) }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ purgeAccess: true, revoke: true, reason: 'access_token_expired' });
  });
  test('invalid_grant → 期限内でもリフレッシュを消す。noRevoke なら未接続化しない', () => {
    const c = conn({ access_token_expires_at: iso(NOW - 1) });
    expect(expiry.planTokenPurge(c, { now: NOW, ttlMs: TTL, refreshRejected: true })).toMatchObject({ purgeRefresh: true, purgeAccess: true, revoke: true, reason: 'refresh_rejected' });
    expect(expiry.planTokenPurge(c, { now: NOW, ttlMs: TTL, refreshRejected: true, noRevoke: true })).toMatchObject({ purgeRefresh: true, purgeAccess: true, revoke: false });
  });
  test('切断済みの行にトークンが残っていれば消す（revoked_at は触らない）', () => {
    const p = expiry.planTokenPurge(conn({ revoked_at: iso(NOW - DAY) }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ purgeAccess: true, purgeRefresh: true, revoke: false, reason: 'revoked' });
    expect(expiry.planTokenPurge(conn({ revoked_at: iso(NOW - DAY), access_token_enc: null, refresh_token_enc: null }), { now: NOW })).toBeNull();
  });
  test('有効な接続なのにトークンが何も無い → 未接続に戻す', () => {
    const p = expiry.planTokenPurge(conn({ access_token_enc: null, refresh_token_enc: null }), { now: NOW, ttlMs: TTL });
    expect(p).toMatchObject({ revoke: true, reason: 'no_tokens' });
  });
});

describe('buildPurgePatch / buildAuditEntry / 通知文面', () => {
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
  test('監査ログ: action は disconnect に統一・detail.event / revoked で区別。トークン値は入れない', () => {
    const c = conn({ access_token_expires_at: iso(NOW - 1) });
    const e1 = expiry.buildAuditEntry(c, { purgeAccess: true, purgeRefresh: false, revoke: false, reason: 'access_token_expired' }, { source: 'sweeper', now: NOW, ttlMs: TTL });
    expect(e1.action).toBe('disconnect');
    expect(e1.detail).toMatchObject({ event: 'expired_token_purged', purged: ['access_token'], revoked: false, source: 'sweeper' });
    const e2 = expiry.buildAuditEntry(c, { purgeAccess: true, purgeRefresh: true, revoke: true, reason: 'refresh_token_expired' }, { now: NOW, ttlMs: TTL });
    expect(e2.action).toBe('disconnect');
    expect(e2.detail).toMatchObject({ purged: ['access_token', 'refresh_token'], revoked: true });
    expect(JSON.stringify(e2)).not.toMatch(/"A"|"R"|Ai|Rt/);
  });
  test('未接続化の通知文面にトークン・口座番号は入らない', () => {
    const t = expiry.buildRevokedNotice(conn(), { reason: 'refresh_token_expired' });
    expect(t).toContain('銀行API接続が期限切れで切れました');
    expect(t).toContain('振込管理');
    expect(t).not.toMatch(/123456789012|"A"|"R"/);
  });
});

describe('applyTokenPurge / purgeExpiredTokens（DB 反映）', () => {
  test('アクセスだけ期限切れ: 暗号文 3 列を NULL・updated_at と refresh は残す・監査ログ 1 件・通知なし', async () => {
    const row = conn({ access_token_expires_at: iso(NOW - 1) });
    fake.seed([row]);
    const r = await expiry.applyTokenPurge(row, { now: NOW, ttlMs: TTL, source: 'on_use' });
    expect(r.applied).toBe(true);
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved).toMatchObject({ access_token_enc: null, access_token_iv: null, access_token_tag: null, refresh_token_enc: 'R', revoked_at: null, updated_at: row.updated_at });
    const logs = fake.rows('bank_api_audit_logs');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'disconnect', connection_id: 'c1', actor_user_id: null });
    expect(bt.sendAdminMyChat).not.toHaveBeenCalled();
  });
  test('両方期限切れ: 6 列 NULL・revoked_at・disconnect を記録し、管理者マイチャットへ一報', async () => {
    const row = conn({ access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD });
    fake.seed([row]);
    await expiry.applyTokenPurge(row, { now: NOW, ttlMs: TTL });
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved).toMatchObject({ refresh_token_enc: null, access_token_enc: null, revoked_at: iso(NOW) });
    expect(fake.rows('bank_api_audit_logs')[0].detail).toMatchObject({ revoked: true });
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(1);
    expect(bt.sendAdminMyChat.mock.calls[0][0]).toContain('期限切れで切れました');
  });
  test('推定期限切れ（checkRefresh だけ）は書き込まない', async () => {
    const row = conn({ updated_at: STALE });
    fake.seed([row]);
    const r = await expiry.applyTokenPurge(row, { now: NOW, ttlMs: TTL });
    expect(r.applied).toBe(false);
    expect(fake.rows('bank_api_connections')[0].refresh_token_enc).toBe('R');
  });
  test('読んだ後に別プロセスがトークンを更新していたら消さない（compare-and-set）', async () => {
    const stale = conn({ access_token_expires_at: iso(NOW - 1) });
    fake.seed([{ ...stale, access_token_enc: 'A2', access_token_expires_at: iso(NOW + 30 * DAY), refresh_token_enc: 'R2' }]);
    const r = await expiry.applyTokenPurge(stale, { now: NOW, ttlMs: TTL });
    expect(r.applied).toBe(false);
    expect(fake.rows('bank_api_connections')[0].access_token_enc).toBe('A2');
    expect(fake.rows('bank_api_audit_logs')).toHaveLength(0);
  });
  test('リフレッシュの HTTP 中にリフレッシュトークンだけ置き換わった行も切らない（refresh_token_enc を比較）', async () => {
    const stale = conn({ access_token_enc: null, access_token_expires_at: iso(NOW - DAY), updated_at: HARD_OLD });
    // access_token_expires_at は同じまま、refresh_token_enc だけ新しくなった状態
    fake.seed([{ ...stale, refresh_token_enc: 'R-new' }]);
    const r = await expiry.applyTokenPurge(stale, { now: NOW, ttlMs: TTL });
    expect(r.applied).toBe(false);
    expect(fake.rows('bank_api_connections')[0]).toMatchObject({ refresh_token_enc: 'R-new', revoked_at: null });
  });
  test('定期処理: トークンが残る行だけ見て、期限切れを消す', async () => {
    fake.seed([
      conn({ id: 'ok' }),
      conn({ id: 'acc', access_token_expires_at: iso(NOW - 1) }),
      conn({ id: 'both', access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD }),
      conn({ id: 'old', revoked_at: iso(NOW - 3 * DAY) }),
      conn({ id: 'empty', revoked_at: iso(NOW - 3 * DAY), access_token_enc: null, refresh_token_enc: null }),
    ]);
    const r = await expiry.purgeExpiredTokens({ now: NOW, ttlMs: TTL });
    expect(r).toEqual({ checked: 4, purged: 3, revoked: 1, refreshed: 0 });
    const byId = Object.fromEntries(fake.rows('bank_api_connections').map(x => [x.id, x]));
    expect(byId.ok.access_token_enc).toBe('A');
    expect(byId.acc).toMatchObject({ access_token_enc: null, refresh_token_enc: 'R', revoked_at: null });
    expect(byId.both).toMatchObject({ access_token_enc: null, refresh_token_enc: null, revoked_at: iso(NOW) });
    expect(byId.old).toMatchObject({ access_token_enc: null, refresh_token_enc: null, revoked_at: iso(NOW - 3 * DAY) });
  });
  test('定期処理: 推定期限切れは一度だけ tryRefresh。refreshed なら消さない・error なら今回は消さない', async () => {
    fake.seed([conn({ id: 's1', updated_at: STALE }), conn({ id: 's2', updated_at: STALE })]);
    const tryRefresh = jest.fn(async (c) => {
      if (c.id === 's1') {
        const row = fake.rows('bank_api_connections').find(x => x.id === 's1');
        Object.assign(row, { refresh_token_enc: 'R-new', updated_at: iso(NOW) });
        return 'refreshed';
      }
      return 'error';
    });
    const r = await expiry.purgeExpiredTokens({ now: NOW, ttlMs: TTL, tryRefresh });
    expect(tryRefresh).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ purged: 0, revoked: 0, refreshed: 1 });
    expect(fake.rows('bank_api_connections').map(x => x.refresh_token_enc)).toEqual(['R-new', 'R']);
  });
});

describe('aozora-api: 接続取得時・トークン利用時', () => {
  let aozora;
  let cipher;
  const enc = (s) => { const r = cipher.encrypt(s); return { ciphertext: r.ciphertext, iv: r.iv, tag: r.authTag }; };
  const withRefresh = (over = {}, token = 'refresh-secret') => {
    const r = enc(token);
    return conn({ refresh_token_enc: r.ciphertext, refresh_token_iv: r.iv, refresh_token_tag: r.tag, ...over });
  };
  beforeAll(() => {
    process.env.AOZORA_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.AOZORA_CLIENT_ID = 'cid';
    process.env.AOZORA_CLIENT_SECRET = 'secret';
    aozora = require('../utils/aozora-api');
    cipher = require('../utils/crypto-aes').createCipher('AOZORA_TOKEN_ENCRYPTION_KEY');
  });
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(NOW); axios.post.mockReset(); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('両方期限切れ → loadActiveConnection は null（未接続）を返し、行は revoked・通知 1 回', async () => {
    fake.seed([conn({ access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD })]);
    expect(await aozora.loadActiveConnection()).toBeNull();
    expect(fake.rows('bank_api_connections')[0].revoked_at).not.toBeNull();
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(1);
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
  test('読み直した行が revoked なら、新しい接続をもう一度探して返す（再接続との競合）', async () => {
    fake.seed([
      conn({ id: 'old', access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD }),
      conn({ id: 'new', connected_at: iso(NOW - 60_000), updated_at: iso(NOW - 60_000) }),
    ]);
    const c = await aozora.loadActiveConnection();
    expect(c && c.id).toBe('new');
  });
  test('selectActiveConnection（切断ボタン用）は期限判定をせず、期限切れの行もそのまま返す', async () => {
    fake.seed([conn({ access_token_expires_at: iso(NOW - 1), updated_at: HARD_OLD })]);
    const c = await aozora.selectActiveConnection();
    expect(c).toMatchObject({ id: 'c1', access_token_enc: 'A', revoked_at: null });
    expect(fake.rows('bank_api_audit_logs')).toHaveLength(0);
  });
  test('refresh で invalid_grant → 送ったトークンのままなら消す（この経路では revoked にしない）→ 次の取得で未接続化', async () => {
    fake.seed([withRefresh({ access_token_enc: null, access_token_iv: null, access_token_tag: null, access_token_expires_at: iso(NOW - DAY) })]);
    axios.post.mockResolvedValue({ status: 400, data: { error: 'invalid_grant', error_description: 'expired' } });
    const c = await aozora.loadActiveConnection();
    await expect(aozora.getValidAccessToken(c)).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    let saved = fake.rows('bank_api_connections')[0];
    expect(saved.refresh_token_enc).toBeNull();
    expect(saved.revoked_at).toBeNull();
    expect(fake.rows('bank_api_audit_logs').at(-1).detail).toMatchObject({ reason: 'refresh_rejected', source: 'refresh_rejected', revoked: false });
    expect(await aozora.loadActiveConnection()).toBeNull();
    saved = fake.rows('bank_api_connections')[0];
    expect(saved.revoked_at).not.toBeNull();
  });
  test('invalid_grant でも、送っている間に別プロセスがローテーションしていたら新トークンを捨てない', async () => {
    const row = withRefresh({ access_token_enc: null, access_token_iv: null, access_token_tag: null, access_token_expires_at: iso(NOW - DAY) });
    fake.seed([row]);
    const rotated = enc('rotated-secret');
    axios.post.mockImplementation(async () => {
      // 銀行へ送っている間に、別プロセスが新しいリフレッシュトークンを保存した
      Object.assign(fake.rows('bank_api_connections')[0], { refresh_token_enc: rotated.ciphertext, refresh_token_iv: rotated.iv, refresh_token_tag: rotated.tag, updated_at: iso(NOW) });
      return { status: 400, data: { error: 'invalid_grant' } };
    });
    await expect(aozora.getValidAccessToken(row)).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved.refresh_token_enc).toBe(rotated.ciphertext);
    expect(saved.revoked_at).toBeNull();
    expect(fake.rows('bank_api_audit_logs')).toHaveLength(0);
  });
  test('推定期限切れのリフレッシュトークン: 一度だけ refresh を試し、受け付けられれば新トークンで継続（updated_at が進む）', async () => {
    fake.seed([withRefresh({ updated_at: STALE })]);
    axios.post.mockResolvedValue({ status: 200, data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 2592000, scope: 'openid' } });
    const c = await aozora.loadActiveConnection();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(c).not.toBeNull();
    expect(c.revoked_at).toBeNull();
    expect(c.updated_at).not.toBe(STALE);
    expect(expiry.isRefreshTokenStale(c, NOW, TTL)).toBe(false);
    expect((await aozora.getValidAccessToken(c)).accessToken).toBe('new-access');
    expect(fake.rows('bank_api_audit_logs').map(l => l.action)).toEqual(['token_refresh']);
  });
  test('推定期限切れのリフレッシュトークン: 銀行が invalid_grant → 消して、アクセスも無ければ未接続化', async () => {
    fake.seed([withRefresh({ updated_at: STALE, access_token_enc: null, access_token_iv: null, access_token_tag: null, access_token_expires_at: iso(NOW - DAY) })]);
    axios.post.mockResolvedValue({ status: 400, data: { error: 'invalid_grant' } });
    expect(await aozora.loadActiveConnection()).toBeNull();
    const saved = fake.rows('bank_api_connections')[0];
    expect(saved).toMatchObject({ refresh_token_enc: null });
    expect(saved.revoked_at).not.toBeNull();
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(1);
  });
  test('推定期限切れのリフレッシュトークン: 銀行に届かない（5xx）→ 今回は消さずに接続を返す', async () => {
    fake.seed([withRefresh({ updated_at: STALE })]);
    axios.post.mockResolvedValue({ status: 503, data: {} });
    const c = await aozora.loadActiveConnection();
    expect(c).not.toBeNull();
    expect(c.refresh_token_enc).not.toBeNull();
  });
  test('refresh 応答に refresh_token が無ければ updated_at（発行時刻の目印）を進めない', async () => {
    const row = withRefresh({ access_token_expires_at: iso(NOW + 60_000) });
    fake.seed([row]);
    axios.post.mockResolvedValue({ status: 200, data: { access_token: 'new-access', expires_in: 2592000 } });
    const r = await aozora.getValidAccessToken(row);
    expect(r.refreshed).toBe(true);
    expect(fake.rows('bank_api_connections')[0].updated_at).toBe(row.updated_at);
  });
});

describe('bank-transfer-poller: 未接続で照会できないとき', () => {
  const poller = require('../workers/bank-transfer-poller');
  test('1 日 1 回の再送ガード（JST の日付）', () => {
    expect(poller.shouldNotifyDisconnected(null, '2026-11-27')).toBe(true);
    expect(poller.shouldNotifyDisconnected('2026-11-26', '2026-11-27')).toBe(true);
    expect(poller.shouldNotifyDisconnected('2026-11-27', '2026-11-27')).toBe(false);
  });
  test('進行中の batch の last_error に理由を入れ、管理者へは同じ日に 1 回だけ', async () => {
    const batches = [
      { id: 'b1', year: 2026, month: 10, total_count: 3, status: 'awaiting_approval', last_error: null },
      { id: 'b2', year: 2026, month: 10, total_count: 1, status: 'processing', last_error: null },
    ];
    fake.seed(batches, 'payout_transfer_batches');
    const now = new Date(NOW);
    await poller.handleDisconnected(batches, { now });
    expect(fake.rows('payout_transfer_batches').map(b => b.last_error)).toEqual([poller.DISCONNECTED_LAST_ERROR, poller.DISCONNECTED_LAST_ERROR]);
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(1);
    expect(fake.rows('system_settings')[0]).toMatchObject({ key: 'bank_disconnected_notice_last_date', value: '2026-11-27' });
    await poller.handleDisconnected(fake.rows('payout_transfer_batches'), { now: new Date(NOW + 3600_000) });
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(1);
    // JST の翌日（UTC 15:00 以降）なら再び知らせる
    await poller.handleDisconnected(batches, { now: new Date(Date.parse('2026-11-27T15:00:00Z')) });
    expect(bt.sendAdminMyChat).toHaveBeenCalledTimes(2);
  });
  test('通知文面にトークン・口座番号は入らない', () => {
    const t = poller.buildDisconnectedNotice([{ year: 2026, month: 10, total_count: 2, status: 'processing' }]);
    expect(t).toContain('振込管理から再接続');
  });
});

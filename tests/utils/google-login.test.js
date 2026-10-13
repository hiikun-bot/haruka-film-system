const g = require('../../utils/google-login');

const SECRET = 'test-secret';
const env = {
  NODE_ENV: 'production',
  RAILWAY_PUBLIC_DOMAIN: 'app.harukafilm.com',
  GOOGLE_CALENDAR_CLIENT_ID: 'cal-id',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'cal-secret',
  GOOGLE_LOGIN_ENABLED: 'true',
};

describe('設定', () => {
  test('GOOGLE_LOGIN_* が無ければカレンダー連携クライアントを使う', () => {
    expect(g.getClientConfig(env)).toEqual({ id: 'cal-id', secret: 'cal-secret' });
    expect(g.getClientConfig({ ...env, GOOGLE_LOGIN_CLIENT_ID: 'l', GOOGLE_LOGIN_CLIENT_SECRET: 's' })).toEqual({ id: 'l', secret: 's' });
  });
  test('有効判定', () => {
    expect(g.isEnabled(env)).toBe(true);
    expect(g.isEnabled({ ...env, GOOGLE_LOGIN_ENABLED: 'false' })).toBe(false);
    expect(g.isEnabled({ ...env, GOOGLE_LOGIN_ENABLED: undefined })).toBe(false);
    expect(g.isEnabled({ NODE_ENV: 'production', GOOGLE_LOGIN_ENABLED: 'true' })).toBe(false);
  });
});

describe('resolveCallbackUrl', () => {
  test('公開ドメインと本番 railway.app は許可', () => {
    expect(g.resolveCallbackUrl('app.harukafilm.com', env)).toBe('https://app.harukafilm.com/auth/google/callback');
    expect(g.resolveCallbackUrl('HARUKA-FILM-SYSTEM-PRODUCTION.UP.RAILWAY.APP', env))
      .toBe('https://haruka-film-system-production.up.railway.app/auth/google/callback');
  });
  test('許可外ホスト（Host ヘッダ偽装）は null', () => {
    expect(g.resolveCallbackUrl('evil.example.com', env)).toBeNull();
    expect(g.resolveCallbackUrl('', env)).toBeNull();
    expect(g.resolveCallbackUrl('localhost:3000', env)).toBeNull();
  });
  test('開発環境は localhost を http で許可', () => {
    expect(g.resolveCallbackUrl('localhost:3000', { ...env, NODE_ENV: 'development' })).toBe('http://localhost:3000/auth/google/callback');
  });
  test('GOOGLE_LOGIN_ALLOWED_HOSTS で上書き', () => {
    expect(g.getAllowedHosts({ ...env, GOOGLE_LOGIN_ALLOWED_HOSTS: 'a.example.com, https://b.example.com/' })).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('safeNext', () => {
  test('/haruka.html 始まりのみ', () => {
    expect(g.safeNext('/haruka.html?creative=1')).toBe('/haruka.html?creative=1');
    expect(g.safeNext('https://evil.example.com')).toBe('/haruka.html');
    expect(g.safeNext('//evil.example.com')).toBe('/haruka.html');
    expect(g.safeNext(undefined)).toBe('/haruka.html');
  });
});

describe('state', () => {
  test('署名して検証できる', () => {
    const { state, nonce } = g.newState({ secret: SECRET, next: '/haruka.html?x=1' });
    const p = g.verifyState(state, SECRET);
    expect(p.nonce).toBe(nonce);
    expect(p.next).toBe('/haruka.html?x=1');
  });
  test('改ざん・別鍵・期限切れは null', () => {
    const { state } = g.newState({ secret: SECRET, next: '' });
    expect(g.verifyState(state + 'x', SECRET)).toBeNull();
    expect(g.verifyState(state, 'other')).toBeNull();
    expect(g.verifyState(state, SECRET, Date.now() + g.STATE_TTL_MS + 1000)).toBeNull();
    expect(g.verifyState('garbage', SECRET)).toBeNull();
  });
});

describe('extractVerifiedEmail', () => {
  test('確認済みメールを小文字化', () => {
    expect(g.extractVerifiedEmail({ email: 'Hiikun.ASCS@gmail.com', email_verified: true })).toEqual({ email: 'hiikun.ascs@gmail.com' });
  });
  test('未確認・無しはエラー', () => {
    expect(g.extractVerifiedEmail({ email: 'a@b.c', email_verified: false }).error).toBe('unverified');
    expect(g.extractVerifiedEmail({ email_verified: true }).error).toBe('no_email');
    expect(g.extractVerifiedEmail(null).error).toBe('no_email');
  });
});

describe('escapeLike / pickLoginUser', () => {
  test('_ と % をエスケープ', () => {
    expect(g.escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
  test('完全一致（大文字小文字無視）の 1 人だけ', () => {
    const rows = [{ id: '1', email: 'Hiikun.ascs@gmail.com', is_active: true }];
    expect(g.pickLoginUser(rows, 'hiikun.ascs@gmail.com').user.id).toBe('1');
  });
  test('未登録・重複・無効', () => {
    expect(g.pickLoginUser([], 'x@y.z').error).toBe('not_registered');
    expect(g.pickLoginUser([{ email: 'xay@y.z', is_active: true }], 'x_y@y.z').error).toBe('not_registered');
    expect(g.pickLoginUser([{ email: 'x@y.z', is_active: true }, { email: 'X@y.z', is_active: true }], 'x@y.z').error).toBe('ambiguous');
    expect(g.pickLoginUser([{ email: 'x@y.z', is_active: false }], 'x@y.z').error).toBe('inactive');
  });
});

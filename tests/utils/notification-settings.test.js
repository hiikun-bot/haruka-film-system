// tests/utils/notification-settings.test.js
// 通知の受信設定カタログ（ADR 043）の純関数テスト。supabase に依存しない。

const {
  CATALOG,
  settingColumnFor,
  defaultEnabledFor,
  isEnabledFor,
  filterRowsBySettings,
  toClientSettings,
  toSettingsPatch,
  publicCatalog,
} = require('../../utils/notification-settings');

describe('CATALOG の整合性', () => {
  test('type / column は重複せず、column は <type>_enabled 形式', () => {
    const types = CATALOG.map(c => c.type);
    const cols = CATALOG.map(c => c.column);
    expect(new Set(types).size).toBe(types.length);
    expect(new Set(cols).size).toBe(cols.length);
    for (const c of CATALOG) expect(c.column).toBe(`${c.type}_enabled`);
  });

  test('既定 OFF は creative_registered と ball_returned の 2 種別だけ', () => {
    const off = CATALOG.filter(c => c.defaultEnabled === false).map(c => c.type).sort();
    expect(off).toEqual(['ball_returned', 'creative_registered']);
  });

  test('publicCatalog は列名を含まない', () => {
    for (const c of publicCatalog()) {
      expect(c.column).toBeUndefined();
      expect(typeof c.type).toBe('string');
      expect(typeof c.default_enabled).toBe('boolean');
    }
  });
});

describe('settingColumnFor / defaultEnabledFor', () => {
  test('カタログ外の種別（常時 ON）は列 null・既定 true', () => {
    expect(settingColumnFor('pricing_approval')).toBeNull();
    expect(defaultEnabledFor('pricing_approval')).toBe(true);
    expect(settingColumnFor('leader_remind')).toBeNull();
  });

  test('旧列（global / invoice など）は列あり・既定 ON・UI には出ない', () => {
    expect(settingColumnFor('global')).toBe('global_enabled');
    expect(defaultEnabledFor('global')).toBe(true);
    expect(publicCatalog().some(c => c.type === 'global')).toBe(false);
  });
});

describe('isEnabledFor', () => {
  test('設定行なし → 既定値（creative_registered は届かない・creative_status は届く）', () => {
    expect(isEnabledFor(null, 'creative_registered')).toBe(false);
    expect(isEnabledFor(null, 'ball_returned')).toBe(false);
    expect(isEnabledFor(null, 'creative_status')).toBe(true);
    expect(isEnabledFor(null, 'post_comment')).toBe(true);
  });

  test('設定行に列が無い（migration 未適用）→ 既定値', () => {
    const row = { user_id: 'u1', global_enabled: true }; // creative_status_enabled 列なし
    expect(isEnabledFor(row, 'creative_status')).toBe(true);
    expect(isEnabledFor(row, 'creative_registered')).toBe(false);
  });

  test('設定行に boolean があればそれを優先（既定 OFF でも本人が ON にできる）', () => {
    const row = { creative_registered_enabled: true, creative_status_enabled: false };
    expect(isEnabledFor(row, 'creative_registered')).toBe(true);
    expect(isEnabledFor(row, 'creative_status')).toBe(false);
  });

  test('常時 ON の種別は設定行に関係なく true', () => {
    expect(isEnabledFor({ }, 'pricing_approval')).toBe(true);
    expect(isEnabledFor(null, 'bulk_delivered')).toBe(true);
  });
});

describe('filterRowsBySettings（bulk 発火の間引き）', () => {
  const rows = [
    { user_id: 'admin1', notification_type: 'creative_registered', title: 'A' },
    { user_id: 'admin2', notification_type: 'creative_registered', title: 'B' },
    { user_id: 'ed1',    notification_type: 'creative_status',     title: 'Dチェック依頼' },
    { user_id: 'ed2',    notification_type: 'creative_status',     title: 'Dチェック依頼' },
    { user_id: 'ed3',    notification_type: 'pricing_approval',    title: '単価承認' },
  ];

  test('設定行が無い受信者は既定値で判定（creative_registered は落ち、creative_status は残る）', () => {
    const out = filterRowsBySettings(rows, new Map());
    expect(out.map(r => r.user_id)).toEqual(['ed1', 'ed2', 'ed3']);
  });

  test('本人が ON にした admin には creative_registered が届き、OFF にした editor の creative_status は落ちる', () => {
    const map = new Map([
      ['admin2', { user_id: 'admin2', creative_registered_enabled: true }],
      ['ed2',    { user_id: 'ed2', creative_status_enabled: false }],
    ]);
    const out = filterRowsBySettings(rows, map);
    expect(out.map(r => r.user_id)).toEqual(['admin2', 'ed1', 'ed3']);
  });

  test('user_id の無い行や配列以外は捨てる', () => {
    expect(filterRowsBySettings(null, new Map())).toEqual([]);
    expect(filterRowsBySettings([{ notification_type: 'global' }], new Map())).toEqual([]);
  });
});

describe('toClientSettings / toSettingsPatch', () => {
  test('toClientSettings はカタログの全種別を boolean で返す', () => {
    const out = toClientSettings(null);
    expect(Object.keys(out).sort()).toEqual(CATALOG.map(c => c.type).sort());
    expect(out.creative_registered).toBe(false);
    expect(out.mention).toBe(true);
  });

  test('toSettingsPatch はカタログ外 key と非 boolean を無視し、列名に変換する', () => {
    const { patch, ignored } = toSettingsPatch({
      creative_registered: true,
      ball_returned: 'false',
      global: false,          // UI に出ない → 無視
      creative_status: 'yes', // 非 boolean → 無視
      hacker: true,
    });
    expect(patch).toEqual({ creative_registered_enabled: true, ball_returned_enabled: false });
    expect(ignored.sort()).toEqual(['creative_status', 'global', 'hacker']);
  });

  test('body が object でなければ空 patch', () => {
    expect(toSettingsPatch(null)).toEqual({ patch: {}, ignored: [] });
  });
});

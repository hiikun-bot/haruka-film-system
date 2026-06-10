// tests/utils/filename.test.js
// utils/filename.js (ADR 007) renderFilename のユニットテスト。
// 現在の実装挙動をそのまま固定する。

const { renderFilename } = require('../../utils/filename');

describe('renderFilename', () => {
  test('template が null / tokens が配列でない場合は空文字', () => {
    expect(renderFilename(null)).toBe('');
    expect(renderFilename({})).toBe('');
    expect(renderFilename({ tokens: 'not-array' })).toBe('');
  });

  describe('system トークン', () => {
    const template = {
      separator: '_',
      tokens: [
        { kind: 'system', key: 'serial', label: '連番' },
        { kind: 'system', key: 'project_name', label: '案件名' },
        { kind: 'system', key: 'size', label: 'サイズ' },
      ],
    };

    test('tokenValues の値を separator で連結する', () => {
      expect(renderFilename(template, { serial: '001', project_name: '夏SALE', size: '1080x1920' }))
        .toBe('001_夏SALE_1080x1920');
    });

    test('値が null/undefined のトークンは詰める（空欄スキップ）', () => {
      expect(renderFilename(template, { serial: '001', size: '1080x1920' }))
        .toBe('001_1080x1920');
    });

    test('値は String 化して trim される', () => {
      expect(renderFilename(template, { serial: 7, project_name: '  夏SALE  ', size: '' }))
        .toBe('7_夏SALE');
    });

    test('separator 未指定は "_"、文字列なら任意の区切りを使える', () => {
      const noSep = { tokens: template.tokens };
      expect(renderFilename(noSep, { serial: '1', project_name: 'A', size: 'B' })).toBe('1_A_B');
      const dashSep = { separator: '-', tokens: template.tokens };
      expect(renderFilename(dashSep, { serial: '1', project_name: 'A', size: 'B' })).toBe('1-A-B');
    });
  });

  describe('serial のゼロパディング（opts.serialDigits / ADR 008 Phase 4）', () => {
    const template = { tokens: [{ kind: 'system', key: 'serial' }] };

    test('数字のみの serial を padStart する', () => {
      expect(renderFilename(template, { serial: '7' }, {}, { serialDigits: 3 })).toBe('007');
    });

    test('serialDigits より長い serial は切り詰めない', () => {
      expect(renderFilename(template, { serial: '12345' }, {}, { serialDigits: 3 })).toBe('12345');
    });

    test('数字以外を含む serial はパディングしない', () => {
      expect(renderFilename(template, { serial: 'A7' }, {}, { serialDigits: 3 })).toBe('A7');
    });

    test('serialDigits が 1〜10 の整数でなければ無視', () => {
      expect(renderFilename(template, { serial: '7' }, {}, { serialDigits: 0 })).toBe('7');
      expect(renderFilename(template, { serial: '7' }, {}, { serialDigits: 11 })).toBe('7');
      expect(renderFilename(template, { serial: '7' }, {}, { serialDigits: 2.5 })).toBe('7');
    });

    test('serial 以外の system トークンはパディングされない', () => {
      const t = { tokens: [{ kind: 'system', key: 'size' }] };
      expect(renderFilename(t, { size: '7' }, {}, { serialDigits: 3 })).toBe('7');
    });
  });

  describe('custom トークン', () => {
    const template = {
      tokens: [
        { kind: 'custom', key: 'celebrity', label: '芸能人有無', default: '上地無' },
      ],
    };

    test('overrides[key].value が最優先', () => {
      expect(renderFilename(template, {}, { celebrity: { value: '上地有' } })).toBe('上地有');
    });

    test('override が無ければ default を使う', () => {
      expect(renderFilename(template, {}, {})).toBe('上地無');
    });

    test('override が空文字/空白のみなら default にフォールバック', () => {
      expect(renderFilename(template, {}, { celebrity: { value: '' } })).toBe('上地無');
      expect(renderFilename(template, {}, { celebrity: { value: '   ' } })).toBe('上地無');
    });

    test('override も default も無ければトークンごと詰める', () => {
      const t = { tokens: [{ kind: 'custom', key: 'x' }, { kind: 'system', key: 'serial' }] };
      expect(renderFilename(t, { serial: '1' }, {})).toBe('1');
    });

    test('overrides がオブジェクト以外でも落ちない', () => {
      expect(renderFilename(template, {}, null)).toBe('上地無');
      expect(renderFilename(template, {}, 'oops')).toBe('上地無');
    });
  });

  describe('flag トークン', () => {
    const template = {
      tokens: [
        {
          kind: 'flag', key: 'f_1', label: '芸能人有無',
          source: 'talent_flag', on_value: '上地有', off_value: '上地無',
        },
      ],
    };

    test('__flag__<source> === true なら on_value', () => {
      expect(renderFilename(template, { __flag__talent_flag: true })).toBe('上地有');
    });

    test('false / undefined / truthy-でも-true以外 は off_value', () => {
      expect(renderFilename(template, { __flag__talent_flag: false })).toBe('上地無');
      expect(renderFilename(template, {})).toBe('上地無');
      expect(renderFilename(template, { __flag__talent_flag: 1 })).toBe('上地無'); // 厳密 === true
    });

    test('overrides で on_value / off_value を案件単位に上書きできる', () => {
      const ov = { f_1: { on_value: 'タレント有', off_value: 'タレント無' } };
      expect(renderFilename(template, { __flag__talent_flag: true }, ov)).toBe('タレント有');
      expect(renderFilename(template, {}, ov)).toBe('タレント無');
    });

    test('source 未指定は talent_flag にフォールバック', () => {
      const t = { tokens: [{ kind: 'flag', key: 'f_1', on_value: 'ON', off_value: 'OFF' }] };
      expect(renderFilename(t, { __flag__talent_flag: true })).toBe('ON');
    });

    test('値が空文字に解決されたトークンは詰める', () => {
      const ov = { f_1: { off_value: '' } };
      expect(renderFilename(template, {}, ov)).toBe('');
    });
  });

  describe('不正トークンの扱い', () => {
    test('null / key なし / 未知 kind のトークンは無視される', () => {
      const template = {
        tokens: [
          null,
          { kind: 'system' },               // key なし
          { kind: 'unknown', key: 'x' },    // 未知 kind
          { kind: 'system', key: 'serial' },
        ],
      };
      expect(renderFilename(template, { serial: '5' })).toBe('5');
    });
  });

  test('混合テンプレートの統合ケース', () => {
    const template = {
      separator: '_',
      tokens: [
        { kind: 'system', key: 'serial' },
        { kind: 'system', key: 'project_name' },
        { kind: 'custom', key: 'celebrity', default: '上地無' },
        { kind: 'flag', key: 'f_1', source: 'talent_flag', on_value: '有', off_value: '無' },
        { kind: 'system', key: 'size' },
      ],
    };
    const out = renderFilename(
      template,
      { serial: '3', project_name: '夏SALE', size: '1080x1920', __flag__talent_flag: true },
      { celebrity: { value: '上地有' } },
      { serialDigits: 4 },
    );
    expect(out).toBe('0003_夏SALE_上地有_有_1080x1920');
  });
});

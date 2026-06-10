// tests/utils/category-fields.test.js
// utils/category-fields.js (ADR 012) のユニットテスト。

const {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_LABELS,
  ALLOWED_CUSTOM_TYPES,
  isBuiltinField,
  isAllowedCustomType,
} = require('../../utils/category-fields');

describe('BUILTIN_FIELDS', () => {
  test('builtin フィールドの一覧と順序を固定', () => {
    expect(BUILTIN_FIELDS).toEqual([
      'product',
      'appeal_axis',
      'media_format_size',
      'talent',
      'script_url',
      'regulation_url',
      'client_review_url',
    ]);
  });

  test('全 builtin フィールドにデフォルトラベルがある', () => {
    for (const key of BUILTIN_FIELDS) {
      expect(typeof BUILTIN_FIELD_LABELS[key]).toBe('string');
      expect(BUILTIN_FIELD_LABELS[key].length).toBeGreaterThan(0);
    }
  });
});

describe('isBuiltinField', () => {
  test('builtin キーは true', () => {
    expect(isBuiltinField('product')).toBe(true);
    expect(isBuiltinField('client_review_url')).toBe(true);
  });

  test('未知キー / null / undefined は false', () => {
    expect(isBuiltinField('nonexistent')).toBe(false);
    expect(isBuiltinField(null)).toBe(false);
    expect(isBuiltinField(undefined)).toBe(false);
    expect(isBuiltinField('')).toBe(false);
  });
});

describe('isAllowedCustomType', () => {
  test('text / textarea / url / select のみ許可', () => {
    expect(Array.from(ALLOWED_CUSTOM_TYPES).sort())
      .toEqual(['select', 'text', 'textarea', 'url']);
    for (const t of ['text', 'textarea', 'url', 'select']) {
      expect(isAllowedCustomType(t)).toBe(true);
    }
  });

  test('それ以外は false', () => {
    expect(isAllowedCustomType('number')).toBe(false);
    expect(isAllowedCustomType('checkbox')).toBe(false);
    expect(isAllowedCustomType(null)).toBe(false);
    expect(isAllowedCustomType(undefined)).toBe(false);
  });
});

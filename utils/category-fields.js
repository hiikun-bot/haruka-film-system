// =====================================================
// utils/category-fields.js  (ADR 012)
// =====================================================
// クリエイティブ詳細モーダルの builtin フィールド定義を一元管理。
// - BUILTIN_FIELDS: field_key 一覧（順序はデフォルトの sort_order と揃える）
// - BUILTIN_FIELD_LABELS: ラベル未設定時のデフォルト表示名
// - isBuiltinField(key): 検証用
//
// マスタ画面・API のいずれも本ファイルを参照することで、フィールドを
// 増やすときは BUILTIN_FIELDS への追加 + 詳細モーダル側 DOM (data-field-key)
// の用意のみで対応できる。
// =====================================================

const BUILTIN_FIELDS = [
  'product',
  'appeal_axis',
  'media_format_size',
  'talent',
  'script_url',
  'regulation_url',
  'client_review_url',
];

const BUILTIN_FIELD_LABELS = {
  product:           '商材',
  appeal_axis:       '訴求軸',
  media_format_size: '媒体・尺・サイズ',
  talent:            'タレント',
  script_url:        '台本URL',
  regulation_url:    'レギュレーション',
  client_review_url: 'クライアント確認URL',
};

const ALLOWED_CUSTOM_TYPES = new Set(['text', 'textarea', 'url', 'select']);

function isBuiltinField(key) {
  return BUILTIN_FIELDS.includes(String(key || ''));
}

function isAllowedCustomType(t) {
  return ALLOWED_CUSTOM_TYPES.has(String(t || ''));
}

module.exports = {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_LABELS,
  ALLOWED_CUSTOM_TYPES,
  isBuiltinField,
  isAllowedCustomType,
};

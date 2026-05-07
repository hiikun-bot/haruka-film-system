// ADR 007: ファイル名テンプレート（案件別命名規約）の組み立て関数
// docs/design/decisions/007-filename-templates.md
//
// テンプレ定義 (filename_templates.tokens) は以下の形:
//   [
//     { "kind": "system", "key": "serial",       "label": "連番" },
//     { "kind": "system", "key": "project_name", "label": "案件名" },
//     { "kind": "system", "key": "size",         "label": "サイズ" },
//     { "kind": "custom", "key": "celebrity",    "label": "芸能人有無", "default": "上地無" },
//     { "kind": "flag",   "key": "f_1",          "label": "芸能人有無",
//       "source": "talent_flag", "on_value": "上地有", "off_value": "上地無" },
//     ...
//   ]
//
// system トークンは tokenValues[key] を取り出し、
// custom トークンは overrides[key].value → tok.default → '' の順で評価する。
// flag トークンは tokenValues['__flag__' + tok.source] === true なら on_value、
//   それ以外（false/undefined/null）なら off_value を出す。値は overrides[key].on_value /
//   .off_value で案件単位に上書きできる（label もメタ情報として上書き可だが出力には影響しない）。
//   v1 では source は 'talent_flag' のみ受け付ける（ホワイトリストはサーバー側で担保）。
//
// Stage 2 では bulk-preview / bulk / 個別 POST creatives / generate-filename
// から呼ばれる。テンプレ取得失敗時は呼び出し側でハードコードフォールバックする。

/**
 * @param {object} template  filename_templates の 1 行 ({ separator, tokens })
 * @param {object} tokenValues  system トークンの実値マップ + flag 値（'__flag__<source>': boolean）
 * @param {object} overrides  custom / flag トークンの上書き (projects.filename_token_overrides)
 * @returns {string} 組み立て済みファイル名（空欄は詰める）
 */
function renderFilename(template, tokenValues = {}, overrides = {}) {
  if (!template || !Array.isArray(template.tokens)) return '';
  const sep = typeof template.separator === 'string' ? template.separator : '_';
  const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  const parts = template.tokens.map((tok) => {
    if (!tok || typeof tok !== 'object' || !tok.key) return '';
    if (tok.kind === 'system') {
      const v = tokenValues[tok.key];
      return v != null ? String(v).trim() : '';
    }
    if (tok.kind === 'custom') {
      const ov = safeOverrides[tok.key];
      if (ov && ov.value != null && String(ov.value).trim() !== '') {
        return String(ov.value).trim();
      }
      if (tok.default != null && String(tok.default).trim() !== '') {
        return String(tok.default).trim();
      }
      return '';
    }
    if (tok.kind === 'flag') {
      const ov = safeOverrides[tok.key] || {};
      // 上書きが空文字でも「明示的にこの値を出したい」と取れるよう、null/undefined 以外は採用する
      const onV  = ov.on_value  != null ? ov.on_value  : tok.on_value;
      const offV = ov.off_value != null ? ov.off_value : tok.off_value;
      const source = tok.source || 'talent_flag';
      const flagOn = tokenValues['__flag__' + source] === true;
      const out = flagOn ? onV : offV;
      return out != null ? String(out).trim() : '';
    }
    return '';
  }).filter(Boolean);
  return parts.join(sep);
}

module.exports = { renderFilename };

// telop-parse.js — Premiere のエフェクト値から「テロップの文字・書式」を取り出す（ADR 050 §6）
//
// Premiere の版によって値の形が違うため、ここに読み方を集めておく。
//   - Premiere 27（2027）以降: MogrtText オブジェクト（getText / getFontSize / getFontName）
//   - Premiere 26（2026）: キーフレームの value.value に文字列。従来のスクリプトと同じく
//     {"textEditValue": "...", "fontSizeEditValue": [..], "fontEditValue": [..]} の JSON のことが多い
// Premiere に依存しない純関数なので、サーバーの jest からも読み込んでテストする。

function pickNumber(v) {
  if (Array.isArray(v)) v = v[0];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

function pickString(v) {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 0〜1 の RGBA 配列や {red,green,blue} を #RRGGBB に
function toHexColor(c) {
  if (!c) return null;
  let r; let g; let b;
  if (Array.isArray(c)) {
    if (Array.isArray(c[0])) c = c[0];
    [r, g, b] = c.length >= 4 ? c.slice(1, 4) : c.slice(0, 3); // [a,r,g,b] の並びもある
  } else if (typeof c === 'object') {
    r = c.red; g = c.green; b = c.blue;
  }
  const to255 = x => {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)));
  };
  const parts = [r, g, b].map(to255);
  if (parts.some(p => p == null)) return null;
  return '#' + parts.map(p => p.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// 文字列の値（2026 の形）を読む。テロップでなければ null
function parseTextString(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      const text = pickString(j.textEditValue) ?? pickString(j.text) ?? null;
      if (text == null) return null;
      return {
        text,
        font_size: pickNumber(j.fontSizeEditValue ?? j.fontSize),
        font: pickString(j.fontEditValue ?? j.fontName),
        color: toHexColor(j.fontColorEditValue ?? j.fillColor ?? j.color),
      };
    } catch (_) {
      return null;
    }
  }
  return null;
}

// getStartValue() の戻り値（何の型でも）を受け取り、テロップなら { text, font_size, font, color }
//   plainStringIsText: そのパラメータが「ソーステキスト」等で、素の文字列も文字として扱ってよいとき true
function parseTelopValue(value, { plainStringIsText = false } = {}) {
  if (value == null) return null;
  // 2027: MogrtText
  if (typeof value === 'object' && typeof value.getText === 'function') {
    let text = null;
    try { text = value.getText(); } catch (_) { return null; }
    if (!text || !String(text).trim()) return null;
    const out = { text: String(text).trim(), font_size: null, font: null, color: null };
    try {
      if (typeof value.isUniformStyling !== 'function' || value.isUniformStyling()) {
        if (typeof value.getFontSize === 'function') out.font_size = pickNumber(value.getFontSize());
        if (typeof value.getFontName === 'function') out.font = pickString(value.getFontName());
      }
    } catch (_) { /* 書式が混在しているテロップは文字だけ使う */ }
    return out;
  }
  // 2026: Keyframe { value: { value } }
  if (typeof value === 'object' && value.value && typeof value.value === 'object' && 'value' in value.value) {
    return parseTelopValue(value.value.value, { plainStringIsText });
  }
  if (typeof value === 'string') {
    const parsed = parseTextString(value);
    if (parsed) return parsed;
    if (plainStringIsText && value.trim()) return { text: value.trim(), font_size: null, font: null, color: null };
  }
  return null;
}

// パラメータ名が「文字」っぽいか（素の文字列を文字として扱ってよいか）
function looksLikeTextParam(displayName) {
  return /source\s*text|ソーステキスト|テキスト|text/i.test(String(displayName || ''));
}

// Premiere の文字起こし JSON（形は版で揺れる）から [{start, text}] を拾う。
//   offsetSec: 素材の時刻 → シーケンスの時刻への差（クリップの開始 - インポイント）
function flattenTranscript(json, offsetSec = 0, range = null) {
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch (_) { return []; }
  }
  const out = [];
  const visit = (node, depth) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const words = Array.isArray(node.words) ? node.words : null;
    const start = Number(node.start ?? node.startTime ?? node.start_time);
    const text = typeof node.text === 'string' ? node.text
      : (words ? words.map(w => w.text ?? w.word ?? '').join('') : null);
    if (text && Number.isFinite(start) && (node.words || node.duration != null || node.end != null || node.speaker != null)) {
      const seq = start + offsetSec;
      if (!range || (seq >= range[0] - 0.5 && seq <= range[1] + 0.5)) out.push({ start: Math.round(seq * 10) / 10, text: text.trim() });
      return;
    }
    Object.values(node).forEach(v => visit(v, depth + 1));
  };
  visit(data, 0);
  return out.filter(s => s.text).sort((a, b) => a.start - b.start);
}

module.exports = { parseTelopValue, parseTextString, looksLikeTextParam, toHexColor, flattenTranscript };

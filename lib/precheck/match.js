// lib/precheck/match.js — 辞書の照合（ADR 050 §2）。AI を使わない・即時・誤検知を抑える
//
// 誤検知を抑える工夫:
//   - 漢字で始まる 2 文字以下の短い語は、直前も漢字なら別の語の一部とみなして飛ばす
//     （「要は」が「必要は」に当たらない。3 文字以上の複合語「建築管理技師」は前に何があっても当てる）
//   - 英数字で始まる／終わる語は、前後が英数字なら飛ばす（「VA」が「VALUE」に当たらない）
//   - 同じ場所に長い語と短い語が当たったら長い方だけ残す（「建築管理技師」と「管理技師」）

const KANJI = /[一-鿿㐀-䶿々〆]/;
const ALNUM = /[A-Za-z0-9]/;
const SHORT = 2;

function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

function findAll(haystack, needle) {
  const hits = [];
  if (!needle) return hits;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = haystack[i - 1] || '';
    const after = haystack[i + needle.length] || '';
    const kanjiGlued = needle.length <= SHORT && KANJI.test(needle[0]) && KANJI.test(before);
    const alnumGlued = (ALNUM.test(needle[0]) && ALNUM.test(before))
      || (ALNUM.test(needle[needle.length - 1]) && ALNUM.test(after));
    if (!kanjiGlued && !alnumGlued) hits.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return hits;
}

// 対象ファイルの列（動画編集 / サムネイル / キャプション文）をどの入力に当てるか
function sourcesFor(target, input) {
  const t = String(target || '');
  if (t.includes('サムネ')) return input.thumbnailTitle ? [{ kind: 'thumbnail', index: null, start: null, text: input.thumbnailTitle }] : [];
  if (t.includes('キャプション')) return input.caption ? [{ kind: 'caption', index: null, start: null, text: input.caption }] : [];
  // 動画編集（と未記入）はテロップと文字起こし
  const telops = (input.telops || []).map(t2 => ({ kind: 'telop', index: t2.index, start: t2.start, text: t2.text }));
  const speech = (input.transcript || []).map((s, i) => ({ kind: 'speech', index: i, start: s.start, text: s.text }));
  return [...telops, ...speech];
}

// rules: parseRules の結果 / input: { telops, transcript, thumbnailTitle, caption }
function runDictionary(rules, input) {
  const findings = [];
  for (const rule of rules.filter(r => r.method === '辞書')) {
    for (const src of sourcesFor(rule.target, input)) {
      const hay = normalize(src.text);
      const spans = [];
      for (const pair of rule.pairs) {
        const needle = normalize(pair.wrong);
        for (const at of findAll(hay, needle)) spans.push({ at, len: needle.length, pair });
      }
      const kept = spans.filter(s => !spans.some(o => o !== s && o.len > s.len && o.at <= s.at && o.at + o.len >= s.at + s.len));
      for (const s of kept) {
        findings.push({
          rule_no: rule.no,
          method: '辞書',
          severity: 'error',
          source: src.kind,
          telop_index: src.kind === 'telop' ? src.index : null,
          time_sec: src.start ?? null,
          quote: s.pair.wrong,
          reason: rule.item ? `${rule.item}: ${rule.detail}` : rule.detail,
          suggestion: s.pair.remove ? `「${s.pair.wrong}」を削除` : `「${s.pair.wrong}」→「${s.pair.right}」`,
        });
      }
    }
  }
  return findings;
}

// 人・映像の行は、パネルに確認欄（□）として出すだけ
function manualChecks(rules) {
  return rules
    .filter(r => r.method === '人' || r.method === '映像')
    .map(r => ({
      rule_no: r.no,
      method: r.method,
      label: r.item ? `${r.item}: ${r.detail}` : r.detail,
      hint: r.method === '映像' ? '映像の自動判定は準備中です。目で確認してください' : '',
    }));
}

module.exports = { normalize, findAll, runDictionary, manualChecks };

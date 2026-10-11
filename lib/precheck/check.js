// lib/precheck/check.js — 1 回の「チェックする」をまとめる（ADR 050）
//
// 辞書 → AI（必須含む）→ 確認欄 の順に組み立てて、パネルにそのまま描ける形で返す。
// AI が失敗しても辞書の結果は返す（ai_error に理由を入れる）。

const { getSet } = require('./sets');
const { loadRules, loadVideoInfo } = require('./rules');
const { runDictionary, manualChecks } = require('./match');
const ai = require('./ai');

const MAX_TELOPS = 400;
const MAX_TEXT = 500;

function cleanTelops(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_TELOPS).map((t, i) => ({
    index: Number.isFinite(Number(t.index)) ? Number(t.index) : i,
    start: Number.isFinite(Number(t.start)) ? Number(t.start) : null,
    end: Number.isFinite(Number(t.end)) ? Number(t.end) : null,
    track: Number.isFinite(Number(t.track)) ? Number(t.track) : null,
    text: String(t.text || '').slice(0, MAX_TEXT),
    font_size: Number.isFinite(Number(t.font_size)) ? Number(t.font_size) : null,
    color: t.color ? String(t.color).slice(0, 20) : null,
    font: t.font ? String(t.font).slice(0, 60) : null,
  })).filter(t => t.text.trim());
}

function cleanTranscript(list) {
  return (Array.isArray(list) ? list : []).slice(0, 2000).map(s => ({
    start: Number.isFinite(Number(s.start)) ? Number(s.start) : null,
    text: String(s.text || '').slice(0, MAX_TEXT),
  })).filter(s => s.text.trim());
}

function detectCode(set, sequenceName, explicitCode) {
  if (explicitCode) return String(explicitCode).trim();
  const m = String(sequenceName || '').match(set.codePattern || /$^/);
  return m ? m[0] : null;
}

async function runCheck(body, { useAi = true } = {}) {
  const set = getSet(body.set);
  if (!set) {
    const err = new Error('案件が見つかりません');
    err.status = 400;
    throw err;
  }
  const telops = cleanTelops(body.telops);
  const transcript = cleanTranscript(body.transcript);
  const caption = body.caption ? String(body.caption).slice(0, 5000) : '';
  const rules = await loadRules(set);
  const code = detectCode(set, body.sequence_name, body.code);
  const video = code ? await loadVideoInfo(set, code).catch(() => null) : null;
  const thumbnailTitle = body.thumbnail_title ? String(body.thumbnail_title).slice(0, 200) : (video?.thumbnailTitle || '');

  const input = { telops, transcript, thumbnailTitle, caption };
  const findings = runDictionary(rules, input);

  let aiResult = null;
  let aiError = null;
  const aiRules = rules.filter(r => r.method === 'AI' || (r.method === '必須' && caption));
  if (useAi && aiRules.length && (telops.length || transcript.length || caption)) {
    try {
      aiResult = await ai.judge({ setName: set.name, video, rules: aiRules, telops, transcript, thumbnailTitle, caption });
      findings.push(...aiResult.findings);
    } catch (e) {
      aiError = String(e.message || e).slice(0, 300);
      console.error('[precheck] ai-error', aiError);
    }
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)
    || (a.time_sec ?? 1e9) - (b.time_sec ?? 1e9) || a.rule_no - b.rule_no);

  return {
    set: { id: set.id, name: set.name },
    code,
    video,
    counts: {
      error: findings.filter(f => f.severity === 'error').length,
      warn: findings.filter(f => f.severity === 'warn').length,
      rules: rules.length,
      telops: telops.length,
    },
    findings,
    manual: manualChecks(rules),
    ai: aiResult ? { model: aiResult.model, cost_jpy: aiResult.costJpy } : null,
    ai_error: aiError,
    checked_at: new Date().toISOString(),
  };
}

module.exports = { runCheck, cleanTelops, detectCode };

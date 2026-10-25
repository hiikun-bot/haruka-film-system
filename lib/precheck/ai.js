// lib/precheck/ai.js — 「AI」「必須」のルールを Gemini で判定する（ADR 050 §5）
//
// 呼び出した瞬間に課金される。1 回のチェックで 1 回だけ呼ぶ。
// 接続は素材広場（ADR 039）と同じ Vertex AI・サービスアカウント・IPv4 強制 retry の authClient。

const { parseCredentialsFromEnv } = require('../google-service-account');
const { CLOUD_PLATFORM_SCOPE, createResilientJwtClient } = require('../google-auth-token');
const { parseGeminiJson } = require('../video-organization/gemini');
const guards = require('../video-organization/guards');

const PROMPT_VERSION = 'precheck-v1-2026-10-11';

function getModelName() {
  return process.env.PRECHECK_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
}

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  const s = Math.max(0, Math.floor(Number(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function describeTelop(t) {
  const meta = [];
  if (t.track != null) meta.push(`V${Number(t.track) + 1}`);
  if (t.font_size) meta.push(`${t.font_size}pt`);
  if (t.color) meta.push(`色${t.color}`);
  if (t.font) meta.push(t.font);
  return `#${t.index} [${fmtTime(t.start)}〜${fmtTime(t.end)}${meta.length ? ' ' + meta.join(' ') : ''}] ${String(t.text || '').replace(/\s+/g, ' ')}`;
}

// rules は AI / 必須 の行だけを渡す
function buildPrompt({ setName, video, rules, telops, transcript, thumbnailTitle, caption }) {
  const lines = [];
  lines.push('あなたは動画編集の投稿前チェック担当です。下の「ルール」に違反している箇所だけを見つけてください。');
  lines.push('');
  lines.push('# 守ること');
  lines.push('- ルールに書かれていないことは指摘しない。好みや一般論で指摘しない');
  lines.push('- 違反だと言い切れるものだけを出す。迷ったら出さない');
  lines.push('- quote には、テロップ・話した言葉・サムネ・キャプションの中から該当部分をそのまま抜き出す（言い換えない）');
  lines.push('- suggestion には直し方を短く具体的に書く（例:「夏は涼しいのよ」→「夏は涼しい」）');
  lines.push('- 科目名・分野名の正誤は、下の「この動画」の分野・分類を基準に判断する');
  lines.push('- 「必須」のルールは、キャプション文が渡されているときだけ、入っていなければ指摘する');
  lines.push('');
  lines.push(`# 案件\n${setName}`);
  if (video) {
    lines.push('');
    lines.push('# この動画');
    lines.push(`管理番号 ${video.code} / 区分 ${video.field} / 等級 ${video.grade} / 試験区分 ${video.exam} / 試験内容 ${video.subject}`);
    lines.push(`分類 ${[video.major, video.middle, video.minor].filter(Boolean).join(' > ')}`);
  }
  lines.push('');
  lines.push('# ルール（No. 対象 / 項目 / 指摘内容 / 備考）');
  for (const r of rules) {
    lines.push(`No.${r.no} [${r.method}] ${r.target || '動画編集'} / ${r.item || '-'} / ${r.detail.replace(/\s+/g, ' ')}${r.note ? ' / 備考: ' + r.note.replace(/\s+/g, ' ') : ''}`);
  }
  lines.push('');
  lines.push('# テロップ（#番号 [表示時間 トラック 文字サイズ 色] 文字）');
  lines.push(telops.length ? telops.map(describeTelop).join('\n') : '（なし）');
  if (transcript && transcript.length) {
    lines.push('');
    lines.push('# 話した言葉（文字起こし）');
    lines.push(transcript.map(s => `[${fmtTime(s.start)}] ${String(s.text || '').replace(/\s+/g, ' ')}`).join('\n'));
  }
  if (thumbnailTitle) lines.push(`\n# サムネタイトル\n${thumbnailTitle}`);
  if (caption) lines.push(`\n# キャプション文\n${caption}`);
  lines.push('');
  lines.push('# 出力（JSON のみ）');
  lines.push('{"findings":[{"rule_no":数値,"telop_index":テロップの#番号または null,"time_sec":秒数または null,"quote":"該当部分","reason":"何がルールに反するか","suggestion":"直し方"}]}');
  lines.push('違反が無ければ {"findings":[]} を返す。');
  return lines.join('\n');
}

function normalizeFindings(parsed, rules, telops) {
  const known = new Map(rules.map(r => [r.no, r]));
  const byIndex = new Map(telops.map(t => [Number(t.index), t]));
  const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return list
    .filter(f => known.has(Number(f.rule_no)))
    .map(f => {
      const idx = f.telop_index == null ? null : Number(f.telop_index);
      const telop = idx != null ? byIndex.get(idx) : null;
      return {
        rule_no: Number(f.rule_no),
        method: known.get(Number(f.rule_no)).method,
        severity: 'warn',
        source: telop ? 'telop' : 'ai',
        telop_index: telop ? idx : null,
        time_sec: telop ? telop.start : (Number.isFinite(Number(f.time_sec)) ? Number(f.time_sec) : null),
        quote: String(f.quote || '').slice(0, 200),
        reason: String(f.reason || '').slice(0, 300),
        suggestion: String(f.suggestion || '').slice(0, 300),
      };
    });
}

async function judge(input) {
  const { GoogleGenAI } = require('@google/genai');
  const project = guards.getGcpProject();
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT が設定されていません');
  const location = guards.getGcpLocation();
  const model = getModelName();
  const credentials = parseCredentialsFromEnv();
  const authClient = createResilientJwtClient(credentials, { projectId: project });
  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    googleAuthOptions: { projectId: project, scopes: [CLOUD_PLATFORM_SCOPE], authClient },
  });
  const prompt = buildPrompt(input);
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 },
  });
  const text = response.text || response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const parsed = parseGeminiJson(text);
  if (!parsed) throw new Error('AI の返答を読み取れませんでした');
  const cost = guards.estimateCostJpy(model, response.usageMetadata);
  console.info('[precheck] ai-usage', JSON.stringify({ model, prompt_version: PROMPT_VERSION, cost_jpy: cost.costJpy, usage: response.usageMetadata || null }));
  return { findings: normalizeFindings(parsed, input.rules, input.telops), model, costJpy: cost.costJpy };
}

module.exports = { PROMPT_VERSION, getModelName, buildPrompt, normalizeFindings, judge, fmtTime };

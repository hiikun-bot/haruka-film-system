// lib/portfolio-external-ai.js — 🌐 外部作品の AI 提案（ADR 045）
//
// 作品ページに URL / ファイルで作品を追加するとき、サムネ 1 枚と取れたテキスト
// （タイトル・説明・チャンネル名など）から、タイトル・説明・クライアント名・系統（業種／表現）・
// 種別を Gemini に提案させる。人はそれを微修正して登録する（1 アップロード → 2 AI 提案 → 3 微修正）。
//
// 課金の安全装置（feedback: コスト発生は専用フラグでガード）:
//   - ENABLE_PORTFOLIO_AI_SUGGEST=true でないと一切呼ばない（キー存在チェックでは動かさない）
//   - STOP_ALL=true なら止める（素材広場と共通の緊急停止）
//   - MONTHLY_ANALYSIS_BUDGET_JPY の月次予算（ADR 039 D2）を超えていたら止める。
//     費用は portfolio_external_works.ai_cost_jpy に記録し、guards.checkMonthlyBudget が合算する
//   - 送るのはサムネ 1 枚（最大 800px 級）とテキストだけ。動画本体は送らない（1 回 1 円未満の想定）
//   - モデルは PORTFOLIO_AI_MODEL → GEMINI_MODEL（既定 Flash 系）の順
//
// 失敗しても登録フローは止めない（提案なしで空欄のまま微修正へ進む）。

const guards = require('./video-organization/guards');
const { sanitizeAiSuggestion } = require('../utils/portfolio-external');

const PROMPT_VERSION = 'portfolio-external-suggest-v1-2026-09-25';
const THUMB_MAX_BYTES = 3 * 1024 * 1024;   // サムネ取得の上限（これ以上はテキストだけで提案）
const FETCH_TIMEOUT_MS = 8000;

function isEnabled() {
  return guards.truthy(process.env.ENABLE_PORTFOLIO_AI_SUGGEST);
}

function getModelName() {
  return process.env.PORTFOLIO_AI_MODEL || guards.getModelName();
}

// 実行できるかをまとめて判定する。理由は画面に出す（「なぜ AI 提案が無いか」を黙らせない）
async function checkAvailability() {
  if (!isEnabled()) return { ok: false, reason: 'disabled', message: 'AI 提案は無効です（ENABLE_PORTFOLIO_AI_SUGGEST 未設定）' };
  if (guards.isStopAll()) return { ok: false, reason: 'stop_all', message: 'AI 解析は緊急停止中です（STOP_ALL）' };
  if (!guards.getGcpProject()) return { ok: false, reason: 'no_project', message: 'GOOGLE_CLOUD_PROJECT が未設定です' };
  if (guards.isBudgetMode()) {
    const budget = await guards.checkMonthlyBudget();
    if (budget.exceeded) {
      return { ok: false, reason: 'budget', message: `今月の AI 予算（¥${budget.budget_jpy}）を使い切りました。来月まで AI 提案はお休みです`, budget };
    }
  }
  return { ok: true };
}

// サムネ画像を取る（サイズ上限・タイムアウトつき）。取れなければ null（テキストのみで提案）
async function fetchThumbnailBuffer(url) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > THUMB_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > THUMB_MAX_BYTES) return null;
    return { buffer: buf, mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildSuggestPrompt({ sourceType, mediaKind, orientation, meta, genres, styles, hasImage }) {
  const genreList = (genres || []).map(g => `  - ${g.code}: ${g.name}`).join('\n');
  const styleList = (styles || []).map(s => `  - ${s.code}: ${s.name}`).join('\n');
  const facts = [];
  if (meta?.title) facts.push(`title: ${String(meta.title).slice(0, 200)}`);
  if (meta?.author) facts.push(`author/channel: ${String(meta.author).slice(0, 100)}`);
  if (meta?.description) facts.push(`description: ${String(meta.description).slice(0, 800)}`);
  if (meta?.filename) facts.push(`filename: ${String(meta.filename).slice(0, 200)}`);
  if (meta?.site_name) facts.push(`site: ${String(meta.site_name).slice(0, 100)}`);
  if (meta?.url) facts.push(`url: ${String(meta.url).slice(0, 300)}`);
  const kindHint = mediaKind ? `media kind (already known): ${mediaKind}` : 'media kind: unknown (decide from the evidence: video / image / web)';
  const orientHint = orientation ? `orientation: ${orientation}` : 'orientation: unknown';
  return `You are helping a Japanese video/design production team (HARUKA FILM) file a portfolio entry.
A member is adding a work they made OUTSIDE the company's normal projects (personal work, past job, another client, a YouTube upload).
${hasImage ? 'Part 1 is the thumbnail / representative frame of the work.' : 'No image is attached; use the text facts only.'}
Source: ${sourceType}. ${kindHint}. ${orientHint}.
Known facts:
${facts.length ? facts.join('\n') : '  (none)'}

Return JSON only (no markdown). All string values MUST be in natural Japanese.
{
  "title": "short work title for a portfolio card (<= 40 chars, no hashtags, no channel name)",
  "description": "1-2 sentences describing what the work is and its appeal (<= 160 chars)",
  "client_name": "client / brand / channel name if evident, else null",
  "media_kind": "video | image | web",
  "genre_code": "one code from GENRES below that best matches the client's industry, else null",
  "style_code": "one code from STYLES below that best matches the expression/format, else null",
  "tags": ["up to 5 short Japanese tags"],
  "confidence": 0.0-1.0
}
GENRES (industry of the client):
${genreList || '  (none)'}
STYLES (expression / format):
${styleList || '  (none)'}
Rules: never invent a client name; prefer null over guessing. Keep title free of "【】" if the original title is clickbait-like; make it read as a portfolio caption.`;
}

/**
 * 外部作品のメタ提案を作る。
 * @param {object} arg
 *   sourceType 'youtube'|'drive'|'upload'|'link'
 *   mediaKind  'video'|'image'|'web'|null
 *   orientation 'portrait'|'square'|'landscape'|null
 *   meta { title, author, description, filename, site_name, url }
 *   thumb { buffer, mimeType } | thumbUrl string
 *   genres [{code,name}] / styles [{code,name}]
 * @returns {{ used:boolean, reason?:string, message?:string, suggestion?:object, model?:string, cost_jpy?:number, usage?:object }}
 */
async function suggestExternalWorkMeta({ sourceType, mediaKind, orientation, meta, thumb, thumbUrl, genres, styles }) {
  const avail = await checkAvailability();
  if (!avail.ok) return { used: false, reason: avail.reason, message: avail.message };

  let image = thumb && thumb.buffer ? thumb : null;
  if (!image && thumbUrl) image = await fetchThumbnailBuffer(thumbUrl);

  const promptText = buildSuggestPrompt({ sourceType, mediaKind, orientation, meta, genres, styles, hasImage: !!image });
  const modelName = getModelName();
  const { analyzeMedia } = require('./video-organization/gemini');
  const started = Date.now();
  try {
    const result = await analyzeMedia({
      mediaKind: 'image',
      mediaParts: image ? [{ buffer: image.buffer, mimeType: image.mimeType }] : [],
      modelName,
      promptText,
      originalFilename: meta?.filename || meta?.title || 'external-work',
    });
    const cost = guards.estimateCostJpy(modelName, result.usage);
    const suggestion = sanitizeAiSuggestion(result.parsed, {
      genreCodes: (genres || []).map(g => g.code),
      styleCodes: (styles || []).map(s => s.code),
    });
    console.info('[portfolio-ext-ai] ok', JSON.stringify({ model: modelName, ms: Date.now() - started, cost_jpy: cost.costJpy, image: !!image }));
    return {
      used: true,
      model: modelName,
      prompt_version: PROMPT_VERSION,
      cost_jpy: cost.costJpy,
      usage: result.usage || null,
      raw: result.parsed || null,
      suggestion,
    };
  } catch (e) {
    console.warn('[portfolio-ext-ai] failed:', e?.message || e);
    return { used: false, reason: 'error', message: `AI 提案に失敗しました（${String(e?.message || e).slice(0, 120)}）` };
  }
}

module.exports = {
  PROMPT_VERSION,
  isEnabled,
  getModelName,
  checkAvailability,
  fetchThumbnailBuffer,
  buildSuggestPrompt,
  suggestExternalWorkMeta,
};

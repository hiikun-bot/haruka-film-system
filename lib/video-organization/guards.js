// lib/video-organization/guards.js — 動画整理ツールの安全装置
//
// このモジュールは以下の従量課金事故を防ぐ:
//   1. STOP_ALL=true なら解析も適用も実行しない（緊急停止）
//   2. DAILY_ANALYSIS_LIMIT 超過なら Gemini 呼び出しを拒否（既定 5 回/日・JST 日付で集計）
//   3. MAX_DURATION_SECONDS 超過動画はスキップ（既定 60 秒）
//   4. ENABLE_VIDEO_ORGANIZATION_TEST=true でないと route 自体マウントされない

const supabase = require('../../supabase');

function truthy(v) {
  return ['true', '1', 'on', 'yes'].includes(String(v ?? '').toLowerCase());
}

function isFeatureEnabled() {
  return truthy(process.env.ENABLE_VIDEO_ORGANIZATION_TEST);
}

function isStopAll() {
  return truthy(process.env.STOP_ALL);
}

function isDryRun() {
  // 未設定/空文字も安全側で true（本番リネーム実行を絶対に既定にしない）
  const raw = process.env.DRY_RUN;
  if (raw === undefined || raw === null || raw === '') return true;
  return truthy(raw);
}

function getDailyLimit() {
  const n = Number(process.env.DAILY_ANALYSIS_LIMIT || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function getMaxDurationSeconds() {
  const n = Number(process.env.MAX_DURATION_SECONDS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// アップロード上限（バイト）。multer の limits.fileSize と
// /upload の前段チェックで使う。Gemini inline 20MB の制約に合わせて 25MB を既定。
function getMaxUploadSizeBytes() {
  const mb = Number(process.env.MAX_UPLOAD_SIZE_MB || 25);
  const safe = Number.isFinite(mb) && mb > 0 ? mb : 25;
  return Math.floor(safe * 1024 * 1024);
}
function getMaxUploadSizeMB() {
  return Math.floor(getMaxUploadSizeBytes() / (1024 * 1024));
}

// /upload（multer 経由）と Resumable Upload（ブラウザ→Drive 直送）の経路分岐サイズ（バイト）。
// 未設定時は multer 上限と同値にして「multer は弾く / Resumable も使えない」中間ゾーンを消滅させる。
// 例: MAX_UPLOAD_SIZE_MB=25 のみ設定 → 25MB を超える瞬間に Resumable に倒れる。
// RESUMABLE_UPLOAD_THRESHOLD_BYTES を別途指定すれば、中間に余裕を持たせることも可能（運用上は同値推奨）。
function getResumableUploadThresholdBytes() {
  const env = process.env.RESUMABLE_UPLOAD_THRESHOLD_BYTES;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return getMaxUploadSizeBytes();
}

// アップロード時点で許す動画長の上限（秒）。
// フロント側でも同じ値で事前ブロックする。
function getMaxUploadDurationSeconds() {
  const n = Number(process.env.MAX_UPLOAD_DURATION_SECONDS || process.env.MAX_DURATION_SECONDS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function getMaxRetryCount() {
  const n = Number(process.env.MAX_RETRY_COUNT || 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function getModelName() {
  return process.env.GEMINI_MODEL || 'gemini-1.5-pro';
}

// 手動「🤖 AI解析する」(POST /analyze) 用のモデル（ADR 039 D3）。
//   既定（自動解析）は Flash 系でコストを抑え、人が明示的に押す再解析だけ Pro 系を使う運用。
//   未設定なら自動解析と同じモデル。
function getManualModelName() {
  return process.env.GEMINI_MODEL_MANUAL || getModelName();
}

// ==================== 月次予算ガード（ADR 039 D2） ====================
// MONTHLY_ANALYSIS_BUDGET_JPY（円）が設定されていれば「件数」ではなく「金額」で自動解析を止める。
//   - 1 解析ごとに usageMetadata × 単価表 × USD/JPY で概算円を analysis_cost_jpy に記録
//   - 月初（JST）〜現在の SUM が予算を超えたら自動解析・一括解析を待機させる
//   - 手動「AI解析する」は従来どおり止めない（管理者の明示操作＝自分で制御できる）
//   未設定(0)なら従来の DAILY_ANALYSIS_LIMIT（件数）で動く。
function getMonthlyBudgetJpy() {
  const n = Number(process.env.MONTHLY_ANALYSIS_BUDGET_JPY || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function isBudgetMode() {
  return getMonthlyBudgetJpy() > 0;
}
function getUsdJpyRate() {
  const n = Number(process.env.USD_JPY_RATE || 150);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

// Gemini 公開単価（USD / 1M tokens, 2026-09 時点）。prefix の長い順に照合する。
//   audio は音声入力の単価（Flash 系はテキスト/画像/動画より高い）。
//   未知のモデルは最も高い Pro 単価で見積もる（安全側）。
const MODEL_PRICING_USD_PER_M = [
  { prefix: 'gemini-3.1-pro',       input: 2.00, audio: 2.00, output: 12.00 },
  { prefix: 'gemini-3-pro',         input: 2.00, audio: 2.00, output: 12.00 },
  { prefix: 'gemini-3-flash',       input: 0.50, audio: 1.00, output: 3.00 },
  { prefix: 'gemini-2.5-flash-lite',input: 0.10, audio: 0.30, output: 0.40 },
  { prefix: 'gemini-2.5-flash',     input: 0.30, audio: 1.00, output: 2.50 },
  { prefix: 'gemini-2.5-pro',       input: 1.25, audio: 1.25, output: 10.00 },
];
function getModelPricing(modelName) {
  const name = String(modelName || '').toLowerCase();
  const hit = MODEL_PRICING_USD_PER_M
    .slice().sort((a, b) => b.prefix.length - a.prefix.length)
    .find(p => name.startsWith(p.prefix));
  return hit ? { ...hit, known: true } : { prefix: null, input: 2.00, audio: 2.00, output: 12.00, known: false };
}

// usageMetadata（@google/genai の response.usageMetadata）から概算費用（円）を出す。
//   promptTokensDetails[{modality, tokenCount}] の AUDIO 分だけ音声単価、残りは入力単価。
//   出力は candidatesTokenCount + thoughtsTokenCount（思考トークンも出力として課金される）。
function estimateCostJpy(modelName, usage) {
  const u = usage || {};
  const pricing = getModelPricing(modelName);
  const promptTokens = Number(u.promptTokenCount) || 0;
  const audioTokens = (Array.isArray(u.promptTokensDetails) ? u.promptTokensDetails : [])
    .filter(d => String(d?.modality || '').toUpperCase() === 'AUDIO')
    .reduce((a, d) => a + (Number(d.tokenCount) || 0), 0);
  const nonAudioPrompt = Math.max(0, promptTokens - audioTokens);
  const outputTokens = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
  const totalTokens = Number(u.totalTokenCount) || (promptTokens + outputTokens);
  const usd = (nonAudioPrompt * pricing.input + audioTokens * pricing.audio + outputTokens * pricing.output) / 1e6;
  const costJpy = Math.round(usd * getUsdJpyRate() * 1000) / 1000;
  return { promptTokens, audioTokens, outputTokens, totalTokens, costUsd: usd, costJpy, pricingKnown: pricing.known };
}

// JST の「今月 1 日 0:00」/「来月 1 日 0:00」を UTC ISO で返す
function jstMonthStartIso(now = new Date()) {
  const [y, m] = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - 9 * 60 * 60 * 1000).toISOString();
}
function jstNextMonthStartIso(now = new Date()) {
  const [y, m] = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - 9 * 60 * 60 * 1000).toISOString();
}

async function checkMonthlyBudget() {
  const budget = getMonthlyBudgetJpy();
  const since = jstMonthStartIso();
  const resetsAt = jstNextMonthStartIso();
  const base = { budget_jpy: budget, spent_jpy: 0, count: 0, exceeded: false, since, resets_at: resetsAt };
  if (!budget) return base;
  const { data, error } = await supabase
    .from('video_file_organization_tests')
    .select('analysis_cost_jpy')
    .gte('processed_at', since)
    .not('analysis_cost_jpy', 'is', null);
  if (error) {
    // 安全側: 集計不能でも止めない（ログのみ）。列未適用の環境もここに来る。
    console.warn('[video-org] monthly-budget sum error:', error.message);
    return base;
  }
  let spent = (data || []).reduce((a, r) => a + (Number(r.analysis_cost_jpy) || 0), 0);
  let count = (data || []).length;
  // ADR 045: 作品ページの外部作品 AI 提案（portfolio_external_works.ai_cost_jpy）も同じ予算で数える。
  //   テーブル未適用・列無しの環境では黙って 0 扱い（作品ページ側の機能は別フラグで止まる）。
  try {
    const { data: ext, error: extErr } = await supabase
      .from('portfolio_external_works')
      .select('ai_cost_jpy')
      .gte('created_at', since)
      .not('ai_cost_jpy', 'is', null);
    if (!extErr) {
      spent += (ext || []).reduce((a, r) => a + (Number(r.ai_cost_jpy) || 0), 0);
      count += (ext || []).length;
    }
  } catch (_) { /* 集計不能でも止めない */ }
  const spentRounded = Math.round(spent * 100) / 100;
  return { ...base, spent_jpy: spentRounded, count, exceeded: spent >= budget };
}

// 自動解析の実行可否を一括で返す（ADR 039 D2）。
//   mode: 'budget'（MONTHLY_ANALYSIS_BUDGET_JPY 設定時）| 'daily'
//   exceeded: その mode で枠を使い切っているか
//   daily / budget: 表示用の内訳（両方返す）
async function checkAnalysisQuota() {
  const [daily, budget] = await Promise.all([checkDailyLimit(), checkMonthlyBudget()]);
  const mode = isBudgetMode() ? 'budget' : 'daily';
  const exceeded = mode === 'budget' ? budget.exceeded : daily.exceeded;
  return { mode, exceeded, daily, budget };
}

function getGcpProject() {
  return process.env.GOOGLE_CLOUD_PROJECT || '';
}

function getGcpLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast1';
}

// 当日 (UTC) の processed_at をカウントして、上限到達なら true を返す。
// 上限超過時にユーザーへ何回呼び出したかを伝えるため count も返す。
// 「本日」の境界は JST（日本時間）0:00。
//   Railway は UTC 動作のため、旧実装（setUTCHours(0)）では 09:00 JST で枠が戻り、
//   ユーザー感覚の「今日」とずれていた（ADR 039 原因 1）。サーバーローカル時刻に依存しないよう
//   toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) → Date.UTC(...) - 9h で求める。
function jstDayStartIso(now = new Date()) {
  const [y, m, d] = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 9 * 60 * 60 * 1000).toISOString();
}
function jstNextDayStartIso(now = new Date()) {
  return new Date(new Date(jstDayStartIso(now)).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

async function checkDailyLimit() {
  const startOfDayJst = jstDayStartIso();
  const resetsAt = jstNextDayStartIso();
  const { count, error } = await supabase
    .from('video_file_organization_tests')
    .select('id', { count: 'exact', head: true })
    .gte('processed_at', startOfDayJst);
  if (error) {
    // 安全側: カウント不能なら limit 到達扱いにはせず通すが、ログには残す
    console.warn('[video-org] daily-limit count error:', error.message);
    return { count: 0, limit: getDailyLimit(), exceeded: false, resets_at: resetsAt };
  }
  const limit = getDailyLimit();
  return { count: count || 0, limit, exceeded: (count || 0) >= limit, resets_at: resetsAt };
}

module.exports = {
  truthy,
  isFeatureEnabled,
  isStopAll,
  isDryRun,
  getDailyLimit,
  getMaxDurationSeconds,
  getMaxUploadSizeBytes,
  getMaxUploadSizeMB,
  getResumableUploadThresholdBytes,
  getMaxUploadDurationSeconds,
  getMaxRetryCount,
  getModelName,
  getManualModelName,
  getMonthlyBudgetJpy,
  isBudgetMode,
  getUsdJpyRate,
  getModelPricing,
  estimateCostJpy,
  jstMonthStartIso,
  jstNextMonthStartIso,
  checkMonthlyBudget,
  checkAnalysisQuota,
  getGcpProject,
  getGcpLocation,
  checkDailyLimit,
  jstDayStartIso,
  jstNextDayStartIso,
};

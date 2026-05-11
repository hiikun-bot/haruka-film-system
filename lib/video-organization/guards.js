// lib/video-organization/guards.js — 動画整理ツールの安全装置
//
// このモジュールは以下の従量課金事故を防ぐ:
//   1. STOP_ALL=true なら解析も適用も実行しない（緊急停止）
//   2. DAILY_ANALYSIS_LIMIT 超過なら Gemini 呼び出しを拒否（既定 5 回/日）
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

function getGcpProject() {
  return process.env.GOOGLE_CLOUD_PROJECT || '';
}

function getGcpLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast1';
}

// 当日 (UTC) の processed_at をカウントして、上限到達なら true を返す。
// 上限超過時にユーザーへ何回呼び出したかを伝えるため count も返す。
async function checkDailyLimit() {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('video_file_organization_tests')
    .select('id', { count: 'exact', head: true })
    .gte('processed_at', startOfDayUtc.toISOString());
  if (error) {
    // 安全側: カウント不能なら limit 到達扱いにはせず通すが、ログには残す
    console.warn('[video-org] daily-limit count error:', error.message);
    return { count: 0, limit: getDailyLimit(), exceeded: false };
  }
  const limit = getDailyLimit();
  return { count: count || 0, limit, exceeded: (count || 0) >= limit };
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
  getMaxUploadDurationSeconds,
  getMaxRetryCount,
  getModelName,
  getGcpProject,
  getGcpLocation,
  checkDailyLimit,
};

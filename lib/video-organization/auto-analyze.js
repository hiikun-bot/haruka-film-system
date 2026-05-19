// lib/video-organization/auto-analyze.js — D&D 後の AI 解析を自動キック
//
// Phase 1: 「自動 analyze」だけ提供する。apply (Drive のファイル名変更) は
// 依然として手動 (UI からのクリック) で、ここでは絶対に走らせない。
//
// 設計の要点:
//   - 環境変数 ENABLE_AUTO_ANALYZE が true のときだけ動く（デフォルト false = 既存挙動）
//   - 既存の POST /analyze ハンドラと同じ安全装置をすべて通す:
//       1) STOP_ALL マスタースイッチ
//       2) DAILY_ANALYSIS_LIMIT
//       3) MAX_ANALYSIS_DURATION_SECONDS（動画長）
//       4) MAX_RETRY_COUNT
//       5) inline upload 20MB 上限
//       6) status が waiting_approval / failed のみ
//   - 失敗してもユーザー操作（アップロード）は止めない。fire-and-forget。
//     エラーは console.error と logCtx で残す。
//
// 使い方:
//   await generatePreviewForVideoOrg({ rowId }).then(() => {
//     triggerAutoAnalyzeIfEligible({ rowId }).catch(err => console.error(...));
//   });

const supabase = require('../../supabase');
const guards = require('./guards');
const driveLib = require('./drive');
const geminiLib = require('./gemini');

// analysis_status / analysis_progress_percent の進捗更新ヘルパー。
// PR #695 で追加された列を fire-and-forget で更新する（失敗しても本処理は続行）。
async function updateAnalysisProgress(rowId, patch) {
  if (!rowId) return;
  try {
    await supabase.from('video_file_organization_tests')
      .update(patch)
      .eq('id', rowId);
  } catch (e) {
    console.warn('[video-org] updateAnalysisProgress failed:', e?.message || e);
  }
}

function isAutoAnalyzeEnabled() {
  return guards.truthy(process.env.ENABLE_AUTO_ANALYZE);
}

function logCtx(prefix, payload) {
  console.log(`[video-org] ${prefix}`, JSON.stringify(payload));
}

// inline upload 上限（Gemini の制約）。POST /analyze と同値。
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

// 自動 analyze を実行する。
// 戻り値: { skipped: bool, reason?: string, ok?: bool, item?: row }
// 例外は呼び出し側が握りつぶす想定（fire-and-forget）。
async function triggerAutoAnalyzeIfEligible({ rowId }) {
  if (!rowId) {
    return { skipped: true, reason: 'no-row-id' };
  }

  // 1) フィーチャーフラグ
  if (!isAutoAnalyzeEnabled()) {
    logCtx('auto-analyze-skip', { rowId, reason: 'ENABLE_AUTO_ANALYZE=off' });
    return { skipped: true, reason: 'auto-analyze-disabled' };
  }

  // 2) STOP_ALL
  if (guards.isStopAll()) {
    logCtx('auto-analyze-skip', { rowId, reason: 'STOP_ALL=true' });
    return { skipped: true, reason: 'stop-all' };
  }

  // 3) row 取得
  const { data: item, error: fetchError } = await supabase
    .from('video_file_organization_tests')
    .select('*')
    .eq('id', rowId)
    .maybeSingle();
  if (fetchError) {
    logCtx('auto-analyze-skip', { rowId, reason: 'fetch-error', error: fetchError.message });
    return { skipped: true, reason: 'fetch-error' };
  }
  if (!item) {
    logCtx('auto-analyze-skip', { rowId, reason: 'row-not-found' });
    return { skipped: true, reason: 'row-not-found' };
  }

  // ---- 解析ソース選定 ----
  // ADR 018: preview_status='done' のレコードは、原本ではなくプレビュー WebP（60枚
  // ストーリーボード）を Gemini に渡す。これにより:
  //   - 30秒超／20MB超の動画でも解析できる（実質サイズ・長さ無制限）
  //   - WebP ~3MB なので inline 上限に余裕で収まる
  //   - 課金が下がる
  // 失われるのは音声情報のみ（タグ・概要・シーン抽出には WebP で十分）。
  const useWebpPreview = !!(item.preview_status === 'done' && item.preview_drive_file_id);
  const fileId = useWebpPreview ? item.preview_drive_file_id : item.drive_file_id;
  const sourceMimeType = useWebpPreview
    ? (item.preview_mime_type || 'image/webp')
    : item.mime_type;
  // WebP プレビューは「動画の60枚静止画」だが、Gemini には image として渡す。
  // プロンプト側で「複数フレームから動画の内容を解釈する」モードに切り替える。
  const sourceMediaKind = useWebpPreview ? 'image' : (item.media_kind || 'video');

  if (!fileId) {
    logCtx('auto-analyze-skip', { rowId, reason: 'no-drive-file-id' });
    return { skipped: true, reason: 'no-drive-file-id' };
  }

  // 4) status ガード（手動の POST /analyze と同じく waiting_approval / failed / skipped のみ）
  //    ADR 018: 過去に「動画長/サイズ超過」で skipped になったレコードを WebP 経由で救済可能。
  if (!['waiting_approval', 'failed', 'skipped'].includes(item.status)) {
    logCtx('auto-analyze-skip', { rowId, fileId, reason: `bad-status:${item.status}` });
    return { skipped: true, reason: `bad-status:${item.status}` };
  }

  // 5) 動画長ガード（画像は対象外、WebP プレビュー使用時もスキップ）
  //    WebP は事前生成された 60枚ストーリーボード（=画像）なので動画長制限を受けない。
  const maxDuration = guards.getMaxDurationSeconds();
  if (
    !useWebpPreview &&
    item.media_kind === 'video' &&
    item.video_duration_seconds &&
    item.video_duration_seconds > maxDuration
  ) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'skipped',
        error_message: `動画長 ${item.video_duration_seconds}s > MAX_DURATION_SECONDS=${maxDuration}s（プレビュー未完成のため原本でも解析できず）`,
        analysis_status: 'skipped',
        analysis_progress_percent: null,
      })
      .eq('id', item.id);
    logCtx('auto-analyze-skip', {
      rowId, fileId, reason: 'duration-exceeded',
      duration: item.video_duration_seconds, maxDuration,
    });
    return { skipped: true, reason: 'duration-exceeded' };
  }

  // 6) retry count ガード
  if ((item.attempt_count || 0) >= guards.getMaxRetryCount()) {
    logCtx('auto-analyze-skip', {
      rowId, fileId, reason: 'max-retry-exceeded',
      attempt: item.attempt_count, max: guards.getMaxRetryCount(),
    });
    return { skipped: true, reason: 'max-retry-exceeded' };
  }

  // 7) DAILY_LIMIT
  const daily = await guards.checkDailyLimit();
  if (daily.exceeded) {
    logCtx('auto-analyze-skip', {
      rowId, fileId, reason: 'daily-limit-exceeded',
      count: daily.count, limit: daily.limit,
    });
    return { skipped: true, reason: 'daily-limit-exceeded' };
  }

  // ---- ここから実解析（課金開始） ----
  await supabase.from('video_file_organization_tests')
    .update({
      status: 'processing',
      attempt_count: (item.attempt_count || 0) + 1,
      // approved_by は自動なので NULL のまま。手動 analyze では req.user.id が入る。
      approved_at: new Date().toISOString(),
      // PR #695: AI 解析進捗の見える化（フェーズ2）
      analysis_status: 'processing',
      analysis_progress_percent: 0,
    })
    .eq('id', item.id);

  logCtx('auto-analyze-start', {
    at: new Date().toISOString(),
    rowId, fileId,
    fileName: item.original_filename,
    size: item.file_size,
    duration: item.video_duration_seconds,
    kind: item.media_kind,
    source: useWebpPreview ? 'preview-webp' : 'original',
    sourceMimeType,
    sourceMediaKind,
    model: guards.getModelName(),
    dry_run: guards.isDryRun(),
    daily_count: daily.count,
    daily_limit: daily.limit,
  });

  // 8) Drive からバッファ取得
  let buffer;
  try {
    buffer = await driveLib.downloadFileBuffer(fileId);
  } catch (e) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'failed',
        error_message: `Drive download 失敗: ${e.message}`,
        processed_at: new Date().toISOString(),
        analysis_status: 'failed',
        analysis_progress_percent: null,
      })
      .eq('id', item.id);
    logCtx('auto-analyze-failed', { rowId, fileId, phase: 'download', error: e.message });
    return { skipped: false, ok: false, reason: 'download-failed' };
  }

  // 9) inline 20MB ガード（WebP プレビューは通常 ~3MB なので通る）
  if (buffer.length > MAX_INLINE_BYTES) {
    const note = useWebpPreview
      ? `inline upload 上限 ${MAX_INLINE_BYTES} bytes 超過 (preview webp が ${buffer.length} bytes)`
      : `inline upload 上限 ${MAX_INLINE_BYTES} bytes 超過 (${buffer.length} bytes) — プレビュー未完成のためスキップ`;
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'skipped',
        error_message: note,
        analysis_status: 'skipped',
        analysis_progress_percent: null,
      })
      .eq('id', item.id);
    logCtx('auto-analyze-skip', {
      rowId, fileId, reason: 'inline-size-exceeded',
      size: buffer.length, max: MAX_INLINE_BYTES,
      source: useWebpPreview ? 'preview-webp' : 'original',
    });
    return { skipped: true, reason: 'inline-size-exceeded' };
  }

  // Gemini 呼び出し直前: 20%（アップロード/前処理が終わったタイミング）
  await updateAnalysisProgress(item.id, { analysis_progress_percent: 20 });

  // 10) Gemini 呼び出し
  let analysis;
  try {
    analysis = await geminiLib.analyzeMedia({
      mediaBuffer: buffer,
      mimeType: sourceMimeType,
      mediaKind: sourceMediaKind,
      originalFilename: item.original_filename,
      // ADR 018: WebP プレビューを使うときはプロンプトを動画ストーリーボード用に切替
      sourceVariant: useWebpPreview ? 'video-storyboard-webp' : null,
      originalMediaKind: item.media_kind || 'video',
    });
  } catch (e) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'failed',
        error_message: e.message,
        processed_at: new Date().toISOString(),
        analysis_status: 'failed',
        analysis_progress_percent: null,
      })
      .eq('id', item.id);
    logCtx('auto-analyze-failed', { rowId, fileId, phase: 'gemini', error: e.message });
    return { skipped: false, ok: false, reason: 'gemini-failed' };
  }

  // Gemini 結果取得直後: 70%（保存/整形は残っているがほぼ終わり）
  await updateAnalysisProgress(item.id, { analysis_progress_percent: 70 });

  logCtx('auto-analyze-response', {
    rowId, fileId, model: analysis.model, jsonParsed: !!analysis.parsed,
  });

  if (!analysis.parsed) {
    await supabase.from('video_file_organization_tests')
      .update({
        status: 'failed',
        model: analysis.model,
        prompt_version: analysis.promptVersion,
        raw_response: { raw: analysis.raw },
        error_message: 'Gemini レスポンスが JSON としてパースできませんでした',
        processed_at: new Date().toISOString(),
        analysis_status: 'failed',
        analysis_progress_percent: null,
      })
      .eq('id', item.id);
    return { skipped: false, ok: false, reason: 'json-parse-failed' };
  }

  // 11) パース結果の整形（POST /analyze と同じロジック）
  const p = analysis.parsed;
  const tagsRaw = Array.isArray(p.tags) ? p.tags : [];
  const tags = tagsRaw
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .map(t => t.startsWith('#') ? t : '#' + t)
    .slice(0, 12);
  const scenesRaw = Array.isArray(p.scenes) ? p.scenes : [];
  const scenes = scenesRaw.slice(0, 8).map(s => ({
    time: String(s?.time || '').slice(0, 12),
    description: String(s?.description || '').slice(0, 200),
  })).filter(s => s.description);

  const { data: updated, error: updateError } = await supabase
    .from('video_file_organization_tests')
    .update({
      status: 'analysis_completed',
      model: analysis.model,
      prompt_version: analysis.promptVersion,
      summary: String(p.summary || ''),
      main_action: String(p.main_action || ''),
      video_type: String(p.video_type || ''),
      recommended_folder: String(p.recommended_folder || ''),
      recommended_filename: String(p.recommended_filename || ''),
      mood: String(p.mood || ''),
      tags,
      scenes,
      confidence: Number.isFinite(Number(p.confidence)) ? Math.min(95, Math.round(Number(p.confidence))) : null,
      needs_human_review: !!p.needs_human_review,
      reason: String(p.reason || ''),
      raw_response: analysis.parsed,
      processed_at: new Date().toISOString(),
      // PR #695: フェーズ2 完了を最終 UPDATE と同時に書く（アトミック）
      analysis_status: 'done',
      analysis_progress_percent: null,
    })
    .eq('id', item.id)
    .select()
    .single();
  if (updateError) {
    // 保存失敗。analysis_status を failed に倒す（fire-and-forget）
    await updateAnalysisProgress(item.id, {
      analysis_status: 'failed',
      analysis_progress_percent: null,
    });
    logCtx('auto-analyze-failed', { rowId, fileId, phase: 'update', error: updateError.message });
    return { skipped: false, ok: false, reason: 'db-update-failed' };
  }

  logCtx('auto-analyze-done', {
    rowId, fileId,
    recommended_filename: updated.recommended_filename,
    recommended_folder: updated.recommended_folder,
    tags_count: tags.length,
    scenes_count: scenes.length,
    confidence: updated.confidence,
  });

  // Phase 1: ここで終わり。apply は呼ばない（手動 UI クリックを維持）。
  return { skipped: false, ok: true, item: updated };
}

module.exports = {
  isAutoAnalyzeEnabled,
  triggerAutoAnalyzeIfEligible,
};

// routes/video-organization-test.js — 素材広場 / 動画整理ツール（test / experimental）
//
// 設計の核:
//   - 4 endpoint すべて admin のみ（requireRole('admin')）
//   - register（登録）→ analyze（承認＋AI解析）→ apply（承認＋Drive変更）の 3 段階承認
//   - register 段階では Gemini を 1 度も叩かない（waiting_approval）
//   - analyze は STOP_ALL / DAILY_LIMIT / duration / mime / status / attempt_count を
//     すべて pass してから初めて Vertex AI を呼ぶ
//   - apply は DRY_RUN=true の間は提案差分だけ返す（Drive 上は何も触らない）

const express = require('express');
const router = express.Router();

const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const guards = require('../lib/video-organization/guards');
const driveLib = require('../lib/video-organization/drive');
const geminiLib = require('../lib/video-organization/gemini');

// 共通: feature flag ガード（ENABLE_VIDEO_ORGANIZATION_TEST=false なら 404）
router.use((req, res, next) => {
  if (!guards.isFeatureEnabled()) {
    return res.status(404).json({ error: '素材広場 / 動画整理ツールは無効化されています' });
  }
  next();
});

// 共通: 認証 + admin
router.use(requireAuth);
router.use(requireRole('admin'));

const SUPPORTED_MIMES = new Set(['video/mp4']);

function logCtx(prefix, payload) {
  // 監査ログ: 仕様で要求された項目を最低限カバー
  console.log(`[video-org] ${prefix}`, JSON.stringify(payload));
}

// 一覧取得 — 管理画面の一覧表示用
router.get('/list', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('video_file_organization_tests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ items: data || [], daily: await guards.checkDailyLimit() });
  } catch (e) {
    console.error('[video-org] list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 単一取得 — 提案内容の最終確認用
router.get('/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId);
    const { data, error } = await supabase
      .from('video_file_organization_tests')
      .select('*')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '登録されていません' });
    res.json({ item: data });
  } catch (e) {
    console.error('[video-org] get error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 登録（Gemini を叩かない・Drive メタ取得のみ）
router.post('/register', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    // 重複登録チェック
    const { data: existing } = await supabase
      .from('video_file_organization_tests')
      .select('id, status')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        error: '既に登録済みです',
        existing_status: existing.status,
      });
    }

    // Drive メタ取得
    const meta = await driveLib.getVideoFileMeta(fileId);
    if (!meta || !meta.fileId) {
      return res.status(404).json({ error: 'Google Drive 上に該当ファイルが見つかりません' });
    }
    if (!SUPPORTED_MIMES.has(meta.mimeType)) {
      return res.status(422).json({
        error: `対象外の MIME タイプ: ${meta.mimeType}（現在は video/mp4 のみ対応）`,
      });
    }

    const parentId = (meta.parents && meta.parents[0]) || null;
    const parentName = await driveLib.getParentFolderName(parentId);

    const row = {
      drive_file_id: fileId,
      original_filename: meta.fileName,
      current_filename: meta.fileName,
      mime_type: meta.mimeType,
      file_size: meta.size,
      drive_url: meta.webViewLink,
      current_parent_folder_id: parentId,
      current_parent_folder_name: parentName,
      video_duration_seconds: meta.durationSeconds,
      status: 'waiting_approval',
      dry_run: guards.isDryRun(),
      created_by: req.user?.id || null,
    };

    const { data: inserted, error: insertError } = await supabase
      .from('video_file_organization_tests')
      .insert(row)
      .select()
      .single();
    if (insertError) throw insertError;

    logCtx('register', {
      at: new Date().toISOString(),
      by: req.user?.email,
      fileId,
      fileName: meta.fileName,
      size: meta.size,
      duration: meta.durationSeconds,
      dry_run: row.dry_run,
      stop_all: guards.isStopAll(),
    });

    res.json({ item: inserted });
  } catch (e) {
    console.error('[video-org] register error:', e);
    res.status(500).json({ error: e.message });
  }
});

// AI 解析（承認後にここを呼ぶ。ここで初めて Vertex AI に課金が発生）
router.post('/analyze', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    if (guards.isStopAll()) {
      return res.status(423).json({ error: 'STOP_ALL=true のため解析を停止しています' });
    }

    const { data: item, error: fetchError } = await supabase
      .from('video_file_organization_tests')
      .select('*')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!item) return res.status(404).json({ error: '先に register が必要です' });

    // status ガード — 連続解析・既完了の再解析を禁止（force は MVP では非対応）
    if (!['waiting_approval', 'failed'].includes(item.status)) {
      return res.status(409).json({
        error: `現在の status (${item.status}) からは解析できません`,
      });
    }

    // 動画時間ガード
    const maxDuration = guards.getMaxDurationSeconds();
    if (item.video_duration_seconds && item.video_duration_seconds > maxDuration) {
      await supabase
        .from('video_file_organization_tests')
        .update({ status: 'skipped', error_message: `動画長 ${item.video_duration_seconds}s > MAX_DURATION_SECONDS=${maxDuration}s` })
        .eq('id', item.id);
      return res.status(422).json({
        error: `動画が長すぎます (${item.video_duration_seconds}s > ${maxDuration}s)`,
      });
    }

    // リトライ上限
    if ((item.attempt_count || 0) >= guards.getMaxRetryCount()) {
      return res.status(429).json({
        error: `MAX_RETRY_COUNT (${guards.getMaxRetryCount()}) に到達しています`,
      });
    }

    // 日次上限
    const daily = await guards.checkDailyLimit();
    if (daily.exceeded) {
      return res.status(429).json({
        error: `DAILY_ANALYSIS_LIMIT に到達しました (${daily.count}/${daily.limit})`,
      });
    }

    // ここまでで安全装置を通過。status を processing に遷移。
    await supabase
      .from('video_file_organization_tests')
      .update({
        status: 'processing',
        attempt_count: (item.attempt_count || 0) + 1,
        approved_by: req.user?.id || null,
        approved_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    logCtx('analyze-start', {
      at: new Date().toISOString(),
      by: req.user?.email,
      fileId,
      fileName: item.original_filename,
      size: item.file_size,
      duration: item.video_duration_seconds,
      model: guards.getModelName(),
      dry_run: guards.isDryRun(),
      stop_all: guards.isStopAll(),
      daily_count: daily.count,
      daily_limit: daily.limit,
    });

    // Drive ダウンロード
    const buffer = await driveLib.downloadFileBuffer(fileId);
    // 20MB 超は inline data に乗らないので skipped
    const MAX_INLINE_BYTES = 20 * 1024 * 1024;
    if (buffer.length > MAX_INLINE_BYTES) {
      await supabase
        .from('video_file_organization_tests')
        .update({
          status: 'skipped',
          error_message: `inline upload 上限 ${MAX_INLINE_BYTES} bytes 超過 (${buffer.length} bytes)`,
        })
        .eq('id', item.id);
      return res.status(422).json({
        error: `動画が大きすぎます (${buffer.length} bytes > ${MAX_INLINE_BYTES} bytes)。GCS bucket 経由は将来対応`,
      });
    }

    // Gemini 呼び出し（ここで課金）
    let analysis;
    try {
      analysis = await geminiLib.analyzeVideo({
        videoBuffer: buffer,
        mimeType: item.mime_type || 'video/mp4',
        originalFilename: item.original_filename,
      });
    } catch (e) {
      await supabase
        .from('video_file_organization_tests')
        .update({
          status: 'failed',
          error_message: e.message,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      logCtx('analyze-failed', { fileId, error: e.message });
      return res.status(502).json({ error: `Gemini 呼び出し失敗: ${e.message}` });
    }

    logCtx('analyze-response', {
      fileId,
      model: analysis.model,
      jsonParsed: !!analysis.parsed,
    });

    if (!analysis.parsed) {
      await supabase
        .from('video_file_organization_tests')
        .update({
          status: 'failed',
          model: analysis.model,
          prompt_version: analysis.promptVersion,
          raw_response: { raw: analysis.raw },
          error_message: 'Gemini レスポンスが JSON としてパースできませんでした',
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      return res.status(502).json({ error: 'Gemini レスポンスが JSON ではありません', raw: analysis.raw });
    }

    const p = analysis.parsed;
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
        confidence: Number.isFinite(Number(p.confidence)) ? Math.min(95, Math.round(Number(p.confidence))) : null,
        needs_human_review: !!p.needs_human_review,
        reason: String(p.reason || ''),
        raw_response: analysis.parsed,
        processed_at: new Date().toISOString(),
      })
      .eq('id', item.id)
      .select()
      .single();
    if (updateError) throw updateError;

    res.json({ item: updated });
  } catch (e) {
    console.error('[video-org] analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 適用（提案を Drive に適用）— DRY_RUN=true の間はプレビュー差分のみ返す
router.post('/apply', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    if (guards.isStopAll()) {
      return res.status(423).json({ error: 'STOP_ALL=true のため適用を停止しています' });
    }

    const { data: item } = await supabase
      .from('video_file_organization_tests')
      .select('*')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (!item) return res.status(404).json({ error: '登録されていません' });
    if (item.status !== 'analysis_completed') {
      return res.status(409).json({ error: `status=${item.status} は適用対象外（analysis_completed のみ）` });
    }
    if (!item.recommended_filename || !item.recommended_folder) {
      return res.status(422).json({ error: '提案ファイル名 / フォルダが空です' });
    }

    const dryRun = guards.isDryRun();
    const diff = {
      current_filename: item.current_filename,
      new_filename: item.recommended_filename,
      current_folder: item.current_parent_folder_name,
      new_folder: item.recommended_folder,
      confidence: item.confidence,
      needs_human_review: item.needs_human_review,
      reason: item.reason,
      dry_run: dryRun,
    };

    logCtx('apply', {
      at: new Date().toISOString(),
      by: req.user?.email,
      fileId,
      dry_run: dryRun,
      diff,
    });

    if (dryRun) {
      // 実適用しない。status は analysis_completed のまま据え置く
      // （何度プレビューしても安全）。
      return res.json({ applied: false, dry_run: true, diff });
    }

    // 本適用は MVP 範囲外（仕様: 「実際のリネーム・移動は、まだ本番実行しなくてOK」）
    // ここに到達するのは DRY_RUN=false に手動で切り替えた場合のみ。
    // それでも事故防止のため、現状は明示的に 501 で止める設計とする。
    // 本番実行を解禁する際は Stage 2 で別 PR を切り、drive.files.update / move を実装する。
    return res.status(501).json({
      error: 'DRY_RUN=false での本適用は MVP 範囲外です。次フェーズで実装します',
      diff,
    });
  } catch (e) {
    console.error('[video-org] apply error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 削除（テスト中の手動掃除用）
router.delete('/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId);
    const { error } = await supabase
      .from('video_file_organization_tests')
      .delete()
      .eq('drive_file_id', fileId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('[video-org] delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

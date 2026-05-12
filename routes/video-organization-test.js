// routes/video-organization-test.js — 素材広場 / 動画整理ツール（test / experimental）
//
// 設計の核:
//   - 全 endpoint admin のみ（requireRole('admin')）
//   - フロー: upload（D&D アップロード）/ register（既存 Drive ID）→
//             analyze（承認＋AI解析）→ apply（承認＋Drive変更）の 3 段階承認
//   - upload / register 段階では Gemini を 1 度も叩かない（waiting_approval）
//   - analyze は STOP_ALL / DAILY_LIMIT / duration / mime / status / attempt_count を
//     すべて pass してから初めて Vertex AI を呼ぶ
//   - apply は DRY_RUN=true の間は提案差分だけ返す（Drive 上は何も触らない）
//
// Phase 2 追加:
//   - POST /upload  : multer で受けた動画/画像を Drive にアップロード（HEIC→jpeg 変換）
//   - GET  /preview/:fileId : Drive のファイルを Range 対応で stream（プレビュー再生用）
//   - 画像対応（jpg/jpeg/png/webp/heic）
//   - Gemini プロンプト拡張で tags / scenes / mood を保存

const express = require('express');
const multer = require('multer');
const router = express.Router();

const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const guards = require('../lib/video-organization/guards');
const driveLib = require('../lib/video-organization/drive');
const geminiLib = require('../lib/video-organization/gemini');
const heicLib = require('../lib/video-organization/heic');
const { generateFaststartForVideoOrg } = require('../lib/faststart');

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

// アップロードを受ける upload エリア
// limits.fileSize は guards.getMaxUploadSizeBytes() で env 連動（既定 25MB）。
// multer の limits は per-file。複数アップロード時の合計はクライアント側で 1 件ずつ送る運用。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: guards.getMaxUploadSizeBytes() },
});

// フロントが起動時に取得する上限値。クライアント側の事前バリデーション用。
router.get('/limits', (req, res) => {
  res.json({
    max_upload_size_mb: guards.getMaxUploadSizeMB(),
    max_upload_duration_seconds: guards.getMaxUploadDurationSeconds(),
    max_analysis_duration_seconds: guards.getMaxDurationSeconds(),
    daily_analysis_limit: guards.getDailyLimit(),
  });
});

const VIDEO_MIMES = new Set(['video/mp4']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const HEIC_MIMES  = new Set(['image/heic', 'image/heif']);

function mimeToKind(mimeType, filename) {
  const mt = String(mimeType || '').toLowerCase();
  if (VIDEO_MIMES.has(mt)) return 'video';
  if (IMAGE_MIMES.has(mt) || HEIC_MIMES.has(mt)) return 'image';
  if (heicLib.isHeic(mt, filename)) return 'image';
  return null;
}

function logCtx(prefix, payload) {
  console.log(`[video-org] ${prefix}`, JSON.stringify(payload));
}

function getUploadFolderId() {
  return process.env.VIDEO_ORG_UPLOAD_FOLDER_ID
      || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID
      || '';
}

// ==================== 一覧 ====================
router.get('/list', async (req, res) => {
  try {
    const { q, status, mediaKind, tag } = req.query || {};
    let query = supabase
      .from('video_file_organization_tests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (status) query = query.eq('status', String(status));
    if (mediaKind) query = query.eq('media_kind', String(mediaKind));
    if (tag) query = query.contains('tags', [String(tag)]);
    if (q) {
      // ファイル名・summary・tags での自由検索
      const safe = String(q).replace(/%/g, '\\%').replace(/_/g, '\\_');
      query = query.or(
        `original_filename.ilike.%${safe}%,current_filename.ilike.%${safe}%,summary.ilike.%${safe}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data || [], daily: await guards.checkDailyLimit() });
  } catch (e) {
    console.error('[video-org] list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==================== プレビューストリーム（Drive 動画/画像を proxy）====================
// /preview/:fileId  — Range 対応で動画を返す。3 秒ループ再生用。
// 認証必須・admin のみ（router.use 済み）。レスポンスを公開化せず HARUKA セッション経由で配信する。
//
// 重要: <video> は metadata 取得時に Range: bytes=0- を投げてくる。これに 206
// を返さないと <video> が「seekable」と認識せず再生できなくなる。Drive から
// 返ってきたステータスをそのまま転送する設計に変更（旧版は手動 200/206 判定
// で不整合が出いた）。
//
// faststart 切替: クリエイティブ詳細（Frame.io 風）と同じく、faststart_drive_file_id
// が DB にあれば原本ではなくそちらをサーブする。H.265/HEVC など Web 再生不可な
// 原本もここで H.264+AAC 版にすり替わって再生可能になる。
// ?original=1 を付ければ強制的に原本を返す（検証用）。
router.get('/preview/:fileId', async (req, res) => {
  const fileId = String(req.params.fileId);
  if (!fileId) return res.status(400).end();
  try {
    // DB に faststart 版があればそれを配信
    const { data: row } = await supabase
      .from('video_file_organization_tests')
      .select('faststart_drive_file_id')
      .eq('drive_file_id', fileId)
      .maybeSingle();

    const wantsOriginal = req.query.original === '1';
    const effectiveFileId = (!wantsOriginal && row?.faststart_drive_file_id) || fileId;

    const range = req.headers.range || null;
    const { stream, status, headers } = await driveLib.getFileStream(effectiveFileId, range);
    // Drive レスポンスから必要なヘッダのみ転送
    const passthrough = ['content-type', 'content-length', 'content-range', 'last-modified', 'etag'];
    for (const k of passthrough) {
      if (headers[k]) res.setHeader(k, headers[k]);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    // Drive 側のステータスをそのまま転送（206 / 200 / 304 など）
    res.status(status || 200);
    stream.on('error', (e) => {
      console.error('[video-org] preview stream error:', {
        fileId, effectiveFileId, message: e.message, code: e.code,
      });
      try { res.end(); } catch (_) {}
    });
    req.on('close', () => {
      try { stream.destroy(); } catch (_) {}
    });
    stream.pipe(res);
  } catch (e) {
    // Drive API のエラーをコード別にハンドリング（次のエラー報告で原因を絞り込みやすくする）
    // googleapis 例外は e.code に HTTP ステータス、e.errors[0].reason に reason 文字列が入る
    const upstreamStatus = Number(e?.code) || null;
    const reason = e?.errors?.[0]?.reason || null;
    console.error('[video-org] preview error:', {
      fileId,
      message: e?.message,
      upstreamStatus,
      reason,
    });
    if (!res.headersSent) {
      // 404=ファイルなし、403=権限/quota、429=rate limit、5xx=Drive側障害
      let outStatus = 502;
      if (upstreamStatus === 404) outStatus = 404;
      else if (upstreamStatus === 403) outStatus = 403;
      else if (upstreamStatus === 401) outStatus = 401;
      else if (upstreamStatus === 429) outStatus = 429;
      else if (upstreamStatus && upstreamStatus >= 500) outStatus = 502;
      res.status(outStatus).json({
        error: 'preview_failed',
        upstreamStatus,
        reason,
      });
    }
  }
});

// ==================== アップロード（複数ファイル D&D）====================
// multer が LIMIT_FILE_SIZE で reject した時に 413 で返すラッパー
function uploadWithSizeGuard(req, res, next) {
  upload.array('files', 20)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = guards.getMaxUploadSizeMB();
      return res.status(413).json({
        error: `ファイルサイズが上限 ${mb}MB を超えています。短く編集するか圧縮してから再アップロードしてください`,
      });
    }
    console.error('[video-org] upload middleware error:', err);
    return res.status(400).json({ error: err.message || 'アップロード処理でエラーが発生しました' });
  });
}

router.post('/upload', uploadWithSizeGuard, async (req, res) => {
  const folderId = getUploadFolderId();
  if (!folderId) {
    return res.status(500).json({ error: 'VIDEO_ORG_UPLOAD_FOLDER_ID / GOOGLE_DRIVE_ROOT_FOLDER_ID が未設定です' });
  }
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'ファイルが添付されていません' });

  const results = [];
  for (const f of files) {
    try {
      const kind = mimeToKind(f.mimetype, f.originalname);
      if (!kind) {
        results.push({ filename: f.originalname, ok: false, error: `未対応の MIME: ${f.mimetype}` });
        continue;
      }

      // HEIC → JPEG 変換（mime と filename を差し替え）
      let buffer = f.buffer;
      let mimeType = f.mimetype;
      let filename = f.originalname;
      if (heicLib.isHeic(f.mimetype, f.originalname)) {
        try {
          buffer = await heicLib.convertHeicToJpeg(f.buffer);
          mimeType = 'image/jpeg';
          filename = heicLib.jpegFilenameFor(f.originalname);
        } catch (e) {
          results.push({ filename: f.originalname, ok: false, error: `HEIC 変換失敗: ${e.message}` });
          continue;
        }
      }

      // Drive アップロード
      const uploaded = await driveLib.uploadFile({
        buffer, filename, mimeType, parentFolderId: folderId,
      });

      // 動画長の上限チェック（アップロード直後に Drive メタの durationMillis を見る）
      // 上限超過なら課金事故防止のため Drive から削除して 422 相当を返す。
      // durationSeconds が取得できないケース（Drive がまだ処理中など）はそのまま通し、
      // analyze 段階で再度 MAX_DURATION_SECONDS で弾く（多層防御）。
      const maxDur = guards.getMaxUploadDurationSeconds();
      if (kind === 'video' && uploaded.durationSeconds && uploaded.durationSeconds > maxDur) {
        await driveLib.deleteFile(uploaded.fileId);
        logCtx('upload-rejected-too-long', {
          at: new Date().toISOString(), by: req.user?.email,
          filename: f.originalname,
          duration: uploaded.durationSeconds,
          limit: maxDur,
        });
        results.push({
          filename: f.originalname, ok: false,
          error: `動画長 ${uploaded.durationSeconds}秒 が上限 ${maxDur}秒 を超えています。短く編集してから再アップロードしてください`,
        });
        continue;
      }

      // DB 登録
      const parentName = await driveLib.getParentFolderName(uploaded.parents[0] || folderId);
      const row = {
        drive_file_id: uploaded.fileId,
        original_filename: uploaded.fileName,
        current_filename: uploaded.fileName,
        mime_type: uploaded.mimeType,
        file_size: uploaded.size,
        drive_url: uploaded.webViewLink,
        current_parent_folder_id: uploaded.parents[0] || folderId,
        current_parent_folder_name: parentName,
        video_duration_seconds: uploaded.durationSeconds,
        media_kind: kind,
        thumbnail_url: uploaded.thumbnailLink,
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

      logCtx('upload', {
        at: new Date().toISOString(),
        by: req.user?.email,
        fileId: uploaded.fileId,
        fileName: uploaded.fileName,
        size: uploaded.size,
        kind,
      });

      // 素材広場は大半が H.264 で素直に再生できるので、アップロード時の自動変換は行わない。
      // ブラウザで再生不可だった素材だけ、プレビューパネルの「⚡ 再生用に変換」ボタンで
      // ユーザーが手動発動する。これで Drive 容量2倍化を回避（クリエイティブ詳細は
      // 校了動画の永久保管前提なので auto 変換のままで OK）。

      results.push({ filename: f.originalname, ok: true, item: inserted });
    } catch (e) {
      console.error('[video-org] upload file error:', f.originalname, e);
      results.push({ filename: f.originalname, ok: false, error: e.message });
    }
  }
  res.json({ results });
});

// ==================== fileId による既存 Drive 登録（旧互換）====================
router.post('/register', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    const { data: existing } = await supabase
      .from('video_file_organization_tests')
      .select('id, status')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({ error: '既に登録済みです', existing_status: existing.status });
    }

    const meta = await driveLib.getVideoFileMeta(fileId);
    if (!meta || !meta.fileId) {
      return res.status(404).json({ error: 'Google Drive 上に該当ファイルが見つかりません' });
    }
    const kind = mimeToKind(meta.mimeType, meta.fileName);
    if (!kind) {
      return res.status(422).json({ error: `対象外の MIME: ${meta.mimeType}` });
    }

    const parentId = (meta.parents && meta.parents[0]) || null;
    const parentName = await driveLib.getParentFolderName(parentId);
    const thumb = await driveLib.getThumbnailLink(fileId);

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
      media_kind: kind,
      thumbnail_url: thumb,
      status: 'waiting_approval',
      dry_run: guards.isDryRun(),
      created_by: req.user?.id || null,
    };

    const { data: inserted, error: insertError } = await supabase
      .from('video_file_organization_tests')
      .insert(row).select().single();
    if (insertError) throw insertError;

    logCtx('register', {
      at: new Date().toISOString(), by: req.user?.email,
      fileId, fileName: meta.fileName, size: meta.size, kind,
    });

    // 自動変換はしない（容量2倍化回避）。再生できない素材は手動ボタンで個別に変換する。

    res.json({ item: inserted });
  } catch (e) {
    console.error('[video-org] register error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==================== AI 解析（要承認）====================
router.post('/analyze', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    if (guards.isStopAll()) {
      return res.status(423).json({ error: 'STOP_ALL=true のため解析を停止しています' });
    }

    const { data: item, error: fetchError } = await supabase
      .from('video_file_organization_tests')
      .select('*').eq('drive_file_id', fileId).maybeSingle();
    if (fetchError) throw fetchError;
    if (!item) return res.status(404).json({ error: '先に register / upload が必要です' });

    if (!['waiting_approval', 'failed'].includes(item.status)) {
      return res.status(409).json({ error: `現在の status (${item.status}) からは解析できません` });
    }

    // 動画のみ長さガード（画像は対象外）
    const maxDuration = guards.getMaxDurationSeconds();
    if (item.media_kind === 'video' && item.video_duration_seconds && item.video_duration_seconds > maxDuration) {
      await supabase.from('video_file_organization_tests')
        .update({ status: 'skipped', error_message: `動画長 ${item.video_duration_seconds}s > MAX_DURATION_SECONDS=${maxDuration}s` })
        .eq('id', item.id);
      return res.status(422).json({ error: `動画が長すぎます (${item.video_duration_seconds}s > ${maxDuration}s)` });
    }

    if ((item.attempt_count || 0) >= guards.getMaxRetryCount()) {
      return res.status(429).json({ error: `MAX_RETRY_COUNT (${guards.getMaxRetryCount()}) に到達しています` });
    }

    const daily = await guards.checkDailyLimit();
    if (daily.exceeded) {
      return res.status(429).json({ error: `DAILY_ANALYSIS_LIMIT に到達しました (${daily.count}/${daily.limit})` });
    }

    await supabase.from('video_file_organization_tests')
      .update({
        status: 'processing',
        attempt_count: (item.attempt_count || 0) + 1,
        approved_by: req.user?.id || null,
        approved_at: new Date().toISOString(),
      })
      .eq('id', item.id);

    logCtx('analyze-start', {
      at: new Date().toISOString(), by: req.user?.email,
      fileId, fileName: item.original_filename, size: item.file_size,
      duration: item.video_duration_seconds, kind: item.media_kind,
      model: guards.getModelName(), dry_run: guards.isDryRun(),
      stop_all: guards.isStopAll(),
      daily_count: daily.count, daily_limit: daily.limit,
    });

    const buffer = await driveLib.downloadFileBuffer(fileId);
    const MAX_INLINE_BYTES = 20 * 1024 * 1024;
    if (buffer.length > MAX_INLINE_BYTES) {
      await supabase.from('video_file_organization_tests')
        .update({ status: 'skipped', error_message: `inline upload 上限 ${MAX_INLINE_BYTES} bytes 超過 (${buffer.length} bytes)` })
        .eq('id', item.id);
      return res.status(422).json({ error: `ファイルが大きすぎます (${buffer.length} bytes > ${MAX_INLINE_BYTES} bytes)` });
    }

    let analysis;
    try {
      analysis = await geminiLib.analyzeMedia({
        mediaBuffer: buffer,
        mimeType: item.mime_type,
        mediaKind: item.media_kind || 'video',
        originalFilename: item.original_filename,
      });
    } catch (e) {
      await supabase.from('video_file_organization_tests')
        .update({ status: 'failed', error_message: e.message, processed_at: new Date().toISOString() })
        .eq('id', item.id);
      logCtx('analyze-failed', { fileId, error: e.message });
      return res.status(502).json({ error: `Gemini 呼び出し失敗: ${e.message}` });
    }

    logCtx('analyze-response', { fileId, model: analysis.model, jsonParsed: !!analysis.parsed });

    if (!analysis.parsed) {
      await supabase.from('video_file_organization_tests')
        .update({
          status: 'failed', model: analysis.model, prompt_version: analysis.promptVersion,
          raw_response: { raw: analysis.raw },
          error_message: 'Gemini レスポンスが JSON としてパースできませんでした',
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      return res.status(502).json({ error: 'Gemini レスポンスが JSON ではありません', raw: analysis.raw });
    }

    const p = analysis.parsed;
    // tags: 配列で、各要素を文字列化し # 始まり保証
    const tagsRaw = Array.isArray(p.tags) ? p.tags : [];
    const tags = tagsRaw
      .map(t => String(t || '').trim())
      .filter(Boolean)
      .map(t => t.startsWith('#') ? t : '#' + t)
      .slice(0, 12);
    // scenes: 配列で {time, description} だけ抽出
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
      })
      .eq('id', item.id).select().single();
    if (updateError) throw updateError;

    res.json({ item: updated });
  } catch (e) {
    console.error('[video-org] analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 適用（DRY_RUN プレビュー）====================
router.post('/apply', async (req, res) => {
  const fileId = String(req.body?.fileId || '').trim();
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });

  try {
    if (guards.isStopAll()) {
      return res.status(423).json({ error: 'STOP_ALL=true のため適用を停止しています' });
    }

    const { data: item } = await supabase
      .from('video_file_organization_tests')
      .select('*').eq('drive_file_id', fileId).maybeSingle();
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
      at: new Date().toISOString(), by: req.user?.email,
      fileId, dry_run: dryRun, diff,
    });

    if (dryRun) return res.json({ applied: false, dry_run: true, diff });

    // 本適用は Stage 2 で別 PR
    return res.status(501).json({
      error: 'DRY_RUN=false での本適用は MVP 範囲外です。次フェーズで実装します',
      diff,
    });
  } catch (e) {
    console.error('[video-org] apply error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==================== 単一取得 ====================
// 注意: 上の /preview/:fileId / /list / /upload / /register / /analyze / /apply の後に置く
// （ルートマッチング順序事故防止）
router.get('/item/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId);
    const { data, error } = await supabase
      .from('video_file_organization_tests')
      .select('*').eq('drive_file_id', fileId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '登録されていません' });
    res.json({ item: data });
  } catch (e) {
    console.error('[video-org] get error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==================== faststart バックフィル ====================
// 既存行に対して faststart 版を改めて生成する。アップロード時の fire-and-forget が
// 失敗していた場合や、新規仕様適用前にアップロードされた行を救う用途。
router.post('/faststart/:fileId', async (req, res) => {
  const fileId = String(req.params.fileId);
  if (!fileId) return res.status(400).json({ error: 'fileId が必要です' });
  try {
    const { data: row, error: fetchError } = await supabase
      .from('video_file_organization_tests')
      .select('id, media_kind, faststart_status')
      .eq('drive_file_id', fileId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!row) return res.status(404).json({ error: '対象の素材が見つかりません' });
    if (row.media_kind !== 'video') {
      return res.status(422).json({ error: '動画以外は faststart 化できません' });
    }
    // 同期的に await（バックフィルは結果を返したい）。タイムアウトはクライアント側で許容する想定。
    const result = await generateFaststartForVideoOrg({ rowId: row.id });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[video-org] faststart backfill error:', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ==================== 削除 ====================
router.delete('/item/:fileId', async (req, res) => {
  try {
    const fileId = String(req.params.fileId);
    const { error } = await supabase
      .from('video_file_organization_tests')
      .delete().eq('drive_file_id', fileId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('[video-org] delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

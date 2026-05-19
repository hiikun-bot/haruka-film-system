// lib/faststart.js — クリエイティブ動画の faststart プレビュー版生成
//
// 方針（画質劣化ゼロを最優先）:
//   - 入力が MP4 + H.264 + AAC → `-c copy -movflags +faststart` で再エンコード無し
//     （メタデータ位置だけ先頭に移動。画質完全維持・処理も高速）
//   - それ以外（MOV / H.265 / ProRes / HEVC / その他コーデック）→
//     `-c:v libx264 -crf 18 -preset slow -c:a aac -b:a 192k -movflags +faststart`
//     （CRF 18 は視覚的に元と区別困難な高画質。容量は気にしない方針）
//   - 解像度・FPS は常に元のまま（リサイズ・FPS変換は一切しない）
//
// 呼び出し方:
//   const { generateFaststart } = require('../lib/faststart');
//   generateFaststart({ creativeFileId: row.id }).catch(err => console.error(err));
//
//   - Promise を返す。fire-and-forget でアップロード完了直後に呼び出す想定
//   - 内部で例外を握りつぶし、faststart_status='failed' と console.error に記録する
//   - クリエイティブ全体（アップロードAPI のレスポンス）は壊さない
//
// ON/OFF:
//   ENABLE_FASTSTART_AUTOGEN を 'false' / '0' / 'off' / 'no' に設定すると無効化
//   未指定なら ON（デフォルト動作）
//
// TODO: 同時実行数が増えたら p-queue 等で直列化する

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { google } = require('googleapis');
const { PassThrough } = require('stream');
const supabase = require('../supabase');

// FFmpeg / FFprobe 解決
let ffmpeg = null;
let ffmpegPath = null;
let ffprobePath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  ffmpeg = require('fluent-ffmpeg');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch (_) { /* fluent-ffmpeg / ffmpeg-static 未インストール */ }
try {
  // 任意依存。インストールされていれば codec 判定で使う。
  ffprobePath = require('@ffprobe-installer/ffprobe').path;
  if (ffmpeg && ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
} catch (_) { /* ffprobe が無ければ拡張子ベースの fallback で動く */ }

// ON/OFF 環境変数。未指定なら ON。
function isEnabled() {
  const v = (process.env.ENABLE_FASTSTART_AUTOGEN || '').trim().toLowerCase();
  if (!v) return true;
  return !['false', '0', 'off', 'no'].includes(v);
}

// MP4/MOV/M4V のみが re-mux 候補。WebM/MKV/AVI 等は対象外。
function isVideoCandidate(mimeType, fileName) {
  if (!ffmpeg) return false;
  if (mimeType && !mimeType.startsWith('video/')) return false;
  if (!fileName) return false;
  return /\.(mp4|mov|m4v)$/i.test(fileName);
}

// Drive サービス取得（routes/haruka.js と同じ pattern を再利用）
async function getDriveService() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ffprobe で codec を取得。失敗時は null を返す（呼び出し側で fallback ）。
function probeCodecs(filePath) {
  return new Promise((resolve) => {
    if (!ffmpeg || !ffprobePath) return resolve(null);
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data || !data.streams) return resolve(null);
      const v = data.streams.find(s => s.codec_type === 'video');
      const a = data.streams.find(s => s.codec_type === 'audio');
      resolve({
        videoCodec: v?.codec_name || null,
        audioCodec: a?.codec_name || null,
        formatName: data.format?.format_name || null,
      });
    });
  });
}

// 入力ファイルが「-c copy のみで faststart re-mux 可能か」を判定
function canCopyOnly(codecs, fileName) {
  if (!codecs) {
    // ffprobe が無い／失敗 → 拡張子のみで判定（保守的に MP4 のみ copy 許可）
    return /\.mp4$/i.test(fileName || '');
  }
  const v = (codecs.videoCodec || '').toLowerCase();
  const a = (codecs.audioCodec || '').toLowerCase();
  const f = (codecs.formatName || '').toLowerCase();
  // h264 + aac かつ MP4 系コンテナのみコピー
  const videoOk = v === 'h264';
  const audioOk = !a || a === 'aac' || a === 'mp4a-latm'; // 無音動画も許容
  const formatOk = f.includes('mp4') || f.includes('m4a') || f.includes('mov');
  return videoOk && audioOk && formatOk;
}

// 内部ヘルパ: 失敗マーク（table 引数で creative_files / video_file_organization_tests 両対応）
async function markFailed(table, rowId, msg) {
  try {
    await supabase.from(table).update({
      faststart_status: 'failed',
      faststart_processed_at: new Date().toISOString(),
    }).eq('id', rowId);
  } catch (_) {}
  console.error('[faststart] failed:', msg, { table, rowId });
}

// Drive 上の動画ファイルに対して ffmpeg で faststart 版を生成し、Drive にアップロードする純粋関数。
// DB I/O は一切しない（呼び出し側で行内容のロード・書き戻しを担当する）。
// 返り値: { ok, faststartDriveFileId, faststartUrl, faststartFileSize, mode } もしくは
//        { ok: false, error } / { skipped: true, reason }
async function _processDriveFile({ sourceDriveFileId, sourceFileName, sourceMimeType }) {
  if (!isEnabled()) return { skipped: true, reason: 'ENABLE_FASTSTART_AUTOGEN=off' };
  if (!ffmpeg) return { skipped: true, reason: 'ffmpeg-static / fluent-ffmpeg 未インストール' };
  if (!sourceDriveFileId) return { skipped: true, reason: 'no-drive-file-id' };
  if (!isVideoCandidate(sourceMimeType || 'video/mp4', sourceFileName)) {
    return { skipped: true, reason: 'not-video-candidate' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
  const safeName = (sourceFileName || 'master').replace(/[^\w.\-]/g, '_');
  const inputFp  = path.join(tmpDir, safeName);
  const outName  = (sourceFileName || 'master').replace(/\.(mp4|mov|m4v)$/i, '_faststart.mp4');
  const outputFp = path.join(tmpDir, outName.replace(/[^\w.\-]/g, '_'));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

  try {
    const drive = await getDriveService();

    const meta = await drive.files.get({
      fileId: sourceDriveFileId,
      fields: 'parents,mimeType,size',
      supportsAllDrives: true,
    });
    const parentFolderId = meta.data.parents?.[0];
    if (!parentFolderId) {
      return { ok: false, error: 'parent folder not found' };
    }
    const driveMime = meta.data.mimeType || sourceMimeType || 'video/mp4';
    const driveSize = parseInt(meta.data.size || '0', 10) || null;

    const dlRes = await drive.files.get(
      { fileId: sourceDriveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    fs.writeFileSync(inputFp, Buffer.from(dlRes.data));

    const codecs = await probeCodecs(inputFp);
    const copyOnly = canCopyOnly(codecs, sourceFileName);

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputFp);
      if (copyOnly) {
        cmd.outputOptions(['-c copy', '-movflags +faststart']);
      } else {
        cmd.outputOptions([
          '-c:v libx264',
          '-crf 18',
          '-preset slow',
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart',
        ]);
      }
      cmd.on('end', resolve).on('error', reject).save(outputFp);
    });

    const outBuf  = fs.readFileSync(outputFp);
    const outSize = outBuf.length;

    const pt = new PassThrough();
    pt.end(outBuf);
    const upRes = await drive.files.create({
      requestBody: { name: outName, parents: [parentFolderId] },
      media: { mimeType: 'video/mp4', body: pt },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    try {
      await drive.permissions.create({
        fileId: upRes.data.id,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch (_) { /* 失敗は致命的でない */ }

    return {
      ok: true,
      mode: copyOnly ? 'copy' : 'reencode',
      faststartDriveFileId: upRes.data.id,
      faststartUrl: upRes.data.webViewLink || null,
      faststartFileSize: outSize,
      sourceMimeType: driveMime,
      sourceFileSize: driveSize,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    cleanup();
  }
}

// 既存 API: creative_files 用ラッパ。
// 呼び出し側は await 不要（fire-and-forget）。
async function generateFaststart(arg) {
  if (!isEnabled()) return { skipped: true, reason: 'ENABLE_FASTSTART_AUTOGEN=off' };
  if (!ffmpeg) return { skipped: true, reason: 'ffmpeg-static / fluent-ffmpeg 未インストール' };

  const { creativeFileId } = arg || {};
  if (!creativeFileId) throw new Error('creativeFileId が必要です');

  const { data: cf, error } = await supabase
    .from('creative_files')
    .select('id, drive_file_id, generated_name, mime_type, faststart_drive_file_id, faststart_status')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (error || !cf) {
    console.warn('[faststart] creative_files row not found:', creativeFileId, error?.message);
    return { skipped: true, reason: 'row-not-found' };
  }
  if (!cf.drive_file_id) return { skipped: true, reason: 'no-drive-file-id' };
  if (cf.faststart_drive_file_id && cf.faststart_status === 'done') {
    return { skipped: true, reason: 'already-done' };
  }
  if (!isVideoCandidate(cf.mime_type || 'video/mp4', cf.generated_name)) {
    try {
      await supabase.from('creative_files').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', creativeFileId);
    } catch (_) {}
    return { skipped: true, reason: 'not-video-candidate' };
  }

  try {
    await supabase.from('creative_files')
      .update({ faststart_status: 'processing' })
      .eq('id', creativeFileId);
  } catch (e) {
    console.warn('[faststart] processing マーク失敗:', e.message);
  }

  const result = await _processDriveFile({
    sourceDriveFileId: cf.drive_file_id,
    sourceFileName:    cf.generated_name,
    sourceMimeType:    cf.mime_type,
  });

  if (result.skipped) {
    try {
      await supabase.from('creative_files').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', creativeFileId);
    } catch (_) {}
    return result;
  }
  if (!result.ok) {
    await markFailed('creative_files', creativeFileId, result.error);
    return result;
  }

  // mime_type / file_size のキャッシュも更新（任意）
  try {
    await supabase.from('creative_files').update({
      mime_type: result.sourceMimeType,
      file_size: result.sourceFileSize,
    }).eq('id', creativeFileId);
  } catch (_) {}

  await supabase.from('creative_files').update({
    faststart_drive_file_id: result.faststartDriveFileId,
    faststart_drive_url:     result.faststartUrl,
    faststart_file_size:     result.faststartFileSize,
    faststart_status:        'done',
    faststart_processed_at:  new Date().toISOString(),
  }).eq('id', creativeFileId);

  console.log('[faststart] done:', {
    creativeFileId, mode: result.mode, outSize: result.faststartFileSize,
    faststartId: result.faststartDriveFileId,
  });
  return { ok: true, mode: result.mode, outSize: result.faststartFileSize, faststartId: result.faststartDriveFileId };
}

// 素材広場 (video_file_organization_tests) 用ラッパ。
// 呼び出し側は await 不要（fire-and-forget）。
async function generateFaststartForVideoOrg(arg) {
  if (!isEnabled()) return { skipped: true, reason: 'ENABLE_FASTSTART_AUTOGEN=off' };
  if (!ffmpeg) return { skipped: true, reason: 'ffmpeg-static / fluent-ffmpeg 未インストール' };

  const { rowId } = arg || {};
  if (!rowId) throw new Error('rowId が必要です');

  const { data: row, error } = await supabase
    .from('video_file_organization_tests')
    .select('id, drive_file_id, current_filename, original_filename, mime_type, faststart_drive_file_id, faststart_status, media_kind')
    .eq('id', rowId)
    .maybeSingle();
  if (error || !row) {
    console.warn('[faststart] video_file_organization_tests row not found:', rowId, error?.message);
    return { skipped: true, reason: 'row-not-found' };
  }
  if (!row.drive_file_id) return { skipped: true, reason: 'no-drive-file-id' };
  if (row.faststart_drive_file_id && row.faststart_status === 'done') {
    return { skipped: true, reason: 'already-done' };
  }
  // 画像は対象外
  if (row.media_kind && row.media_kind !== 'video') {
    try {
      await supabase.from('video_file_organization_tests').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', rowId);
    } catch (_) {}
    return { skipped: true, reason: 'not-video-kind' };
  }
  const sourceFileName = row.current_filename || row.original_filename;
  if (!isVideoCandidate(row.mime_type || 'video/mp4', sourceFileName)) {
    try {
      await supabase.from('video_file_organization_tests').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', rowId);
    } catch (_) {}
    return { skipped: true, reason: 'not-video-candidate' };
  }

  try {
    await supabase.from('video_file_organization_tests')
      .update({ faststart_status: 'processing' })
      .eq('id', rowId);
  } catch (e) {
    console.warn('[faststart] processing マーク失敗:', e.message);
  }

  const result = await _processDriveFile({
    sourceDriveFileId: row.drive_file_id,
    sourceFileName:    sourceFileName,
    sourceMimeType:    row.mime_type,
  });

  if (result.skipped) {
    try {
      await supabase.from('video_file_organization_tests').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', rowId);
    } catch (_) {}
    return result;
  }
  if (!result.ok) {
    await markFailed('video_file_organization_tests', rowId, result.error);
    return result;
  }

  await supabase.from('video_file_organization_tests').update({
    faststart_drive_file_id: result.faststartDriveFileId,
    faststart_drive_url:     result.faststartUrl,
    faststart_file_size:     result.faststartFileSize,
    faststart_status:        'done',
    faststart_processed_at:  new Date().toISOString(),
  }).eq('id', rowId);

  console.log('[faststart] done (video-org):', {
    rowId, mode: result.mode, outSize: result.faststartFileSize,
    faststartId: result.faststartDriveFileId,
  });
  return { ok: true, mode: result.mode, outSize: result.faststartFileSize, faststartId: result.faststartDriveFileId };
}

// ===================================================================
// 新方式: 全動画一律 WebP 60枚ストーリーボード（preview_* 列に書く）
//
//   - 過去は動画長で分岐していた（短尺=H.264 faststart / 長尺=WebP 60枚）が、
//     Drive 容量2倍化を避けるため **全動画一律 WebP 60枚** に統一した。
//   - preview_strategy は常に 'webp_storyboard'。
//   - _processDriveFile / generateFaststartForVideoOrg / canCopyOnly / isVideoCandidate
//     は creative_files など他の経路で使うので残してある（preview には使わない）。
// ===================================================================

const STORYBOARD_FRAME_COUNT = 60;

// 内部ヘルパ: preview_* 列を一括で更新
async function _updatePreviewRow(rowId, patch) {
  try {
    await supabase.from('video_file_organization_tests')
      .update(patch)
      .eq('id', rowId);
  } catch (e) {
    console.warn('[preview] update failed:', e.message);
  }
}

async function _markPreviewFailed(rowId, msg) {
  await _updatePreviewRow(rowId, {
    preview_status: 'failed',
    preview_progress_percent: null,
    preview_processed_at: new Date().toISOString(),
  });
  console.error('[preview] failed:', msg, { rowId });
}

// ffprobe で 1 フレームの YAVG（輝度平均）を取得する。失敗時は null。
function _measureFrameYAvg(filePath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    // signalstats フィルタの結果はログに出る。stderr をパースする。
    let log = '';
    ffmpeg(filePath)
      .outputOptions(['-vf', 'signalstats', '-f', 'null'])
      .on('stderr', (line) => { log += line + '\n'; })
      .on('end', () => {
        const m = log.match(/YAVG:([\d.]+)/);
        resolve(m ? Number(m[1]) : null);
      })
      .on('error', () => resolve(null))
      .saveToFile(process.platform === 'win32' ? 'NUL' : '/dev/null');
  });
}

// 指定タイムスタンプで 1 フレームを抽出（jpg）。署名付き Drive URL でも HTTPS URL でも可。
function _extractFrameAt({ inputArg, timestamp, outputPath }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return reject(new Error('ffmpeg not available'));
    ffmpeg()
      .input(inputArg)
      .inputOptions(['-ss', String(timestamp)])
      .outputOptions(['-frames:v', '1', '-q:v', '3', '-y'])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// 60 枚の jpg から WebP アニメーションを作成
function _buildWebpFromFrames({ pattern, outputPath, framerate = 1 }) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return reject(new Error('ffmpeg not available'));
    ffmpeg()
      .input(pattern)
      .inputOptions(['-framerate', String(framerate)])
      .outputOptions([
        '-c:v', 'libwebp',
        '-loop', '0',
        '-q:v', '70',
        '-an',
        '-pix_fmt', 'yuv420p',
        '-y',
      ])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// Drive ファイルから 60 枚 → WebP を生成して Drive にアップロード
// 動画長は呼び出し側で取得済みの想定だが、未取得（null）の場合は ffprobe で測る。
// rowId を渡せば preview_progress_percent をフレーム抽出ループ中に随時更新する。
//
// uploadAsUserDrive: user OAuth で作った Drive クライアント。指定があれば WebP の最終
//   アップロードと permissions.create をこのクライアントで実行する。これにより WebP の
//   所有者がユーザー本人になり、後続の削除・移動（drive.file スコープ）が「自分が作った
//   ファイル」として可視になる。null/undefined の場合は SA でアップロード（フォールバック）。
//   メタデータ取得・動画 DL・フレーム抽出は SA のままで OK（読み取りは SA も問題ない）。
async function _processVideoStoryboard({ sourceDriveFileId, sourceFileName, durationSeconds, rowId, uploadAsUserDrive }) {
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not available' };
  if (!sourceDriveFileId) return { ok: false, error: 'no-drive-file-id' };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-sb-'));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

  try {
    const drive = await getDriveService();
    // 親フォルダを取得（Drive アップロード先）
    const meta = await drive.files.get({
      fileId: sourceDriveFileId,
      fields: 'parents,mimeType,size',
      supportsAllDrives: true,
    });
    const parentFolderId = meta.data.parents?.[0];
    if (!parentFolderId) return { ok: false, error: 'parent folder not found' };

    // 長尺は全DLを避けたい。実装シンプル化のため、各フレームごとに Drive から
    // 「その時刻周辺の数MB」だけを取り出すストリーム方式は googleapis では難しいので、
    // 「一度ローカルに全DLしてから seek 抽出」する。Drive の Range stream 経由で
    // arraybuffer 全 DL する既存方式と本質的には同じだが、ffmpeg の -ss で必要な
    // タイムスタンプだけ読み出すので、抽出処理自体は高速。
    //
    // 注意: メモリ事故防止のため、driveLib.downloadFileBuffer 相当を直接使わず
    // ストリームでローカルファイルに書き出す。
    const inputFp = path.join(tmpDir, 'input.mp4');
    {
      const dlRes = await drive.files.get(
        { fileId: sourceDriveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(inputFp);
        dlRes.data.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        dlRes.data.pipe(ws);
      });
    }

    // 動画長が未取得なら ffprobe で測る（全動画一律処理にしたため、短尺でも必要）
    let effectiveDuration = Number(durationSeconds) || 0;
    if (!effectiveDuration || effectiveDuration <= 0) {
      const probed = await new Promise((resolve) => {
        if (!ffmpeg || !ffprobePath) return resolve(null);
        ffmpeg.ffprobe(inputFp, (err, data) => {
          if (err || !data) return resolve(null);
          resolve(Number(data.format?.duration) || null);
        });
      });
      if (probed && probed > 0) effectiveDuration = probed;
    }
    if (!effectiveDuration || effectiveDuration <= 0) {
      return { ok: false, error: 'duration unknown' };
    }

    // 抽出区間: 2%地点 〜 98%地点
    const startT = Math.max(0.5, effectiveDuration * 0.02);
    const endT   = Math.max(startT + 0.5, effectiveDuration * 0.98);
    const span   = endT - startT;
    const N      = STORYBOARD_FRAME_COUNT;
    const baseTimestamps = [];
    for (let i = 0; i < N; i++) {
      // 等間隔 0..N-1 を span に張る
      baseTimestamps.push(startT + (span * i) / (N - 1));
    }

    // 各フレームを抽出。暗すぎる場合 ±1 秒の範囲で 0.2 秒刻みで再試行。
    const FRAME_DIR = tmpDir;
    for (let i = 0; i < N; i++) {
      // 進捗を 5 フレームごとに DB に書く（rowId が渡されている時のみ）。
      // UPDATE 失敗は処理を止めない（_updatePreviewRow が try/catch 内蔵）。
      // ★ await して順序を保証する。fire-and-forget だと最後の「done + percent=null」UPDATE より
      //   後に in-flight の percent=95 UPDATE が遅延着信して、status='done' なのに percent=95 が
      //   残るレースが発生する（95% 進捗バーが消えない不具合）。
      if (rowId && (i % 5 === 0)) {
        const pct = Math.floor((i + 1) / N * 100);
        await _updatePreviewRow(rowId, { preview_progress_percent: pct });
      }
      const baseTs = baseTimestamps[i];
      const idx1 = String(i + 1).padStart(3, '0');
      const outPath = path.join(FRAME_DIR, `frame_${idx1}.jpg`);

      // まず baseTs で抽出
      try {
        await _extractFrameAt({ inputArg: inputFp, timestamp: baseTs, outputPath: outPath });
      } catch (e) {
        // 取得失敗。前のフレームをコピーして埋める。
        if (i > 0) {
          const prev = path.join(FRAME_DIR, `frame_${String(i).padStart(3, '0')}.jpg`);
          try { fs.copyFileSync(prev, outPath); } catch (_) {}
        }
        continue;
      }

      // 輝度が低すぎたら近隣で再試行
      const yavg = await _measureFrameYAvg(outPath);
      if (yavg !== null && yavg < 16) {
        const candidates = [];
        for (let off = -1.0; off <= 1.0 + 1e-9; off += 0.2) {
          if (Math.abs(off) < 1e-9) continue;
          const t = baseTs + off;
          if (t < 0 || t > effectiveDuration) continue;
          candidates.push(t);
        }
        let bestPath = outPath;
        let bestY = yavg;
        for (const t of candidates) {
          const tryPath = path.join(FRAME_DIR, `try_${idx1}_${t.toFixed(2)}.jpg`);
          try {
            await _extractFrameAt({ inputArg: inputFp, timestamp: t, outputPath: tryPath });
            const y = await _measureFrameYAvg(tryPath);
            if (y !== null && y > bestY) {
              bestY = y;
              bestPath = tryPath;
              if (bestY >= 16) break; // 十分明るくなったら早期終了
            }
          } catch (_) { /* 個別失敗は無視 */ }
        }
        if (bestPath !== outPath) {
          try { fs.copyFileSync(bestPath, outPath); } catch (_) {}
        }
      }
    }

    // WebP 化フェーズ開始: 進捗 95% に書き換え（rowId が渡されている時のみ）。
    // ★ await して順序を保証する（最後の「done + percent=null」UPDATE より後に着信させない）。
    if (rowId) await _updatePreviewRow(rowId, { preview_progress_percent: 95 });

    // WebP アニメ生成（1fps = 60秒のループ動画。雰囲気把握用なので軽い）。
    // ★ ファイル名は「原本の拡張子を .webp に差し替えただけ」。
    //   例) 「ピカチュウのお絵かきうた.mp4」 → 「ピカチュウのお絵かきうた.webp」
    //   Drive はファイルIDで識別するので、同名ファイルが複数あっても問題なし。
    //   ユーザーが Drive を直接見たときに、原本と WebP のペアが一目で分かることを優先する。
    const baseName = (sourceFileName || 'preview').replace(/\.[^.]+$/, '');
    const outName = `${baseName}.webp`;
    // ローカル一時ファイル名は OS が嫌がる文字を避けるため sanitize する（Drive 上のファイル名 outName は触らない）。
    const safeLocalName = outName.replace(/[^\w.\-]/g, '_');
    const outFp = path.join(tmpDir, safeLocalName);
    await _buildWebpFromFrames({
      pattern: path.join(FRAME_DIR, 'frame_%03d.jpg'),
      outputPath: outFp,
      framerate: 1,
    });

    const outBuf = fs.readFileSync(outFp);
    const outSize = outBuf.length;

    // Drive にアップロード（画像 image/webp として）
    // user OAuth クライアントが渡されていればそちらでアップロードする（所有者=ユーザー）。
    // 失敗時は SA でフォールバック（preview 生成自体は止めない）。
    const pt = new PassThrough();
    pt.end(outBuf);
    let uploadDrive = uploadAsUserDrive || drive;
    let uploadedAsUser = !!uploadAsUserDrive;
    let upRes;
    try {
      upRes = await uploadDrive.files.create({
        requestBody: { name: outName, parents: [parentFolderId], mimeType: 'image/webp' },
        media: { mimeType: 'image/webp', body: pt },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });
    } catch (e) {
      if (uploadAsUserDrive) {
        // user OAuth でアップロード失敗 → SA フォールバック
        console.warn('[preview] user OAuth upload failed, falling back to SA:', e?.message || e);
        const pt2 = new PassThrough();
        pt2.end(outBuf);
        uploadDrive = drive;
        uploadedAsUser = false;
        upRes = await drive.files.create({
          requestBody: { name: outName, parents: [parentFolderId], mimeType: 'image/webp' },
          media: { mimeType: 'image/webp', body: pt2 },
          fields: 'id, webViewLink',
          supportsAllDrives: true,
        });
      } else {
        throw e;
      }
    }

    try {
      await uploadDrive.permissions.create({
        fileId: upRes.data.id,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch (_) { /* 致命的でない */ }

    return {
      ok: true,
      previewDriveFileId: upRes.data.id,
      previewUrl: upRes.data.webViewLink || null,
      previewFileSize: outSize,
      previewMimeType: 'image/webp',
      effectiveDuration,
      uploadedAsUser,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    cleanup();
  }
}

// 素材広場 (video_file_organization_tests) 用: 全動画一律 WebP 60枚ストーリーボード生成。
// fire-and-forget で呼ぶ。失敗は preview_status='failed' に記録される。
//
// 旧設計（短尺=H.264 faststart / 長尺=WebP）は Drive 容量2倍化を招くため撤廃した。
// 全動画一律 webp_storyboard に統一することで、Drive 容量増は常に~500KB に収まる。
async function generatePreviewForVideoOrg(arg) {
  if (!isEnabled()) return { skipped: true, reason: 'ENABLE_FASTSTART_AUTOGEN=off' };
  if (!ffmpeg) return { skipped: true, reason: 'ffmpeg-static / fluent-ffmpeg 未インストール' };

  const { rowId } = arg || {};
  if (!rowId) throw new Error('rowId が必要です');

  const { data: row, error } = await supabase
    .from('video_file_organization_tests')
    .select([
      'id', 'drive_file_id', 'current_filename', 'original_filename',
      'mime_type', 'video_duration_seconds', 'media_kind',
      'preview_drive_file_id', 'preview_status', 'preview_progress_percent',
      'created_by',
    ].join(', '))
    .eq('id', rowId)
    .maybeSingle();
  if (error || !row) {
    console.warn('[preview] row not found:', rowId, error?.message);
    return { skipped: true, reason: 'row-not-found' };
  }
  if (!row.drive_file_id) return { skipped: true, reason: 'no-drive-file-id' };
  if (row.preview_drive_file_id && row.preview_status === 'done') {
    return { skipped: true, reason: 'already-done' };
  }
  // 画像は対象外
  if (row.media_kind && row.media_kind !== 'video') {
    await _updatePreviewRow(rowId, {
      preview_status: 'skipped',
      preview_progress_percent: null,
      preview_processed_at: new Date().toISOString(),
    });
    return { skipped: true, reason: 'not-video-kind' };
  }

  const sourceFileName = row.current_filename || row.original_filename;
  const dur = Number(row.video_duration_seconds) || null;

  // processing マーク（進捗 0% から開始）
  await _updatePreviewRow(rowId, {
    preview_status: 'processing',
    preview_progress_percent: 0,
  });

  // WebP の最終アップロードを user OAuth で行うためのクライアントを用意する。
  // - 目的: WebP を「アップロードしたユーザー本人の所有」にし、user OAuth (drive.file)
  //   の後続操作（削除・移動）から可視にする
  // - user OAuth が未連携／token 取得失敗時は null を渡し、SA フォールバックさせる
  let uploadAsUserDrive = null;
  if (row.created_by) {
    try {
      const googleOAuth = require('./google-oauth');
      const driveLib = require('./video-organization/drive');
      const token = await googleOAuth.getValidAccessToken({ userId: row.created_by, scopeKey: 'drive.file' });
      if (token && token.accessToken) {
        uploadAsUserDrive = driveLib.driveClientWithToken(token.accessToken);
      } else {
        console.warn('[preview] user OAuth token not available, will upload as SA:', { rowId, userId: row.created_by });
      }
    } catch (e) {
      console.warn('[preview] failed to acquire user OAuth client, will upload as SA:', e?.message || e);
    }
  }

  // 全動画一律: WebP 60枚ストーリーボード
  const result = await _processVideoStoryboard({
    sourceDriveFileId: row.drive_file_id,
    sourceFileName:    sourceFileName,
    durationSeconds:   dur,
    rowId:             rowId,
    uploadAsUserDrive: uploadAsUserDrive,
  });
  if (!result.ok) {
    await _markPreviewFailed(rowId, result.error);
    return result;
  }
  // 動画長は ffprobe で再測される場合があるので、実測値を保存（短尺で DB に未保存だったケース対応）
  const persistedDuration = (Number(result.effectiveDuration) > 0)
    ? Number(result.effectiveDuration)
    : dur;
  await _updatePreviewRow(rowId, {
    preview_drive_file_id: result.previewDriveFileId,
    preview_drive_url:     result.previewUrl,
    preview_file_size:     result.previewFileSize,
    preview_mime_type:     result.previewMimeType,
    preview_strategy:      'webp_storyboard',
    preview_status:        'done',
    preview_progress_percent: null,
    preview_duration_seconds: persistedDuration,
    preview_processed_at:  new Date().toISOString(),
    // DB に動画長が無かった行は今回の実測値で埋める（NULL 上書き）
    ...(!dur && persistedDuration ? { video_duration_seconds: persistedDuration } : {}),
  });
  console.log('[preview] done (webp):', {
    rowId, outSize: result.previewFileSize, duration: persistedDuration,
    uploadedAsUser: !!result.uploadedAsUser,
  });
  return { ok: true, strategy: 'webp_storyboard', outSize: result.previewFileSize };
}

module.exports = {
  generateFaststart,
  generateFaststartForVideoOrg,
  generatePreviewForVideoOrg,
  isVideoCandidate,
  canCopyOnly,
  isEnabled,
};

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

module.exports = {
  generateFaststart,
  generateFaststartForVideoOrg,
  isVideoCandidate,
  canCopyOnly,
  isEnabled,
};

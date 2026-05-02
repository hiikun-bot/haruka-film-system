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

// 内部ヘルパ: 失敗マーク
async function markFailed(creativeFileId, msg) {
  try {
    await supabase.from('creative_files').update({
      faststart_status: 'failed',
      faststart_processed_at: new Date().toISOString(),
    }).eq('id', creativeFileId);
  } catch (_) {}
  console.error('[faststart] failed:', msg, { creativeFileId });
}

// メイン: creativeFileId を受け取り、Drive の原本から faststart 版を生成して保存。
// 呼び出し側は await 不要（fire-and-forget）。
async function generateFaststart(arg) {
  if (!isEnabled()) return { skipped: true, reason: 'ENABLE_FASTSTART_AUTOGEN=off' };
  if (!ffmpeg) return { skipped: true, reason: 'ffmpeg-static / fluent-ffmpeg 未インストール' };

  const { creativeFileId } = arg || {};
  if (!creativeFileId) throw new Error('creativeFileId が必要です');

  // DB から原本情報取得
  const { data: cf, error } = await supabase
    .from('creative_files')
    .select('id, drive_file_id, generated_name, mime_type, faststart_drive_file_id, faststart_status')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (error || !cf) {
    console.warn('[faststart] creative_files row not found:', creativeFileId, error?.message);
    return { skipped: true, reason: 'row-not-found' };
  }
  if (!cf.drive_file_id) {
    return { skipped: true, reason: 'no-drive-file-id' };
  }
  if (cf.faststart_drive_file_id && cf.faststart_status === 'done') {
    return { skipped: true, reason: 'already-done' };
  }
  if (!isVideoCandidate(cf.mime_type || 'video/mp4', cf.generated_name)) {
    // 動画候補でないので skipped としてマーク
    try {
      await supabase.from('creative_files').update({
        faststart_status: 'skipped',
        faststart_processed_at: new Date().toISOString(),
      }).eq('id', creativeFileId);
    } catch (_) {}
    return { skipped: true, reason: 'not-video-candidate' };
  }

  // 進行中マーク
  try {
    await supabase.from('creative_files')
      .update({ faststart_status: 'processing' })
      .eq('id', creativeFileId);
  } catch (e) {
    console.warn('[faststart] processing マーク失敗:', e.message);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
  const safeName = (cf.generated_name || 'master').replace(/[^\w.\-]/g, '_');
  const inputFp  = path.join(tmpDir, safeName);
  const outName  = (cf.generated_name || 'master').replace(/\.(mp4|mov|m4v)$/i, '_faststart.mp4');
  const outputFp = path.join(tmpDir, outName.replace(/[^\w.\-]/g, '_'));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

  try {
    const drive = await getDriveService();

    // 親フォルダ取得（faststart 版を同じフォルダにアップロード）
    const meta = await drive.files.get({
      fileId: cf.drive_file_id,
      fields: 'parents,mimeType,size',
      supportsAllDrives: true,
    });
    const parentFolderId = meta.data.parents?.[0];
    if (!parentFolderId) {
      await markFailed(creativeFileId, 'parent folder not found');
      return { ok: false, reason: 'no-parent' };
    }
    const driveMime = meta.data.mimeType || cf.mime_type || 'video/mp4';

    // mime_type / file_size のキャッシュも更新
    try {
      await supabase.from('creative_files').update({
        mime_type: driveMime,
        file_size: parseInt(meta.data.size || '0', 10) || null,
      }).eq('id', creativeFileId);
    } catch (_) { /* 列が無い古い DB は無視 */ }

    // Drive から一時ファイルへダウンロード
    const dlRes = await drive.files.get(
      { fileId: cf.drive_file_id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    fs.writeFileSync(inputFp, Buffer.from(dlRes.data));

    // codec 判定
    const codecs = await probeCodecs(inputFp);
    const copyOnly = canCopyOnly(codecs, cf.generated_name);

    // ffmpeg 実行
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputFp);
      if (copyOnly) {
        // 画質完全維持: re-mux のみ
        cmd.outputOptions(['-c copy', '-movflags +faststart']);
      } else {
        // 高画質再エンコード（CRF 18 / preset slow）。解像度・FPS は元のまま。
        cmd.outputOptions([
          '-c:v libx264',
          '-crf 18',
          '-preset slow',
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart',
        ]);
      }
      cmd
        .on('end', resolve)
        .on('error', reject)
        .save(outputFp);
    });

    // Drive にアップロード（同じ親フォルダ・"_faststart.mp4" suffix）
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

    // 公開権限（既存原本と同様 reader / anyone）
    try {
      await drive.permissions.create({
        fileId: upRes.data.id,
        supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch (_) { /* 失敗は致命的でない */ }

    // DB 更新
    await supabase.from('creative_files').update({
      faststart_drive_file_id: upRes.data.id,
      faststart_drive_url:     upRes.data.webViewLink,
      faststart_file_size:     outSize,
      faststart_status:        'done',
      faststart_processed_at:  new Date().toISOString(),
    }).eq('id', creativeFileId);

    console.log('[faststart] done:', {
      creativeFileId,
      mode: copyOnly ? 'copy' : 'reencode',
      outSize,
      faststartId: upRes.data.id,
    });
    return { ok: true, mode: copyOnly ? 'copy' : 'reencode', outSize, faststartId: upRes.data.id };
  } catch (e) {
    console.error('[faststart] generation error:', e?.stack || e?.message || e);
    await markFailed(creativeFileId, e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  } finally {
    cleanup();
  }
}

module.exports = {
  generateFaststart,
  isVideoCandidate,
  canCopyOnly,
  isEnabled,
};

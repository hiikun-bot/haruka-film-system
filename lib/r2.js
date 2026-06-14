// lib/r2.js — クリエイティブ動画の再生用ホットキャッシュ（Cloudflare R2）
//
// 目的:
//   動画添削の再生が遅い主因は「ブラウザ ← Railway ← Google Drive」の二段ホップ
//   プロキシ配信（CDN 不在）。faststart 版を Cloudflare R2 へ複製し、署名 URL で
//   ブラウザに直接 Range 配信する（egress 無料・Cloudflare 網から配信）。
//
// ライフサイクル（ストレージを圧迫しないための要）:
//   アップロード → faststart 生成 → R2 へ複製 (r2_status='active')
//   レビュー中    → /stream は R2 署名 URL(302) で配信
//   status='納品' → R2 オブジェクト削除 (r2_status='evicted')
//                   ※Drive には原本が残り続ける＝それがバックアップ
//   納品後の再視聴 → R2 無し → Drive プロキシにフォールバック（稀・許容）
//
//   → R2 常駐はレビュー中の動画だけ（実測 ~1.5GB）。納品のたびに排出され累積しない。
//
// ON/OFF:
//   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET が
//   すべて揃っているときだけ有効。未設定なら isEnabled()===false で、呼び出し側は
//   従来の Drive プロキシ配信にフォールバックする（安全にマージできる）。

const { google } = require('googleapis');
const supabase = require('../supabase');

let S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, Upload, getSignedUrl;
let sdkLoaded = false;
function loadSdk() {
  if (sdkLoaded) return;
  sdkLoaded = true;
  try {
    ({ S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3'));
    ({ Upload } = require('@aws-sdk/lib-storage'));
    ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  } catch (e) {
    console.warn('[r2] @aws-sdk/* 未インストール:', e.message);
  }
}

function isEnabled() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function bucket() { return process.env.R2_BUCKET; }

let _client = null;
function getClient() {
  if (!isEnabled()) throw new Error('R2 未設定（R2_* 環境変数が不足）');
  loadSdk();
  if (!S3Client) throw new Error('@aws-sdk/client-s3 が読み込めません');
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

// 再生用オブジェクトキー。creative_files.id 起点で一意。拡張子は再生互換の .mp4 固定。
function objectKeyForCreativeFile(creativeFileId) {
  return `creative-preview/${creativeFileId}.mp4`;
}

// 署名付き GET URL を発行。<video> は 302 redirect 経由で Range 取得する。
// 有効期限は再生セッション中に切れないよう長め（既定 6h）。
async function presignGetUrl(key, { expiresIn = 6 * 60 * 60 } = {}) {
  loadSdk();
  const command = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function deleteObject(key) {
  loadSdk();
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

async function objectExists(key) {
  loadSdk();
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
    throw e;
  }
}

// ---- Drive → R2 ストリーム複製 ----

async function getDriveService() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// Drive 上のファイルを R2 へストリーム複製する（メモリに全展開しない）。
//   driveFileId : 複製元（faststart 版の drive_file_id を渡す想定）
//   key         : R2 オブジェクトキー
//   contentType : 省略時は video/mp4
// 戻り値: { key, size }
async function replicateDriveFileToR2({ driveFileId, key, contentType = 'video/mp4' }) {
  if (!isEnabled()) throw new Error('R2 未設定');
  loadSdk();
  if (!Upload) throw new Error('@aws-sdk/lib-storage が読み込めません');
  const drive = await getDriveService();
  const driveRes = await drive.files.get(
    { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: driveRes.data,
      ContentType: contentType,
    },
    // 動画は数十〜数百MB。8MB パートのマルチパートで安定アップロード。
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
  });
  await upload.done();
  return { key };
}

// ---- creative_files 連携のオーケストレーション ----

// 1ファイルを R2 へ複製し、creative_files.r2_* を更新する。fire-and-forget で呼ぶ想定。
// 複製元は faststart 版があればそれ、無ければ原本（画質維持・無劣化）。
async function replicateCreativeFileToR2(creativeFileId) {
  if (!isEnabled()) return { skipped: true, reason: 'r2-disabled' };
  const { data: cf } = await supabase
    .from('creative_files')
    .select('id, drive_file_id, faststart_drive_file_id, faststart_status, mime_type')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (!cf) return { skipped: true, reason: 'not-found' };
  const sourceId = (cf.faststart_status === 'done' && cf.faststart_drive_file_id)
    ? cf.faststart_drive_file_id
    : cf.drive_file_id;
  if (!sourceId) return { skipped: true, reason: 'no-drive-file' };

  const key = objectKeyForCreativeFile(cf.id);
  try {
    await replicateDriveFileToR2({ driveFileId: sourceId, key, contentType: cf.mime_type || 'video/mp4' });
    await supabase.from('creative_files').update({
      r2_key: key,
      r2_status: 'active',
      r2_uploaded_at: new Date().toISOString(),
    }).eq('id', cf.id);
    console.log('[r2] replicated:', { creativeFileId: cf.id, key });
    return { ok: true, key };
  } catch (e) {
    console.error('[r2] replicate failed:', cf.id, e.message);
    await supabase.from('creative_files').update({ r2_status: 'failed' }).eq('id', cf.id).then(() => {}, () => {});
    return { ok: false, error: e.message };
  }
}

// R2 オブジェクトを削除して r2_status='evicted' にする（Drive 原本は残る＝バックアップ）。
async function evictCreativeFileFromR2(creativeFileId) {
  const { data: cf } = await supabase
    .from('creative_files')
    .select('id, r2_key, r2_status')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (!cf || !cf.r2_key) return { skipped: true, reason: 'no-r2-object' };
  if (isEnabled()) {
    try {
      await deleteObject(cf.r2_key);
    } catch (e) {
      // 既に消えている等は致命的でない（最終的に r2_status を更新できればよい）
      if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') {
        console.warn('[r2] deleteObject 失敗(続行):', cf.r2_key, e.message);
      }
    }
  }
  await supabase.from('creative_files').update({ r2_status: 'evicted' }).eq('id', cf.id);
  return { ok: true, key: cf.r2_key };
}

// 指定クリエイティブ配下の R2 複製を一括排出（納品遷移時に即時で呼ぶ）。
async function evictCreativeR2Replicas(creativeId) {
  const { data: files } = await supabase
    .from('creative_files')
    .select('id')
    .eq('creative_id', creativeId)
    .eq('r2_status', 'active');
  let evicted = 0;
  for (const f of (files || [])) {
    const r = await evictCreativeFileFromR2(f.id);
    if (r?.ok) evicted++;
  }
  return { evicted };
}

// 納品済み(creatives.status='納品')なのに R2 に残っている複製を一掃する sweep。
// 取りこぼし（status 変更経路が複数あるため）に対する保険。日次ワーカ + 手動 API から呼ぶ。
async function sweepDeliveredR2({ limit = 500 } = {}) {
  if (!isEnabled()) return { skipped: true, reason: 'r2-disabled' };
  const { data: rows, error } = await supabase
    .from('creative_files')
    .select('id, creatives:creative_id(status)')
    .eq('r2_status', 'active')
    .limit(limit);
  if (error) return { ok: false, error: error.message };
  const targets = (rows || []).filter(r => r.creatives?.status === '納品');
  let evicted = 0;
  for (const r of targets) {
    const res = await evictCreativeFileFromR2(r.id);
    if (res?.ok) evicted++;
  }
  console.log('[r2] sweep done:', { scanned: rows?.length || 0, evicted });
  return { ok: true, scanned: rows?.length || 0, evicted };
}

module.exports = {
  isEnabled,
  getClient,
  objectKeyForCreativeFile,
  presignGetUrl,
  deleteObject,
  objectExists,
  replicateDriveFileToR2,
  replicateCreativeFileToR2,
  evictCreativeFileFromR2,
  evictCreativeR2Replicas,
  sweepDeliveredR2,
};

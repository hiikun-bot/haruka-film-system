// lib/r2.js — クリエイティブ動画の再生用ホットキャッシュ（Cloudflare R2）
//
// 目的:
//   動画添削の再生が遅い主因は「ブラウザ ← Railway ← Google Drive」の二段ホップ
//   プロキシ配信（CDN 不在）。faststart 版を Cloudflare R2 へ複製し、署名 URL で
//   ブラウザに直接 Range 配信する（egress 無料・Cloudflare 網から配信）。
//
// ライフサイクル（ストレージを圧迫しないための要）:
//   アップロード → faststart 生成 → R2 へ複製 (r2_status='active')
//   レビュー中    → /direct-url は R2 署名 URL、/stream は 302 リダイレクトで配信
//   status='納品' → R2 オブジェクト削除 (r2_status='evicted')
//                   ※Drive には原本が残り続ける＝それがバックアップ
//   納品後の再視聴 → R2 無し → 従来の Drive 配信にフォールバック（稀・許容）
//
//   → R2 常駐はレビュー中の動画だけ。納品のたびに排出され累積しない（消しながら運用）。
//
// ON/OFF（費用ガードの第一段。社内ルール: キー存在チェックでの自動有効化は禁止）:
//   専用フラグ R2_PLAYBACK_ENABLED=true が明示されているときだけ有効。
//   さらに R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET が
//   すべて揃っている必要がある。どれか欠けたら isEnabled()===false で、呼び出し側は
//   従来の Drive 配信にフォールバックする（レスポンス形状も従来と完全同一）。
//
// 10GB 無料枠ガード（費用ガードの第二段）:
//   複製前に「現在使用量（DB集計）＋対象ファイルサイズ」が予算 R2_BUDGET_BYTES
//   （デフォルト 9GB ＝無料枠 10GB に対する安全マージン）を超えるかチェックする。
//   超える場合は ①まず納品済み複製の sweep を試行 → ②それでも超えるなら複製をスキップ
//   （そのファイルは従来 Drive 配信のまま。ログを出して黙って劣化しない）。
//   使用量は creative_files の r2_status='active' 行の r2_size_bytes 合計で安価に判定し、
//   実 R2 との整合ズレは sweep / 排出時の DB 更新で回復する。

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

let _warnedMissingCreds = false;
function isEnabled() {
  // 専用フラグが明示的に true でない限り、R2 関連の全処理を完全に無効化する。
  // （キー存在チェックでの自動有効化は禁止 — 課金系は必ず専用フラグでガードする社内ルール）
  if (process.env.R2_PLAYBACK_ENABLED !== 'true') return false;
  const hasCreds = !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
  if (!hasCreds && !_warnedMissingCreds) {
    _warnedMissingCreds = true;
    console.warn('[r2] R2_PLAYBACK_ENABLED=true ですが R2_* 資格情報が不足しているため無効のままです');
  }
  return hasCreds;
}

// 予算（バイト）。デフォルト 9GB = 無料枠 10GB への安全マージン。
const DEFAULT_BUDGET_BYTES = 9 * 1024 * 1024 * 1024;
function budgetBytes() {
  const raw = parseInt(process.env.R2_BUDGET_BYTES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_BYTES;
}

// 署名URLの有効期限（秒）。フロントの direct-url 先読みキャッシュ（TTL 3分, #958）より
// 十分長くしないと「キャッシュから取り出した瞬間に期限切れ」が起きる。既定 6時間。
const DEFAULT_SIGNED_URL_TTL = 6 * 60 * 60;
function signedUrlTtlSeconds() {
  const raw = parseInt(process.env.R2_SIGNED_URL_TTL_SECONDS, 10);
  // 最低 1時間を保証（R2 の presign 上限は 7日）
  return Number.isFinite(raw) && raw >= 3600 ? Math.min(raw, 7 * 24 * 60 * 60) : DEFAULT_SIGNED_URL_TTL;
}

function bucket() { return process.env.R2_BUCKET; }

let _client = null;
function getClient() {
  if (!isEnabled()) throw new Error('R2 無効（R2_PLAYBACK_ENABLED=true と R2_* 環境変数が必要）');
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

// 署名付き GET URL を発行。<video> は Range 付きで直接 R2 から取得する。
async function presignGetUrl(key, { expiresIn } = {}) {
  loadSdk();
  const command = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresIn || signedUrlTtlSeconds() });
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

// ---- 再生 URL 解決（routes/haruka.js の /direct-url・/stream から呼ぶ）----
//
// cf: creative_files 行（r2_key / r2_status を含む select 済みのもの）。
// R2 有効かつ複製済み(r2_status='active')なら署名 URL を返し、それ以外は null。
// null のとき呼び出し側は従来の Drive 経路にフォールバックする（再生は絶対に止めない）。
async function getPlaybackUrl(cf) {
  if (!isEnabled()) return null;
  if (!cf || cf.r2_status !== 'active' || !cf.r2_key) return null;
  try {
    return await presignGetUrl(cf.r2_key);
  } catch (e) {
    console.warn('[r2] presign 失敗→Driveフォールバック:', cf.r2_key, e?.message);
    return null;
  }
}

// ---- 使用量集計と予算ガード ----

// DB 集計による現在の R2 使用量（バイト）。
// r2_status='active' の r2_size_bytes 合計。列が無い環境などで取得に失敗したら null
// （＝使用量不明。複製は安全側に倒してスキップする）。
async function getR2UsageBytes() {
  try {
    const { data, error } = await supabase
      .from('creative_files')
      .select('r2_size_bytes')
      .eq('r2_status', 'active')
      .limit(5000);
    if (error) {
      console.warn('[r2] 使用量集計に失敗（複製は安全側でスキップされます）:', error.message);
      return null;
    }
    return (data || []).reduce((sum, r) => sum + (Number(r.r2_size_bytes) || 0), 0);
  } catch (e) {
    console.warn('[r2] 使用量集計 例外:', e?.message);
    return null;
  }
}

// 予算ガード: sizeBytes を追加しても予算内に収まるか。
// 超えそうなら ①納品済み複製の sweep を試行 → ②再集計して判定。
// 戻り値: { ok, usage, budget, swept }
async function ensureBudgetFor(sizeBytes) {
  const budget = budgetBytes();
  let usage = await getR2UsageBytes();
  if (usage === null) return { ok: false, usage: null, budget, swept: false, reason: 'usage-unknown' };
  if (usage + sizeBytes <= budget) return { ok: true, usage, budget, swept: false };

  // ① まず排出対象（納品済み等）を掃除して空きを作る
  console.log('[r2] 予算超過見込み → sweep を先行実行:', { usage, add: sizeBytes, budget });
  try { await sweepDeliveredR2({ limit: 1000 }); } catch (e) { console.warn('[r2] 予算前 sweep 失敗:', e?.message); }

  usage = await getR2UsageBytes();
  if (usage === null) return { ok: false, usage: null, budget, swept: true, reason: 'usage-unknown' };
  if (usage + sizeBytes <= budget) return { ok: true, usage, budget, swept: true };
  return { ok: false, usage, budget, swept: true, reason: 'over-budget' };
}

// ---- Drive → R2 ストリーム複製 ----

async function getDriveService() {
  const { google } = require('googleapis');
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
async function replicateDriveFileToR2({ driveFileId, key, contentType = 'video/mp4' }) {
  if (!isEnabled()) throw new Error('R2 無効');
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
// 複製元は faststart 版があればそれ、無ければ原本（無劣化）。
// 予算ガード（10GB 無料枠厳守）に通らなければ複製せず、従来 Drive 配信のままにする。
async function replicateCreativeFileToR2(creativeFileId) {
  if (!isEnabled()) return { skipped: true, reason: 'r2-disabled' };
  const { data: cf, error } = await supabase
    .from('creative_files')
    .select('id, drive_file_id, faststart_drive_file_id, faststart_status, faststart_file_size, file_size, mime_type, r2_status')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (error) {
    // r2_status 列が無い環境（migration 未適用）でも壊れない: 複製せず従来配信のまま
    console.warn('[r2] creative_files select 失敗（複製スキップ）:', error.message);
    return { skipped: true, reason: 'select-failed' };
  }
  if (!cf) return { skipped: true, reason: 'not-found' };
  if (cf.r2_status === 'active') return { skipped: true, reason: 'already-active' };

  const useFaststart = cf.faststart_status === 'done' && cf.faststart_drive_file_id;
  const sourceId = useFaststart ? cf.faststart_drive_file_id : cf.drive_file_id;
  if (!sourceId) return { skipped: true, reason: 'no-drive-file' };

  // 複製サイズを特定（予算ガードに必須）。DB キャッシュ → Drive メタの順。
  let sizeBytes = Number(useFaststart ? cf.faststart_file_size : cf.file_size) || 0;
  if (!sizeBytes) {
    try {
      const drive = await getDriveService();
      const meta = await drive.files.get({ fileId: sourceId, fields: 'size', supportsAllDrives: true });
      sizeBytes = parseInt(meta.data?.size || '0', 10) || 0;
    } catch (e) {
      console.warn('[r2] サイズ取得失敗:', creativeFileId, e?.message);
    }
  }
  if (!sizeBytes) {
    // サイズ不明のまま複製すると予算（10GB 無料枠）を破る恐れがある → 安全側でスキップ
    console.warn('[r2] サイズ不明のため複製スキップ（Drive配信のまま）:', creativeFileId);
    return { skipped: true, reason: 'size-unknown' };
  }

  // 予算ガード: 10GB 無料枠を絶対に超えない（超えそうなら sweep → それでもダメならスキップ）
  const guard = await ensureBudgetFor(sizeBytes);
  if (!guard.ok) {
    console.warn('[r2] 予算超過のため複製スキップ（このファイルは従来Drive配信のまま）:', {
      creativeFileId, sizeBytes, usage: guard.usage, budget: guard.budget, swept: guard.swept, reason: guard.reason,
    });
    return { skipped: true, reason: 'budget-exceeded', usage: guard.usage, budget: guard.budget };
  }

  const key = objectKeyForCreativeFile(cf.id);
  try {
    await replicateDriveFileToR2({ driveFileId: sourceId, key, contentType: cf.mime_type || 'video/mp4' });
    const { error: upErr } = await supabase.from('creative_files').update({
      r2_key: key,
      r2_status: 'active',
      r2_size_bytes: sizeBytes,
      r2_uploaded_at: new Date().toISOString(),
    }).eq('id', cf.id);
    if (upErr) {
      // DB 更新に失敗すると使用量集計から漏れて予算判定が狂う → アップロード分を補償削除
      console.warn('[r2] DB更新失敗 → アップロード分を補償削除:', cf.id, upErr.message);
      try { await deleteObject(key); } catch (_) {}
      return { ok: false, error: upErr.message };
    }
    console.log('[r2] replicated:', { creativeFileId: cf.id, key, sizeBytes });
    return { ok: true, key, sizeBytes };
  } catch (e) {
    console.error('[r2] replicate failed:', cf.id, e?.message);
    await supabase.from('creative_files').update({ r2_status: 'failed' }).eq('id', cf.id).then(() => {}, () => {});
    return { ok: false, error: e?.message };
  }
}

// R2 オブジェクトを削除して r2_status='evicted' にする（Drive 原本は残る＝バックアップ）。
// 削除に失敗した場合は 'active' のまま残す（使用量集計から漏らさない）→ 後続 sweep が再試行。
async function evictCreativeFileFromR2(creativeFileId) {
  if (!isEnabled()) return { skipped: true, reason: 'r2-disabled' };
  const { data: cf, error } = await supabase
    .from('creative_files')
    .select('id, r2_key, r2_status')
    .eq('id', creativeFileId)
    .maybeSingle();
  if (error) return { skipped: true, reason: 'select-failed' };
  if (!cf || !cf.r2_key || cf.r2_status !== 'active') return { skipped: true, reason: 'no-r2-object' };
  try {
    await deleteObject(cf.r2_key);
  } catch (e) {
    // 既に消えている(404)は成功扱い。それ以外は active のまま残して sweep に再試行させる
    if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NotFound') {
      console.warn('[r2] deleteObject 失敗（activeのまま保持・sweepが再試行）:', cf.r2_key, e?.message);
      return { ok: false, error: e?.message };
    }
  }
  await supabase.from('creative_files').update({ r2_status: 'evicted' }).eq('id', cf.id);
  console.log('[r2] evicted:', { creativeFileId: cf.id, key: cf.r2_key });
  return { ok: true, key: cf.r2_key };
}

// 指定クリエイティブ配下の R2 複製を一括排出（納品遷移時に即時で呼ぶ）。
async function evictCreativeR2Replicas(creativeId) {
  if (!isEnabled()) return { skipped: true, reason: 'r2-disabled' };
  const { data: files, error } = await supabase
    .from('creative_files')
    .select('id')
    .eq('creative_id', creativeId)
    .eq('r2_status', 'active');
  if (error) return { skipped: true, reason: 'select-failed' };
  let evicted = 0;
  for (const f of (files || [])) {
    const r = await evictCreativeFileFromR2(f.id);
    if (r?.ok) evicted++;
  }
  return { evicted };
}

// 納品済み(creatives.status='納品')なのに R2 に残っている複製を一掃する sweep。
// 取りこぼし（status 変更経路が複数あるため）に対する保険。6時間毎ワーカ + 手動 API +
// 予算ガード（複製前の空き確保）から呼ぶ。
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
  budgetBytes,
  signedUrlTtlSeconds,
  getClient,
  objectKeyForCreativeFile,
  presignGetUrl,
  deleteObject,
  objectExists,
  getPlaybackUrl,
  getR2UsageBytes,
  ensureBudgetFor,
  replicateDriveFileToR2,
  replicateCreativeFileToR2,
  evictCreativeFileFromR2,
  evictCreativeR2Replicas,
  sweepDeliveredR2,
};

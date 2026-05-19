// scripts/migrate_preview_to_webp.js
//
// 既存の preview_strategy='h264_faststart' 行を WebP 60枚ストーリーボードに置き換える。
// 旧設計（短尺=H.264 / 長尺=WebP）から「全動画一律 WebP 60枚」へ統一する移行用。
//
// 使い方:
//   # Dry run（影響範囲を確認するだけ）
//   node scripts/migrate_preview_to_webp.js
//
//   # 実際に Drive 削除 & DB クリア & WebP 再生成
//   node scripts/migrate_preview_to_webp.js --execute
//
// 安全策:
//   - --execute なしだと対象行を列挙して終了する
//   - --execute あっても 1 行ごとに「旧プレビュー Drive 削除 → preview_* 列クリア → WebP 再生成」を順次実行
//   - 1 行で失敗しても他の行に進む（最後に集計を出す）

require('dotenv').config();
const { google } = require('googleapis');
const supabase = require('../supabase');
const { generatePreviewForVideoOrg } = require('../lib/faststart');

const EXECUTE = process.argv.includes('--execute');

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

async function main() {
  console.log(`[migrate] mode = ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);

  const { data: rows, error } = await supabase
    .from('video_file_organization_tests')
    .select('id, drive_file_id, current_filename, original_filename, preview_drive_file_id, preview_strategy, preview_status, video_duration_seconds')
    .eq('preview_strategy', 'h264_faststart');

  if (error) {
    console.error('[migrate] supabase query failed:', error.message);
    process.exit(1);
  }

  const targets = rows || [];
  console.log(`[migrate] 対象 ${targets.length} 件`);
  if (targets.length === 0) {
    console.log('[migrate] 移行対象なし。終了します。');
    return;
  }

  for (const r of targets) {
    const name = r.current_filename || r.original_filename || '(no name)';
    const dur  = r.video_duration_seconds ?? '?';
    console.log(`  - id=${r.id} file="${name}" duration=${dur}s preview_drive_file_id=${r.preview_drive_file_id || '(none)'}`);
  }

  if (!EXECUTE) {
    console.log('');
    console.log('[migrate] DRY-RUN のため変更しません。実行するには --execute を付けてください。');
    return;
  }

  const drive = await getDriveService();

  let deleted = 0;
  let regenerated = 0;
  let failed = 0;

  for (const r of targets) {
    const name = r.current_filename || r.original_filename || '(no name)';
    console.log(`\n[migrate] >>> id=${r.id} file="${name}"`);

    // 1) 旧 preview_drive_file_id を Drive から削除
    if (r.preview_drive_file_id) {
      try {
        await drive.files.delete({
          fileId: r.preview_drive_file_id,
          supportsAllDrives: true,
        });
        console.log(`  [ok] Drive 旧プレビュー削除: ${r.preview_drive_file_id}`);
        deleted++;
      } catch (e) {
        // 404 はすでに削除済みの可能性。続行する。
        const code = Number(e?.code) || null;
        if (code === 404) {
          console.log(`  [skip] Drive 旧プレビュー既に無し: ${r.preview_drive_file_id}`);
        } else {
          console.warn(`  [warn] Drive 削除失敗 (continue): ${e?.message || e}`);
        }
      }
    }

    // 2) preview_* 列をクリア
    {
      const { error: clearErr } = await supabase
        .from('video_file_organization_tests')
        .update({
          preview_drive_file_id: null,
          preview_drive_url: null,
          preview_file_size: null,
          preview_mime_type: null,
          preview_strategy: null,
          preview_status: null,
          preview_duration_seconds: null,
          preview_processed_at: null,
        })
        .eq('id', r.id);
      if (clearErr) {
        console.warn(`  [warn] preview_* clear 失敗: ${clearErr.message}`);
        failed++;
        continue;
      }
      console.log('  [ok] preview_* 列をクリア');
    }

    // 3) WebP 60枚で再生成
    try {
      const result = await generatePreviewForVideoOrg({ rowId: r.id });
      if (result?.ok) {
        regenerated++;
        console.log(`  [ok] WebP 再生成: ${result.strategy} size=${result.outSize}`);
      } else if (result?.skipped) {
        console.log(`  [skip] 再生成スキップ: ${result.reason}`);
      } else {
        failed++;
        console.warn(`  [warn] 再生成失敗: ${result?.error || JSON.stringify(result)}`);
      }
    } catch (e) {
      failed++;
      console.warn(`  [warn] 再生成例外: ${e?.message || e}`);
    }
  }

  console.log('');
  console.log(`[migrate] 完了: 対象 ${targets.length} 件 / Drive削除 ${deleted} 件 / 再生成 ${regenerated} 件 / 失敗 ${failed} 件`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[migrate] fatal:', e);
  process.exit(1);
});

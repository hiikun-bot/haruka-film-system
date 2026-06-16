#!/usr/bin/env node
// scripts/backfill_msquare_project_id.js
//
// 役割:
//   migration 2026-06-16_msquare_project_id.sql で
//   video_file_organization_tests.project_id 列を新設した。#815 以降のアップロードは
//   project_id を記録するが、それ以前にアップロード済みの素材は project_id = NULL のまま。
//   このスクリプトは、各案件の Drive フォルダ（素材広場ルート/クライアント名/案件名）の id を
//   解決し、素材の current_parent_folder_id と突き合わせて project_id を一度だけ埋める。
//   これにより既存素材も検索バーの「クライアント → 案件」フィルタに正しく出るようになる。
//
// 重要:
//   - Drive フォルダは find-only（存在しなければスキップ、作成しない）で解決する。
//   - 冪等。何度実行しても、既に project_id が入っている行は触らない。
//
// 実行方法:
//   cd HARUKA-FILM-SYSTEM/_main   # （または本 worktree）
//   node scripts/backfill_msquare_project_id.js
//
//   オプション:
//     --dry-run   実際の UPDATE を行わず、見込み変更件数だけ表示
//
// 環境変数（既存の supabase.js / drive.js と同じ仕組み）:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//   VIDEO_ORG_UPLOAD_FOLDER_ID（無ければ GOOGLE_DRIVE_ROOT_FOLDER_ID）
//   GOOGLE_SERVICE_ACCOUNT_*（drive.js の getCredentials が読む）

require('dotenv').config();
const supabase = require('../supabase');
const driveLib = require('../lib/video-organization/drive');
const { sanitizeFolderName } = require('../lib/video-organization/project-folder');

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

function getRootFolderId() {
  return process.env.VIDEO_ORG_UPLOAD_FOLDER_ID || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '';
}

// 親フォルダ直下の同名フォルダ id を返す（無ければ null・作成はしない）。
// getOrCreateFolder の検索クエリと同じだが create はしない read-only 版。
async function findFolderId(drive, parentId, name) {
  if (!parentId || !name) return null;
  const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name = '${escaped}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false',
  ].join(' and ');
  const { data } = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return data?.files?.length ? data.files[0].id : null;
}

async function main() {
  const rootFolderId = getRootFolderId();
  if (!rootFolderId) {
    console.error('✖ VIDEO_ORG_UPLOAD_FOLDER_ID / GOOGLE_DRIVE_ROOT_FOLDER_ID が未設定です');
    process.exit(1);
  }
  console.log(`[backfill] root folder = ${rootFolderId} / dry-run = ${DRY_RUN}`);

  // project_id が未設定 かつ フォルダ id を持つ素材だけが対象
  const { data: items, error: itemsErr } = await supabase
    .from('video_file_organization_tests')
    .select('id, current_parent_folder_id, project_id')
    .is('project_id', null)
    .not('current_parent_folder_id', 'is', null);
  if (itemsErr) throw itemsErr;
  if (!items || items.length === 0) {
    console.log('[backfill] 対象素材なし（全件 project_id 設定済み）。終了。');
    return;
  }
  console.log(`[backfill] project_id 未設定の素材: ${items.length} 件`);

  // 素材が入っている親フォルダ id の集合（突き合わせ対象を絞るため）
  const folderIdsInUse = new Set(items.map(it => it.current_parent_folder_id));

  // 案件一覧（クライアント名つき）
  const { data: projects, error: projErr } = await supabase
    .from('projects')
    .select('id, name, clients(name)');
  if (projErr) throw projErr;

  const drive = await driveLib.getDriveService();

  // クライアントフォルダ id をメモ化（同一クライアントの案件で再解決しない）
  const clientFolderCache = new Map();
  async function resolveClientFolder(clientName) {
    const key = clientName || '(none)';
    if (clientFolderCache.has(key)) return clientFolderCache.get(key);
    const id = await findFolderId(drive, rootFolderId, clientName);
    clientFolderCache.set(key, id);
    return id;
  }

  // 案件フォルダ id → project_id のマップを作る（素材が入っているフォルダだけ）
  const folderToProject = new Map();
  for (const p of (projects || [])) {
    const clientName = sanitizeFolderName(p.clients?.name) || 'クライアント未設定';
    const projectName = sanitizeFolderName(p.name) || '案件未設定';
    const clientFolderId = await resolveClientFolder(clientName);
    if (!clientFolderId) continue;
    const projectFolderId = await findFolderId(drive, clientFolderId, projectName);
    if (!projectFolderId) continue;
    if (!folderIdsInUse.has(projectFolderId)) continue; // 素材が無いフォルダはスキップ
    folderToProject.set(projectFolderId, p.id);
  }
  console.log(`[backfill] 突き合わせ可能な案件フォルダ: ${folderToProject.size} 件`);

  // 素材ごとに project_id を埋める
  let updated = 0;
  let unmatched = 0;
  for (const it of items) {
    const projectId = folderToProject.get(it.current_parent_folder_id);
    if (!projectId) { unmatched++; continue; }
    if (DRY_RUN) { updated++; continue; }
    const { error: upErr } = await supabase
      .from('video_file_organization_tests')
      .update({ project_id: projectId })
      .eq('id', it.id);
    if (upErr) {
      console.error(`  ✖ update 失敗 id=${it.id}: ${upErr.message}`);
      continue;
    }
    updated++;
  }

  console.log(`[backfill] 完了: ${DRY_RUN ? '（dry-run）' : ''}埋めた=${updated} / 案件フォルダ外=${unmatched}`);
}

main().catch((e) => {
  console.error('[backfill] 失敗:', e);
  process.exit(1);
});

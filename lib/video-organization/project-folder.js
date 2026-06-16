// lib/video-organization/project-folder.js — 素材広場の「案件フォルダ」解決を共通化
//
// 背景:
//   アップロード時（routes/video-organization-test.js）と AI 解析適用時
//   （lib/video-organization/auto-apply.js）の両方で「クライアント → 案件」フォルダを
//   ensure する必要があるため、共通モジュールに切り出す。
//
//   素材広場ルート（VIDEO_ORG_UPLOAD_FOLDER_ID）配下に
//     クライアント名 / 案件名
//   を getOrCreateFolder で確保し、案件フォルダの id を返す。
//   フォルダ名に使えない文字はサニタイズ（既存クリエイティブと同じ置換規則）。

const supabase = require('../../supabase');
const driveLib = require('./drive');

function sanitizeFolderName(s) {
  return String(s || '').replace(/[/\\?%*:|"<>]/g, '_').trim();
}

// projectId からクライアント→案件フォルダを ensure し、案件フォルダ id を返す。
// 戻り値: { folderId, clientName, projectName, project }
async function resolveProjectFolder(projectId, rootFolderId) {
  if (!projectId) throw new Error('projectId が指定されていません');
  if (!rootFolderId) throw new Error('rootFolderId（素材広場ルート）が未設定です');

  const { data: project, error } = await supabase
    .from('projects')
    .select('id, name, clients(id, name)')
    .eq('id', projectId)
    .single();
  if (error || !project) {
    throw new Error('指定された案件が見つかりません');
  }

  const clientName = sanitizeFolderName(project.clients?.name) || 'クライアント未設定';
  const projectName = sanitizeFolderName(project.name) || '案件未設定';

  const clientFolderId = await driveLib.getOrCreateFolder(rootFolderId, clientName);
  const projectFolderId = await driveLib.getOrCreateFolder(clientFolderId, projectName);
  return { folderId: projectFolderId, clientName, projectName, project };
}

module.exports = {
  resolveProjectFolder,
  sanitizeFolderName,
};

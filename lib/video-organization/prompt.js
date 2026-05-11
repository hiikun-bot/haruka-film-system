// lib/video-organization/prompt.js — Gemini に渡すプロンプトテンプレート
//
// 仕様:
//   - 入力は英語ベース（トークン削減）
//   - 出力値はすべて日本語（HARUKA FILM 内部運用言語）
//   - 出力 JSON は固定スキーマ（routes 側で JSON.parse → 候補として保存）
//
// prompt_version は DB 列 prompt_version に保存する。
// プロンプトを変えた場合は必ずこのバージョンも上げる（再現性のため）。

const PROMPT_VERSION = 'v1-2026-05-11';

function buildPrompt({ originalFilename }) {
  const safeName = String(originalFilename || '').slice(0, 256);
  return `Analyze the attached video for HARUKA FILM Library.

Return JSON only.
All values must be in Japanese.

Goal:
Suggest a new filename and destination folder for organizing this video in Google Drive.

Rules:
- Use the date in the original filename.
- Do not guess dates.
- If no date exists, use "日付不明".
- Do not mention whether the video is AI-generated unless clearly visible or explicitly provided.
- If reusable raw footage, video_type = "撮影素材" and status = "素材".
- If edited for publishing, use "SNS投稿動画" or "完成動画".
- If it looks like an ad creative, use "広告動画".
- Folder format: 素材種別/カテゴリ/詳細カテゴリ
- Filename format: YYYYMMDD_素材種別_カテゴリ_内容_状態.mp4
- Max confidence is 95.
- If uncertain, needs_human_review = true.
- Keep recommended_filename concise and practical.
- Do not actually rename or move the file. Only suggest.

Original filename:
${safeName}

Return this JSON:
{
  "summary": "",
  "main_action": "",
  "video_type": "",
  "recommended_folder": "",
  "recommended_filename": "",
  "confidence": 0,
  "needs_human_review": false,
  "reason": ""
}`;
}

module.exports = { buildPrompt, PROMPT_VERSION };

// lib/video-organization/prompt.js — Gemini に渡すプロンプトテンプレート
//
// 仕様:
//   - 入力は英語ベース（トークン削減）
//   - 出力値はすべて日本語（HARUKA FILM 内部運用言語）
//   - 出力 JSON は固定スキーマ（routes 側で JSON.parse → 候補として保存）
//
// 出力フィールド（Phase 2 で大幅拡張）:
//   - summary: 1-2 文のシーン要約
//   - scenes: キーモーメント（タイムスタンプ + 説明）最大 8 件
//   - tags: "#在宅ワーク" など 5-10 個
//   - mood: 「明るい」「穏やか」など
//   - video_type / recommended_folder / recommended_filename: 整理用
//   - needs_human_review / reason: 信頼度フラグ
//
// prompt_version は DB 列 prompt_version に保存する。
// プロンプトを変えた場合は必ずこのバージョンも上げる（再現性のため）。

const PROMPT_VERSION = 'v2-scenes-2026-05-11';

function buildPrompt({ originalFilename, mediaKind }) {
  const safeName = String(originalFilename || '').slice(0, 256);
  const kind = mediaKind === 'image' ? 'image' : 'video';
  const mediaWord = kind === 'image' ? 'image' : 'video';
  const filenameExt = kind === 'image' ? 'jpg' : 'mp4';
  const scenesNote = kind === 'image'
    ? '- For images, "scenes" should contain ONE entry describing the image, with time = "0:00".'
    : '- For videos, list up to 8 key moments with timestamp (mm:ss) and short description ("椅子を引く" など).';

  return `Analyze the attached ${mediaWord} for HARUKA FILM Library.

Return JSON only.
All values must be in Japanese.

Goal:
Help editors and directors quickly find this media later by describing scenes, mood,
tags, and key moments — and suggest a filename + folder for organizing in Google Drive.

Rules:
- Use the date in the original filename if present.
- Do not guess dates.
- If no date exists, use "日付不明".
- Do not mention whether the ${mediaWord} is AI-generated unless clearly visible or explicitly provided.
- If reusable raw footage, video_type = "撮影素材" and the file is treated as "素材".
- If edited for publishing, use "SNS投稿動画" or "完成動画".
- If it looks like an ad creative, use "広告動画".
- Folder format: 素材種別/カテゴリ/詳細カテゴリ
- Filename format: YYYYMMDD_素材種別_カテゴリ_内容_状態.${filenameExt}
${scenesNote}
- "tags" must be an array of 5 to 10 short Japanese hashtags starting with "#".
  Examples: "#女性", "#在宅ワーク", "#笑顔", "#屋外", "#夜景", "#手元アップ".
  Tags should be useful for keyword search ("どんなシーンか" を表す語).
- "mood" is one short Japanese phrase: 例 "明るい・穏やか" / "真剣" / "コミカル" / "シリアス" / "緊張感".
- If uncertain about classification, needs_human_review = true.
- Keep recommended_filename concise and practical.
- Do not actually rename or move the file. Only suggest.

Original filename:
${safeName}

Return this JSON exactly:
{
  "summary": "",
  "scenes": [
    { "time": "0:00", "description": "" }
  ],
  "tags": [],
  "mood": "",
  "main_action": "",
  "video_type": "",
  "recommended_folder": "",
  "recommended_filename": "",
  "needs_human_review": false,
  "reason": ""
}`;
}

module.exports = { buildPrompt, PROMPT_VERSION };

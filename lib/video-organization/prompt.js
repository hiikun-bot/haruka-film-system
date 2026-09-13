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

const PROMPT_VERSION = 'v3-webp-storyboard-2026-05-19';
// ADR 039 D1: 解析用プロキシ（60コマ 1fps 動画 + 音声トラック）モード。
const PROMPT_VERSION_PROXY = 'v4-proxy-video-2026-09-14';

function mmss(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildPrompt({ originalFilename, mediaKind, sourceVariant, originalMediaKind, proxy }) {
  const safeName = String(originalFilename || '').slice(0, 256);
  const kind = mediaKind === 'image' ? 'image' : 'video';

  // ADR 039 D1: プロキシ動画（60コマを 1fps で並べた 60 秒の無音動画）+ 原本の音声トラック。
  //   Gemini は動画をネイティブに時系列で読むので、コマ i ↔ 原本秒 の対応をプロンプトで渡し、
  //   scenes[].time を原本の mm:ss で返させる。音声があれば発話内容を名前付け・タグの根拠に使わせる。
  if (sourceVariant === 'proxy-video') {
    const px = proxy || {};
    const frames = Number(px.frameCount) || 60;
    const dur = Number(px.durationSeconds) || 0;
    const startT = Number(px.startSeconds) || 0;
    const step = frames > 1 && dur > 0 ? ((Number(px.endSeconds) || dur) - startT) / (frames - 1) : 0;
    const hasAudio = !!px.hasAudio;
    const audioSec = Number(px.audioSeconds) || 0;
    const audioNote = hasAudio
      ? `Part 2 is the ORIGINAL AUDIO TRACK (${audioSec > 0 && dur > 0 && audioSec < dur - 1
          ? `first ${mmss(audioSec)} of ${mmss(dur)} — the tail is cut for size`
          : `full length ${mmss(dur)}`}), at normal speed. Speech, narration and on-screen talk are
the strongest evidence for the topic, so use what is SAID for summary / tags / filename
(e.g. lecture title, product name, interview theme). Note: audio time = original time,
while Part 1 is compressed (see mapping).`
      : 'There is NO audio (the original has no audio track).';
    return `Analyze the attached media for HARUKA FILM Library.
IMPORTANT CONTEXT:
Part 1 is a PROXY VIDEO generated from an original video of ${mmss(dur)}: ${frames} frames were
sampled at evenly-spaced timestamps and played back at 1 frame per second, so the proxy is
${frames} seconds long but represents the WHOLE original. Mapping: proxy second s (0-based)
≈ original time ${mmss(startT)} + s × ${step.toFixed(2)}s. Example: proxy second 30 ≈ original ${mmss(startT + 30 * step)}.
${audioNote}
Return JSON only. All values must be in Japanese.
Goal:
Help editors and directors quickly find this video later by describing scenes, mood,
tags, and key moments — and suggest a filename + folder for organizing in Google Drive.
Rules:
- Use the date in the original filename if present.
- Do not guess dates.
- If no date exists, use "日付不明".
- Do not mention whether the video is AI-generated unless clearly visible or explicitly provided.
- If reusable raw footage, video_type = "撮影素材" and the file is treated as "素材".
- If edited for publishing, use "SNS投稿動画" or "完成動画".
- If it looks like an ad creative, use "広告動画".
- Folder format: 素材種別/カテゴリ/詳細カテゴリ
- Filename format: YYYYMMDD_素材種別_カテゴリ_内容_状態.mp4
- For "scenes", list up to 8 key moments. Express "time" as the ORIGINAL video time in
  m:ss (use the mapping above; for spoken content use the audio time directly).
  Pick moments where something notable changes (新カット/被写体の動き/話題の転換など).
- "tags" must be an array of 5 to 10 short Japanese hashtags starting with "#".
  Examples: "#女性", "#在宅ワーク", "#笑顔", "#屋外", "#夜景", "#手元アップ", "#講演".
  Tags should be useful for keyword search ("どんなシーンか / 何の話か" を表す語).
- "mood" is one short Japanese phrase: 例 "明るい・穏やか" / "真剣" / "コミカル" / "シリアス" / "緊張感".
- If uncertain about classification, needs_human_review = true.
- Keep recommended_filename concise and practical. If speech reveals the topic, put it in 内容.
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


  // ADR 018: WebP プレビュー（動画の60枚ストーリーボード）モード。
  // mediaKind は 'image' だが、内容は動画なので動画用のスキーマで解釈させる。
  const isStoryboard = sourceVariant === 'video-storyboard-webp';
  const origKind = originalMediaKind === 'image' ? 'image' : 'video';

  if (isStoryboard) {
    const filenameExt = 'mp4';
    return `Analyze the attached WebP image for HARUKA FILM Library.

IMPORTANT CONTEXT:
The attached WebP is NOT a normal photo. It is a 60-frame storyboard generated from
an original video by sampling frames at 60 evenly-spaced timestamps (roughly 2% to 98%
of the video). The frames are arranged in reading order (left-to-right, top-to-bottom).
Treat it as a compressed visual representation of the entire video.

Return JSON only. All values must be in Japanese.

Goal:
Help editors and directors quickly find this video later by describing scenes, mood,
tags, and key moments — and suggest a filename + folder for organizing in Google Drive.
Audio information is NOT available (storyboard is silent).

Rules:
- Use the date in the original filename if present.
- Do not guess dates.
- If no date exists, use "日付不明".
- Do not mention whether the video is AI-generated unless clearly visible or explicitly provided.
- If reusable raw footage, video_type = "撮影素材" and the file is treated as "素材".
- If edited for publishing, use "SNS投稿動画" or "完成動画".
- If it looks like an ad creative, use "広告動画".
- Folder format: 素材種別/カテゴリ/詳細カテゴリ
- Filename format: YYYYMMDD_素材種別_カテゴリ_内容_状態.${filenameExt}
- For "scenes", list up to 8 key moments. Since the storyboard has 60 evenly-spaced
  frames, express the time as "frame N/60" (例 "frame 12/60") instead of mm:ss.
  Pick frames where something notable changes (新カット/被写体の動き/構図変化など).
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
    { "time": "frame 1/60", "description": "" }
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

module.exports = { buildPrompt, PROMPT_VERSION, PROMPT_VERSION_PROXY };

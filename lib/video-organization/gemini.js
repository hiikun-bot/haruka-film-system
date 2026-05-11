// lib/video-organization/gemini.js — Vertex AI Gemini ラッパー
//
// 安全装置の方針:
//   - このモジュールは呼び出された瞬間に課金が発生する。
//   - 呼び出し側が STOP_ALL / DAILY_LIMIT / duration / status を checkall
//     してから呼ぶ前提。ここでは追加で重ねがけしない。
//   - @google-cloud/vertexai が未インストールの場合は明示エラー（silent skip 禁止）。
//
// Phase 2 で画像対応を追加（mediaKind='image' を許可）。

const { buildPrompt, PROMPT_VERSION } = require('./prompt');
const guards = require('./guards');

function loadVertexAI() {
  try {
    return require('@google-cloud/vertexai');
  } catch (e) {
    throw new Error('@google-cloud/vertexai が未インストールです。`npm install @google-cloud/vertexai` を実行してください。');
  }
}

function getCredentials() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  return JSON.parse(keyJson);
}

// Gemini 呼び出し本体。
// 入力:
//   mediaBuffer: Buffer
//   mimeType:    string  例 'video/mp4', 'image/jpeg', 'image/png', 'image/webp'
//   mediaKind:   'video' | 'image'
//   originalFilename: string
async function analyzeMedia({ mediaBuffer, mimeType, mediaKind, originalFilename }) {
  const { VertexAI } = loadVertexAI();
  const project = guards.getGcpProject();
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT が設定されていません');
  const location = guards.getGcpLocation();
  const modelName = guards.getModelName();

  const vertex = new VertexAI({
    project,
    location,
    googleAuthOptions: { credentials: getCredentials() },
  });

  const model = vertex.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 2048,  // Phase 2 で scenes/tags が増えたので拡大
    },
  });

  const promptText = buildPrompt({ originalFilename, mediaKind });

  const request = {
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: mimeType || (mediaKind === 'image' ? 'image/jpeg' : 'video/mp4'),
            data: mediaBuffer.toString('base64'),
          },
        },
        { text: promptText },
      ],
    }],
  };

  const result = await model.generateContent(request);
  const response = result?.response;
  const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (_) { /* still null */ }
    }
  }

  return {
    parsed,
    raw: text,
    model: modelName,
    promptVersion: PROMPT_VERSION,
  };
}

// 互換用 alias
async function analyzeVideo(opts) {
  return analyzeMedia({
    ...opts,
    mediaKind: 'video',
    mediaBuffer: opts.videoBuffer || opts.mediaBuffer,
  });
}

module.exports = { analyzeMedia, analyzeVideo };

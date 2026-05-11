// lib/video-organization/gemini.js — Vertex AI Gemini ラッパー
//
// 安全装置の方針:
//   - このモジュールは呼び出された瞬間に課金が発生する。
//   - 呼び出し側（routes/video-organization-test.js）が STOP_ALL / DAILY_LIMIT /
//     duration / status を checkall してから呼ぶ前提。ここでは追加で重ねがけしない
//     （重複ガードは中央集権化のため routes 側に集約）。
//   - @google-cloud/vertexai が未インストールの場合は明示エラー（silent skip 禁止）。

const { buildPrompt, PROMPT_VERSION } = require('./prompt');
const guards = require('./guards');

// 動的 require（インストール忘れを起動時クラッシュにしないため）
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
//   videoBuffer: Buffer  — Drive からダウンロードした動画バイト列
//   mimeType:    string  — 例 'video/mp4'
//   originalFilename: string
// 戻り値:
//   { parsed: {...}, raw: string, model: string, promptVersion: string }
async function analyzeVideo({ videoBuffer, mimeType, originalFilename }) {
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
      // JSON 強制（Gemini 1.5+ がサポート。古い model だと無視される）
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  });

  const promptText = buildPrompt({ originalFilename });

  const request = {
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'video/mp4',
            data: videoBuffer.toString('base64'),
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
    // JSON 抽出フォールバック（コードフェンス対策）
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

module.exports = { analyzeVideo };

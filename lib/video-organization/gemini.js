// lib/video-organization/gemini.js — Vertex AI Gemini ラッパー
//
// 安全装置の方針:
//   - このモジュールは呼び出された瞬間に課金が発生する。
//   - 呼び出し側が STOP_ALL / DAILY_LIMIT / duration / status を checkall
//     してから呼ぶ前提。ここでは追加で重ねがけしない。
//   - @google/genai が未インストールの場合は明示エラー（silent skip 禁止）。
//   - 旧 @google-cloud/vertexai は 2026-06-24 removal のため @google/genai へ移行済み。
//     PR #850 の IPv4強制+retry authClient は googleAuthOptions.authClient で引き継ぐ。
//
// Phase 2 で画像対応を追加（mediaKind='image' を許可）。

const { buildPrompt, PROMPT_VERSION } = require('./prompt');
const guards = require('./guards');
const {
  parseCredentialsFromEnv,
  logCredentialsHealth,
} = require('../google-service-account');
const {
  CLOUD_PLATFORM_SCOPE,
  createResilientJwtClient,
} = require('../google-auth-token');

function loadGenAI() {
  try {
    return require('@google/genai');
  } catch (e) {
    throw new Error('@google/genai が未インストールです。`npm install @google/genai` を実行してください。');
  }
}

function getCredentials() {
  const credentials = parseCredentialsFromEnv();
  logCredentialsHealth('video-org:gemini:getCredentials', credentials);
  return credentials;
}

function getPackageVersion(packageName) {
  try {
    return require(`${packageName}/package.json`).version;
  } catch (_) {
    return null;
  }
}

function serializeError(e) {
  return {
    name: e?.name || null,
    message: e?.message || String(e),
    code: e?.code || null,
    status: e?.status || e?.response?.status || null,
    errors: e?.errors || e?.response?.data?.error?.errors || null,
    details: e?.details || e?.response?.data?.error || null,
    stack: e?.stack || null,
    cause: e?.cause ? {
      name: e.cause.name || null,
      message: e.cause.message || String(e.cause),
      code: e.cause.code || null,
      stack: e.cause.stack || null,
    } : null,
  };
}

// 途中で切れた（閉じ括弧の無い不完全な）JSON 文字列を、可能な範囲で
// valid JSON に修復する。文字列リテラル内かどうかを追跡しながら 1 文字ずつ
// 走査し、開いたままの構造を閉じることで JSON.parse 可能な状態に整える。
//
//   (a) 値が欠けた末尾要素（"key": やカンマ直後など）を切り捨てる
//   (b) 開いたままの `[` `{` を対応する `]` `}` で閉じる
//   (c) 開いたままの文字列 `"` を閉じる
//
// gemini-3.1-pro が maxOutputTokens 上限に達して本文 JSON が途中で切れた
// ケースを救済するためのフォールバック。完全な JSON が来た場合は呼ばれない。
function repairTruncatedJson(input) {
  const stack = [];        // '{' / '[' の開きスタック
  let inString = false;
  let escaped = false;
  // 「JSON として安全に切れる位置」= 直近で完成した値/要素の終端 index（exclusive）。
  // ここまでで切れば未完了の末尾トークンを確実に捨てられる。
  let lastSafe = 0;
  // ':' の後に有効な値がまだ来ていない（"key": の宙ぶらりん）状態か
  let pendingColonValue = false;
  // いま開いている文字列が「値」（: の直後 or 配列要素）か。
  // 値の文字列の途中で切れた場合は、その値を閉じて温存できる。
  let stringIsValue = false;
  let stringStart = -1;    // 開いている文字列の開始 index

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        inString = false;
        // 文字列が閉じた = 値 or キーが 1 つ完成。
        // 直前が ':' 待ちなら値の完成、そうでなければキー/配列要素の完成。
        if (pendingColonValue) {
          pendingColonValue = false;
          lastSafe = i + 1; // 値として完成
        } else if (stack[stack.length - 1] === '[') {
          lastSafe = i + 1; // 配列内の文字列要素として完成
        }
        // オブジェクトのキーの場合は ':' と値が来るまで safe にしない
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      // : の直後、または配列内 = 値の文字列。オブジェクト直下の "..." はキー。
      stringIsValue = pendingColonValue || stack[stack.length - 1] === '[';
      continue;
    }
    if (ch === '{' || ch === '[') { stack.push(ch); pendingColonValue = false; continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      pendingColonValue = false;
      lastSafe = i + 1; // 構造が 1 つ閉じた = ここまでは完成
      continue;
    }
    if (ch === ':') { pendingColonValue = true; continue; }
    if (ch === ',') {
      // カンマ = 直前の要素が完成。カンマ自体は含めない位置を safe にする。
      pendingColonValue = false;
      lastSafe = i;
      continue;
    }
    // 数値 / true / false / null など（":" の後のリテラル）。
    // これらは完了判定が難しいので、後続の , } ] が来た時点で safe になる。
    // ここでは何もしない。
  }

  // 値の文字列の途中で切れた場合は、その文字列を末尾まで含めて温存する
  // （後段で閉じ `"` が付与される）。キーの途中で切れた場合は捨てる。
  let cutAt = lastSafe;
  if (inString && stringIsValue && stringStart >= lastSafe) {
    cutAt = input.length;
  }

  // 安全位置までで切り詰める（未完了の末尾トークンを捨てる）
  let trimmed = input.slice(0, cutAt).replace(/[\s,]+$/, '');
  if (!trimmed) return null;

  // 切り詰めた地点での開き括弧スタックを再計算してから閉じる
  const closeStack = [];
  let s = false, esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (s) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') s = false;
      continue;
    }
    if (ch === '"') { s = true; continue; }
    if (ch === '{' || ch === '[') closeStack.push(ch);
    else if (ch === '}') { if (closeStack[closeStack.length - 1] === '{') closeStack.pop(); }
    else if (ch === ']') { if (closeStack[closeStack.length - 1] === '[') closeStack.pop(); }
  }
  // (c) 文字列が開いたままなら閉じる
  if (s) trimmed += '"';
  // (b) 開いたままの構造を閉じる（内側から）
  for (let i = closeStack.length - 1; i >= 0; i--) {
    trimmed += closeStack[i] === '{' ? '}' : ']';
  }
  return trimmed;
}

// Gemini のレスポンステキストを多段フォールバックで JSON にパースする。
// 正常系（valid JSON）では 1 段目で即成功し、追加処理は走らない。
//   1) ```json ... ``` のコードフェンスを除去してそのままパース
//   2) 最初の `{` から末尾までを対象にパース
//   3) 途中切れ JSON の修復を試みてパース
// すべて失敗したら null を返す（呼び出し側で failed 扱い）。
function parseGeminiJson(text) {
  if (!text || typeof text !== 'string') return null;

  // 1) コードフェンス除去
  let cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }

  // 2) 最初の `{` から末尾まで
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const candidate = cleaned.slice(start);
  try { return JSON.parse(candidate); } catch (_) { /* fall through */ }

  // 3) 途中切れ JSON の修復
  try {
    const repaired = repairTruncatedJson(candidate);
    if (repaired) return JSON.parse(repaired);
  } catch (_) { /* fall through */ }

  return null;
}

// Gemini 呼び出し本体。
// 入力:
//   mediaBuffer: Buffer
//   mimeType:    string  例 'video/mp4', 'image/jpeg', 'image/png', 'image/webp'
//   mediaKind:   'video' | 'image'
//   originalFilename: string
//   sourceVariant?: 'video-storyboard-webp' | null
//     ADR 018: WebP プレビュー（動画の60枚ストーリーボード）を渡すときに指定。
//     プロンプト側で「複数フレームから動画の内容を解釈」モードに切り替える。
//   originalMediaKind?: 'video' | 'image'
//     sourceVariant 指定時、元素材が動画なのか画像なのかを伝えるためのヒント。
async function analyzeMedia({ mediaBuffer, mimeType, mediaKind, originalFilename, sourceVariant, originalMediaKind }) {
  const { GoogleGenAI } = loadGenAI();
  const project = guards.getGcpProject();
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT が設定されていません');
  const location = guards.getGcpLocation();
  const modelName = guards.getModelName();

  // location='global' は @google/genai がネイティブ対応するため、旧 @google-cloud/vertexai
  // で必要だった apiEndpoint の手動固定（存在しないホスト名 `global-aiplatform...` の回避）は
  // 不要。値はログ用に保持するだけ。
  const apiEndpoint = location === 'global' ? 'aiplatform.googleapis.com' : undefined;
  console.info('[video-org] gemini-config', JSON.stringify({
    project,
    location,
    apiEndpoint: apiEndpoint || null,
    model: modelName,
    sdk: '@google/genai',
    auth_mode: 'external-jwt-v10-ipv4-retry',
    genai_version: getPackageVersion('@google/genai'),
    google_auth_library_version: getPackageVersion('google-auth-library'),
  }));
  const credentials = getCredentials();
  // PR #850 で導入した IPv4強制+retry の authClient を新SDKにもそのまま注入し、
  // token endpoint への ERR_STREAM_PREMATURE_CLOSE 対策を引き継ぐ。
  const authClient = createResilientJwtClient(credentials, { projectId: project });
  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    googleAuthOptions: {
      projectId: project,
      scopes: [CLOUD_PLATFORM_SCOPE],
      authClient,
    },
  });

  const promptText = buildPrompt({
    originalFilename,
    mediaKind,
    sourceVariant: sourceVariant || null,
    originalMediaKind: originalMediaKind || mediaKind,
  });

  const request = {
    model: modelName,
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
    config: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // gemini-3.1-pro は思考トークンも出力枠(maxOutputTokens)に含むため、
      // webp ストーリーボード解析では 2048 だと思考で枠を使い切り、本文 JSON が
      // 途中（例: "main_action": の直後）で切れて JSON.parse に失敗していた。
      // 思考＋本文の両方に十分な枠を確保するため 8192 に拡張。
      maxOutputTokens: 8192,
    },
  };

  let response;
  try {
    response = await ai.models.generateContent(request);
  } catch (e) {
    console.error('[video-org] gemini-generateContent-error', JSON.stringify(serializeError(e)));
    throw e;
  }
  // 新SDK は response.text（getter）で本文を返す。空のときは candidates から拾う。
  const text = (typeof response?.text === 'string' && response.text)
    ? response.text
    : (response?.candidates?.[0]?.content?.parts?.[0]?.text || '');

  const parsed = parseGeminiJson(text);

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

module.exports = { analyzeMedia, analyzeVideo, parseGeminiJson, repairTruncatedJson };

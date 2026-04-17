// server.js — VIDEO OPS バックエンドサーバー
// Express（エクスプレス）: Node.js用の軽量Webサーバーフレームワーク
// このファイルがシステムの中心で、フロントエンドからのリクエストを処理し、
// Frame.ioからのWebhookを受け取り、AIでナレッジを生成します

require('dotenv').config();
const harukaRouter = require('./routes/haruka');
const supabase = require('./supabase');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const { members, projects, projectMemos, editorRanks, projectRates, deliveries, comments, knowledge, invoices, assets, videoComments, users, invitations, uid } = require('./db/db');
const { passport: passportInstance, requireAuth, requireLevel, registerWithInvitation, ROLES } = require('./auth');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: 'tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
if (!fs.existsSync('tmp/uploads')) fs.mkdirSync('tmp/uploads', { recursive: true });
const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const TAX_RATE = 0.10;

// ==================== ミドルウェア ====================
// ミドルウェア: リクエストとレスポンスの間で処理を挟む仕組み

app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000', credentials: true }));

// セッション設定
// セッション: ログイン状態をサーバー側で管理する仕組み
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DATA_DIR || './data' }),
  secret: process.env.SESSION_SECRET || 'video-ops-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // 本番ではHTTPS必須
    httpOnly: true, // JavaScriptからCookieを読めないようにしてXSS対策
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7日間
  },
}));

app.use(passportInstance.initialize());
app.use(passportInstance.session());

// Webhookエンドポイントはraw bodyが必要なため、先に定義
app.use('/webhook/frameio', express.raw({ type: 'application/json' }));
app.use(express.json());
// HARUKA FILM SYSTEM API
app.use('/api/haruka', harukaRouter);

// login.html・invite.htmlは認証不要でアクセス可能
app.use('/login.html',  express.static(path.join(__dirname, 'public/login.html')));
app.use('/invite.html', express.static(path.join(__dirname, 'public/invite.html')));
// その他の静的ファイルは認証後のみ
app.use(express.static(path.join(__dirname, 'public')));

// ==================== ユーティリティ ====================

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Frame.io Webhook の署名検証
// HMAC-SHA256（ハッシュベースのメッセージ認証コード）でリクエストの正当性を確認
function verifyFrameioSignature(rawBody, signature) {
  const secret = process.env.FRAMEIO_WEBHOOK_SECRET;
  if (!secret) return true; // 開発時はスキップ
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ==================== AI ナレッジ生成 ====================
// Anthropic APIを使ってコメントを解析し、構造化されたナレッジを生成します

async function analyzeCommentWithAI(comment, delivery, project) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[AI] ANTHROPIC_API_KEY が未設定です。スキップします。');
    return null;
  }

  const prompt = `あなたは動画編集チームのナレッジマネージャーです。
Frame.ioに投稿されたレビューコメントを分析し、再発防止ナレッジとして構造化してください。

【案件名】${project?.name || '不明'}
【動画タイトル】${delivery?.title || '不明'}
【コメント本文】${comment.body}
【タイムスタンプ】${comment.timestamp_seconds ? `${comment.timestamp_seconds}秒` : '不明'}

以下のJSON形式のみで回答してください（前後の説明不要）:
{
  "category": "カット編集|カラーグレーディング|テロップ|SE・BGM|尺・テンポ|構成|その他",
  "severity": "low|medium|high",
  "title": "指摘の要点を20文字以内で",
  "description": "何が問題だったかを100文字以内で具体的に",
  "how_to_avoid": "次回から同じ指摘を受けないための具体的な対策を150文字以内で",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "is_duplicate_risk": true または false,
  "duplicate_hint": "類似ナレッジを検索するためのキーワード（スペース区切り）"
}`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    const text = res.data.content[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[AI] 解析エラー:', err.response?.data || err.message);
    return null;
  }
}

// 既存ナレッジとの類似チェック（キーワードベースの簡易マッチング）
async function findSimilarKnowledge(analysis) {
  if (!analysis?.duplicate_hint) return [];
  const keywords = analysis.duplicate_hint.split(' ').filter(Boolean);
  const all = knowledge.all({ category: analysis.category });

  return all.filter(k => {
    const text = `${k.title} ${k.description} ${k.tags}`.toLowerCase();
    return keywords.some(kw => text.includes(kw.toLowerCase()));
  }).slice(0, 3);
}

// ==================== WEBHOOK — Frame.io ====================
// Frame.io がコメント追加・解決時にここにPOSTリクエストを送ります
// 設定方法: Frame.io Developer Settings > Webhooks > URL を https://あなたのサーバー/webhook/frameio に設定

app.post('/webhook/frameio', async (req, res) => {
  const signature = req.headers['x-frameio-signature'] || '';

  if (!verifyFrameioSignature(req.body, signature)) {
    console.warn('[Webhook] 署名検証失敗');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('[Webhook] Frame.io イベント受信:', payload.type);

  // コメント追加イベント
  if (payload.type === 'comment.created' || payload.type === 'comment.updated') {
    const data = payload.data || {};
    const assetId = data.asset_id || data.resource?.id;

    // 対応する納品物を検索
    const delivery = assetId ? deliveries.byFrameioAssetId(assetId) : null;

    // コメントを保存
    const commentText = data.text || data.body || '';
    if (!commentText) return res.json({ ok: true, skipped: 'empty comment' });

    // 既存チェック
    const existing = data.id ? comments.byFrameioId(data.id) : null;
    let savedComment;

    if (!existing) {
      savedComment = comments.create({
        deliveryId: delivery?.id || null,
        frameioCommentId: data.id,
        author: data.owner?.name || data.author?.name || 'unknown',
        body: commentText,
        timestampSeconds: data.timestamp,
        resolved: false,
        rawJson: payload,
      });
    } else {
      savedComment = existing;
    }

    // AIでナレッジ生成（非同期、レスポンスは待たない）
    if (delivery) {
      const project = projects.byId(delivery.project_id);
      setImmediate(async () => {
        const analysis = await analyzeCommentWithAI(savedComment, delivery, project);
        if (!analysis) return;

        const similar = await findSimilarKnowledge(analysis);
        console.log(`[AI] ナレッジ生成: "${analysis.title}" / 類似: ${similar.length}件`);

        if (similar.length === 0) {
          // 新規ナレッジとして追加
          knowledge.create({
            commentId: savedComment.id,
            deliveryId: delivery.id,
            projectId: delivery.project_id,
            category: analysis.category,
            severity: analysis.severity,
            title: analysis.title,
            description: analysis.description,
            howToAvoid: analysis.how_to_avoid,
            tags: analysis.tags || [],
            vectorSummary: analysis.duplicate_hint,
          });
        } else {
          // 類似ナレッジの出現回数をインクリメント
          knowledge.incrementOccurrence(similar[0].id);
        }
      });
    }

    return res.json({ ok: true, commentId: savedComment.id });
  }

  // コメント解決イベント
  if (payload.type === 'comment.completed') {
    const frameioId = payload.data?.id;
    if (frameioId) {
      const c = comments.byFrameioId(frameioId);
      if (c) comments.resolve(c.id);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true, ignored: payload.type });
});

// ==================== REST API ====================

// --- Members ---
app.get('/api/members', (req, res) => res.json(members.all()));

app.post('/api/members', (req, res) => {
  const { name, role, defaultCost } = req.body;
  if (!name) return res.status(400).json({ error: '名前は必須です' });
  res.json(members.create({ name, role, defaultCost }));
});

app.put('/api/members/:id', (req, res) => {
  res.json(members.update(req.params.id, req.body));
});

app.delete('/api/members/:id', (req, res) => {
  members.delete(req.params.id);
  res.json({ ok: true });
});

// --- Projects ---
app.get('/api/projects', (req, res) => res.json(projects.all()));

app.get('/api/projects/:id', (req, res) => {
  const p = projects.byId(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  // sns_urlsをパース
  try { p.sns_urls = JSON.parse(p.sns_urls || '{}'); } catch { p.sns_urls = {}; }
  const rates = projectRates.byProject(req.params.id);
  const memos = projectMemos.all(req.params.id);
  res.json({ ...p, rates, memos });
});

app.post('/api/projects', (req, res) => {
  const { name, client } = req.body;
  if (!name || !client) return res.status(400).json({ error: '案件名・クライアント名は必須です' });
  const proj = projects.create(req.body);
  // ランク単価を保存
  if (req.body.rates) {
    for (const [rankId, rate] of Object.entries(req.body.rates)) {
      projectRates.upsert(proj.id, rankId, Number(rate) || 0);
    }
  }
  res.json(proj);
});

app.put('/api/projects/:id', (req, res) => {
  const proj = projects.update(req.params.id, req.body);
  // ランク単価を保存
  if (req.body.rates) {
    for (const [rankId, rate] of Object.entries(req.body.rates)) {
      projectRates.upsert(req.params.id, rankId, Number(rate) || 0);
    }
  }
  res.json(proj);
});

app.delete('/api/projects/:id', (req, res) => {
  projects.delete(req.params.id);
  res.json({ ok: true });
});

// --- Project Memos ---
app.get('/api/projects/:id/memos', (req, res) => {
  res.json(projectMemos.all(req.params.id));
});

app.post('/api/projects/:id/memos', (req, res) => {
  if (!req.body.body?.trim()) return res.status(400).json({ error: 'メモ内容は必須です' });
  res.json(projectMemos.create({
    projectId: req.params.id,
    body: req.body.body,
    author: req.body.author || (req.user?.name || ''),
  }));
});

app.delete('/api/project-memos/:id', (req, res) => {
  projectMemos.delete(req.params.id);
  res.json({ ok: true });
});

// --- Editor Ranks ---
app.get('/api/editor-ranks', (req, res) => res.json(editorRanks.all()));

app.post('/api/editor-ranks', (req, res) => {
  if (!req.body.rankName?.trim()) return res.status(400).json({ error: 'ランク名は必須です' });
  res.json(editorRanks.create({ rankName: req.body.rankName.toUpperCase(), sortOrder: req.body.sortOrder }));
});

app.delete('/api/editor-ranks/:id', (req, res) => {
  editorRanks.delete(req.params.id);
  res.json({ ok: true });
});

// --- Deliveries ---
app.get('/api/deliveries', (req, res) => {
  res.json(deliveries.all(req.query));
});

app.post('/api/deliveries', (req, res) => {
  const { projectId, title } = req.body;
  if (!projectId || !title) return res.status(400).json({ error: '案件・タイトルは必須です' });
  res.json(deliveries.create(req.body));
});

app.put('/api/deliveries/:id', (req, res) => {
  res.json(deliveries.update(req.params.id, req.body));
});

app.patch('/api/deliveries/:id/status', (req, res) => {
  deliveries.updateStatus(req.params.id, req.body.status);
  res.json({ ok: true });
});

app.delete('/api/deliveries/:id', (req, res) => {
  deliveries.delete(req.params.id);
  res.json({ ok: true });
});

// --- Comments ---
app.get('/api/deliveries/:id/comments', (req, res) => {
  res.json(comments.all(req.params.id));
});

// 手動コメント追加（Frame.io Webhook未設定時の代替入力）
app.post('/api/deliveries/:id/comments', async (req, res) => {
  const delivery = deliveries.byId(req.params.id);
  if (!delivery) return res.status(404).json({ error: '納品物が見つかりません' });

  const comment = comments.create({
    deliveryId: delivery.id,
    author: req.body.author || '手動入力',
    body: req.body.body,
    timestampSeconds: req.body.timestampSeconds || null,
  });

  // AIでナレッジ生成
  const project = projects.byId(delivery.project_id);
  setImmediate(async () => {
    const analysis = await analyzeCommentWithAI(comment, delivery, project);
    if (!analysis) return;
    const similar = await findSimilarKnowledge(analysis);
    if (similar.length === 0) {
      knowledge.create({
        commentId: comment.id,
        deliveryId: delivery.id,
        projectId: delivery.project_id,
        category: analysis.category,
        severity: analysis.severity,
        title: analysis.title,
        description: analysis.description,
        howToAvoid: analysis.how_to_avoid,
        tags: analysis.tags || [],
        vectorSummary: analysis.duplicate_hint,
      });
    } else {
      knowledge.incrementOccurrence(similar[0].id);
    }
  });

  res.json(comment);
});

// --- Knowledge ---
app.get('/api/knowledge', (req, res) => {
  res.json(knowledge.all(req.query));
});

// 編集者が作業前に確認：担当案件・カテゴリに関連するナレッジをAIが要約して返す
app.post('/api/knowledge/briefing', async (req, res) => {
  const { projectId, memberId, category } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const allKnowledge = knowledge.all({ projectId, category });
  if (!allKnowledge.length) return res.json({ briefing: 'まだナレッジがありません。', items: [] });

  if (!apiKey) {
    return res.json({
      briefing: `${allKnowledge.length}件のナレッジがあります。作業前に確認してください。`,
      items: allKnowledge.slice(0, 5),
    });
  }

  const knowledgeText = allKnowledge.slice(0, 10).map((k, i) =>
    `${i+1}. [${k.category}/${k.severity}] ${k.title}: ${k.how_to_avoid}`
  ).join('\n');

  try {
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `動画編集者への作業前ブリーフィングを作成してください。
以下は過去に指摘されたナレッジです：

${knowledgeText}

編集者が作業を始める前に意識すべきポイントを、日本語で3〜5点の箇条書きにまとめてください。
指示調（〜すること、〜に注意）で書いてください。前後の説明は不要です。`,
      }],
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    res.json({
      briefing: aiRes.data.content[0]?.text || '',
      items: allKnowledge.slice(0, 10),
    });
  } catch (err) {
    res.json({ briefing: knowledgeText, items: allKnowledge.slice(0, 10) });
  }
});

// 週次レポート生成
app.post('/api/knowledge/weekly-report', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const allKnowledge = knowledge.all({});
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const weekItems = allKnowledge.filter(k => k.created_at >= oneWeekAgo);

  if (!apiKey || !weekItems.length) {
    return res.json({
      report: weekItems.length
        ? `今週 ${weekItems.length}件の指摘がナレッジ化されました。`
        : '今週のナレッジはありません。',
      items: weekItems,
    });
  }

  const summary = weekItems.map(k =>
    `・[${k.category}] ${k.title}（重要度:${k.severity}, 発生:${k.occurrence_count}回）`
  ).join('\n');

  try {
    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `動画編集チームの週次品質レポートを日本語で作成してください。

今週のナレッジ（${weekItems.length}件）:
${summary}

以下の構成でまとめてください：
1. 今週の傾向（2〜3文）
2. 特に注意すべきカテゴリ
3. チームへの改善提案（2〜3点）

Markdownなし、プレーンテキストで。`,
      }],
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    res.json({
      report: aiRes.data.content[0]?.text || '',
      items: weekItems,
      totalThisWeek: weekItems.length,
    });
  } catch (err) {
    res.json({ report: summary, items: weekItems });
  }
});

app.delete('/api/knowledge/:id', (req, res) => {
  knowledge.delete(req.params.id);
  res.json({ ok: true });
});

// --- Invoices ---
app.get('/api/invoices', (req, res) => res.json(invoices.all()));

app.post('/api/invoices', (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: '案件IDは必須です' });

  const proj = projects.byId(projectId);
  if (!proj) return res.status(404).json({ error: '案件が見つかりません' });

  // 未請求・納品済の動画を取得
  const allInvoiced = invoices.all().flatMap(inv => JSON.parse(inv.delivery_ids || '[]'));
  const invoicedSet = new Set(allInvoiced);
  const eligible = deliveries.all({ projectId, status: 'done' })
    .filter(d => !invoicedSet.has(d.id));

  if (!eligible.length) {
    return res.status(400).json({ error: '請求可能な納品済み動画がありません' });
  }

  const subtotal = eligible.length * (proj.unit_price || 0);
  const tax = Math.floor(subtotal * TAX_RATE);
  const totalWithTax = subtotal + tax;

  const memberBreakdown = {};
  eligible.forEach(d => {
    const m = members.byId(d.member_id);
    const name = m ? m.name : '不明';
    if (!memberBreakdown[name]) memberBreakdown[name] = { count: 0, cost: 0 };
    memberBreakdown[name].count++;
    memberBreakdown[name].cost += d.edit_cost || 0;
  });

  const invoice = invoices.create({
    projectId,
    projectName: proj.name,
    clientName: proj.client,
    subtotal,
    tax,
    totalWithTax,
    unitPrice: proj.unit_price || 0,
    issuedAt: today(),
    deliveryIds: eligible.map(d => d.id),
    deliveriesSnapshot: eligible.map(d => ({
      id: d.id,
      title: d.title,
      date: d.delivery_date,
      memberName: members.byId(d.member_id)?.name || '不明',
      editCost: d.edit_cost || 0,
      unitPrice: proj.unit_price || 0,
    })),
    memberBreakdown,
  });

  res.json(invoice);
});

app.delete('/api/invoices/:id', (req, res) => {
  invoices.delete(req.params.id);
  res.json({ ok: true });
});

// --- Stats ---
app.get('/api/stats', (req, res) => {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const allProjects = projects.all();
  const allDeliveries = deliveries.all();
  const allInvoiced = invoices.all().flatMap(inv => JSON.parse(inv.delivery_ids || '[]'));
  const invoicedSet = new Set(allInvoiced);

  const activeProjects = allProjects.filter(p => p.status === 'active').length;
  const monthDone = allDeliveries.filter(d =>
    d.status === 'done' && d.delivery_date?.startsWith(monthStr)
  );

  const monthRevenue = monthDone.reduce((sum, d) => {
    const p = projects.byId(d.project_id);
    return sum + (p?.unit_price || 0);
  }, 0);

  const unpaid = allDeliveries
    .filter(d => d.status === 'done' && !invoicedSet.has(d.id))
    .reduce((sum, d) => {
      const p = projects.byId(d.project_id);
      return sum + (p?.unit_price || 0);
    }, 0);

  const knowledgeCount = knowledge.all({}).length;

  res.json({ activeProjects, monthDeliveries: monthDone.length, monthRevenue, unpaid, knowledgeCount });
});

// ==================== ASSETS API ====================

app.get('/api/assets', (req, res) => res.json(assets.all(req.query)));
app.get('/api/assets/:id', (req, res) => {
  const a = assets.byId(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
});
app.delete('/api/assets/:id', (req, res) => { assets.delete(req.params.id); res.json({ ok: true }); });
app.put('/api/assets/:id', (req, res) => res.json(assets.update(req.params.id, req.body)));

// ==================== VIDEO UPLOAD + AI ANALYZE ====================
app.post('/api/assets/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  const { projectId, version, driveFolderId, driveFileId } = req.body;
  const proj  = projectId ? projects.byId(projectId) : null;
  const ver   = version || 'v1';
  const ext   = req.file.originalname.split('.').pop();
  const safeName   = (proj?.name || 'UNKNOWN').replace(/[\\/\s:*?"<>|]/g, '_');
  // 識別コード判定: MIMEタイプ（マイムタイプ）で MOV（動画）か IMG（静止画）かを判別
  const typeCode    = req.file.mimetype.startsWith('image/') ? 'IMG' : 'MOV';
  // MOVとIMGで連番を独立管理
  const seq         = projectId ? assets.nextSeq(projectId, typeCode) : 1;
  // 命名規約: {案件名}_{MOV|IMG}_{連番3桁}_{バージョン}.{拡張子}
  const renamedName = `${safeName}_${typeCode}_${String(seq).padStart(3,'0')}_${ver}.${ext}`;

  const asset = assets.create({
    projectId, originalName: req.file.originalname, renamedName,
    driveFileId: driveFileId || null, driveFolderId: driveFolderId || null,
    mimeType: req.file.mimetype, fileSize: req.file.size,
    version: ver, seqNumber: seq,
  });

  res.json({ ...asset, message: 'アップロード完了。AI解析中...' });
  setImmediate(() => analyzeVideoAsset(asset.id, req.file.path, proj));
});

async function analyzeVideoAsset(assetId, filePath, project) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { assets.update(assetId, { analysisStatus: 'error' }); try { fs.unlinkSync(filePath); } catch {} return; }
  assets.update(assetId, { analysisStatus: 'analyzing' });
  try {
    let frameBase64 = null;
    try {
      const { execSync } = require('child_process');
      const framePath = filePath + '_frame.jpg';
      execSync(`ffmpeg -i "${filePath}" -ss 00:00:03 -vframes 1 -q:v 2 "${framePath}" -y 2>/dev/null`, { timeout: 15000 });
      if (fs.existsSync(framePath)) { frameBase64 = fs.readFileSync(framePath).toString('base64'); fs.unlinkSync(framePath); }
    } catch(e) { console.warn('[AI] ffmpegスキップ:', e.message); }

    const asset = assets.byId(assetId);
    const msgContent = [];
    if (frameBase64) msgContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 } });
    msgContent.push({ type: 'text', text: `動画素材を解析しJSON形式のみで回答。\n【ファイル名】${asset.original_name}\n【案件】${project?.name||'不明'} / ${project?.client||''}\n{\n"title":"タイトル30文字以内",\n"summary":"要約200文字以内",\n"scene_description":"映像の視覚的説明",\n"suggested_use":"想定用途",\n"quality_notes":"品質・注意点",\n"tags":["タグ1","タグ2"]\n}` });

    const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 800,
      messages: [{ role: 'user', content: msgContent }],
    }, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const parsed = JSON.parse(aiRes.data.content[0]?.text.replace(/```json|```/g,'').trim() || '{}');
    const report = `# ${parsed.title||asset.original_name}\n\n## 概要\n${parsed.summary||''}\n\n## シーン詳細\n${parsed.scene_description||''}\n\n## 想定用途\n${parsed.suggested_use||''}\n\n## 品質メモ\n${parsed.quality_notes||''}\n\n## タグ\n${(parsed.tags||[]).map(t=>'#'+t).join('  ')}`;
    assets.update(assetId, { analysisStatus: 'done', aiSummary: parsed.summary||'', aiReport: report });
    console.log('[AI] アセット解析完了:', asset.renamed_name);
  } catch(err) {
    console.error('[AI] アセット解析エラー:', err.message);
    assets.update(assetId, { analysisStatus: 'error' });
  } finally { try { fs.unlinkSync(filePath); } catch {} }
}

// ==================== VIDEO COMMENTS API ====================
app.get('/api/assets/:id/comments', (req, res) => res.json(videoComments.all(req.params.id)));

app.post('/api/assets/:id/comments', (req, res) => {
  const asset = assets.byId(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  res.json(videoComments.create({
    assetId: asset.id, author: req.body.author||'匿名',
    body: req.body.body, timestampSeconds: req.body.timestampSeconds ?? null,
    isPinned: req.body.isPinned||false,
  }));
});

app.patch('/api/video-comments/:id/pin',     (req, res) => { videoComments.pin(req.params.id, req.body.pinned); res.json({ ok: true }); });
app.patch('/api/video-comments/:id/resolve', (req, res) => { videoComments.resolve(req.params.id); res.json({ ok: true }); });

app.post('/api/video-comments/:id/promote', async (req, res) => {
  const vc = videoComments.byId(req.params.id);
  if (!vc) return res.status(404).json({ error: 'Not found' });
  const asset = assets.byId(vc.asset_id);
  const proj  = asset?.project_id ? projects.byId(asset.project_id) : null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let kData = { category:'その他', severity:'medium', title: vc.body.slice(0,20), description: vc.body, howToAvoid:'このコメントを参考にしてください。', tags:[] };
  if (apiKey) {
    try {
      const aiRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model:'claude-sonnet-4-20250514', max_tokens:600,
        messages:[{ role:'user', content:`動画レビューコメントをナレッジ構造化。\n【案件】${proj?.name||''}\n【コメント】${vc.body}\nJSON形式のみ:{"category":"カット編集|カラーグレーディング|テロップ|SE・BGM|尺・テンポ|構成|その他","severity":"low|medium|high","title":"20文字","description":"100文字","how_to_avoid":"150文字","tags":[]}`}],
      }, { headers:{ 'x-api-key':apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'} });
      const p = JSON.parse(aiRes.data.content[0]?.text.replace(/```json|```/g,'').trim()||'{}');
      kData = { category:p.category||kData.category, severity:p.severity||kData.severity, title:p.title||kData.title, description:p.description||kData.description, howToAvoid:p.how_to_avoid||kData.howToAvoid, tags:p.tags||[] };
    } catch(e){ console.error('[AI] promote err:',e.message); }
  }
  const kn = knowledge.create({ ...kData, projectId: proj?.id||null });
  videoComments.promoteToKnowledge(vc.id, kn.id);
  res.json({ ok:true, knowledge:kn });
});

app.delete('/api/video-comments/:id', (req, res) => { videoComments.delete(req.params.id); res.json({ ok:true }); });

// ==================== 認証ルート ====================

// Google OAuth ログイン開始
app.get('/auth/google', passportInstance.authenticate('google', { scope: ['profile', 'email'] }));

// Google OAuth コールバック
app.get('/auth/google/callback',
  passportInstance.authenticate('google', { failureRedirect: '/login.html?error=google' }),
  (req, res) => res.redirect('/')
);

// メール＋パスワード ログイン
app.post('/auth/login', (req, res, next) => {
  passportInstance.authenticate('local', (err, user, info) => {
    if (err)    return next(err);
    if (!user)  return res.status(401).json({ error: info?.message || 'ログインに失敗しました' });
    req.logIn(user, err => {
      if (err) return next(err);
      res.json({ ok: true, user: safeUser(user) });
    });
  })(req, res, next);
});

// ログアウト
app.post('/auth/logout', (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

// 現在のログインユーザー情報（fetchからも呼ばれるのでリダイレクトせずJSON返却）
app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  res.json(safeUser(req.user));
});

// ==================== 招待 API ====================
// 管理者のみ招待発行可能

// ==================== 招待管理 API（Supabase永続化） ====================

app.get('/api/invitations', requireAuth, requireLevel('secretary'), async (req, res) => {
  const { data } = await supabase.from('invitations')
    .select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/invitations', requireAuth, requireLevel('secretary'), async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'メールアドレスは必須です' });

  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) return res.status(409).json({ error: 'このメールアドレスはすでに登録済みです' });

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: inv, error } = await supabase.from('invitations').insert({
    token, email, role: role || 'editor',
    invited_by_email: req.user.email,
    expires_at: expiresAt
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${baseUrl}/invite.html?token=${token}`;
  res.json({ ...inv, inviteLink: link });
});

app.delete('/api/invitations/:id', requireAuth, requireLevel('admin'), async (req, res) => {
  await supabase.from('invitations').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// 招待トークン検証（招待ページで呼ぶ）
app.get('/api/invitations/verify/:token', async (req, res) => {
  const { data: inv } = await supabase.from('invitations')
    .select('*').eq('token', req.params.token).maybeSingle();
  if (!inv) return res.status(410).json({ error: '招待リンクが無効または期限切れです' });
  if (inv.used) return res.status(410).json({ error: 'この招待リンクはすでに使用されています' });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '招待リンクの有効期限が切れています（24時間）' });
  res.json({ email: inv.email, role: inv.role });
});

// 招待経由の新規登録
app.post('/api/invitations/register', async (req, res) => {
  const { token, name, password } = req.body;
  if (!token || !name || !password) return res.status(400).json({ error: '名前・パスワード・トークンは必須です' });
  try {
    const { data: inv } = await supabase.from('invitations')
      .select('*').eq('token', token).maybeSingle();
    if (!inv) throw new Error('招待リンクが無効です');
    if (inv.used) throw new Error('この招待リンクはすでに使用されています');
    if (new Date(inv.expires_at) < new Date()) throw new Error('招待リンクの有効期限が切れています（24時間）');

    // SQLite にユーザー作成（セッション認証用）
    const existing = users.byEmail(inv.email);
    if (existing) throw new Error('このメールアドレスはすでに登録済みです');
    const passwordHash = await bcrypt.hash(password, 12);
    const sqliteUser = users.create({ name, email: inv.email, role: inv.role, passwordHash });

    // Supabase にユーザー作成（アプリデータ用 / IDはSupabaseのUUIDを自動生成）
    const { error: sbErr } = await supabase.from('users').insert({
      email: inv.email, full_name: name, role: inv.role, is_active: true
    });
    if (sbErr) console.error('[invite register] Supabase user insert error:', sbErr.message);

    // 招待を使用済みにする
    await supabase.from('invitations').update({ used: true, used_at: new Date().toISOString() }).eq('token', token);

    req.logIn(sqliteUser, err => {
      if (err) return res.status(500).json({ error: 'ログインに失敗しました' });
      res.json({ ok: true, user: safeUser(sqliteUser) });
    });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== ユーザー管理 API ====================

app.get('/api/users', requireAuth, requireLevel('admin'), (req, res) => {
  res.json(users.all().map(safeUser));
});

app.put('/api/users/:id', requireAuth, requireLevel('admin'), (req, res) => {
  const { name, role, isActive } = req.body;
  // 自分自身の権限を下げることはできない
  if (req.params.id === req.user.id && role && role !== 'admin') {
    return res.status(400).json({ error: '自分自身の管理者権限は変更できません' });
  }
  res.json(safeUser(users.update(req.params.id, { name, role, isActive })));
});

app.delete('/api/users/:id', requireAuth, requireLevel('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: '自分自身は削除できません' });
  users.delete(req.params.id);
  res.json({ ok: true });
});

// パスワード変更（本人のみ）
app.post('/api/users/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上必要です' });
  const u = users.byId(req.user.id);
  if (u.password_hash) {
    const ok = await bcrypt.compare(currentPassword, u.password_hash);
    if (!ok) return res.status(400).json({ error: '現在のパスワードが正しくありません' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  users.update(req.user.id, { passwordHash: hash });
  res.json({ ok: true });
});

// ==================== 既存APIに認証ガードを追加 ====================
// requireAuthはすでに静的ファイル配信に適用済み
// APIルートには役割に応じたガードを設定

// セーフユーザー: パスワードハッシュなど機密情報を除いたユーザーオブジェクト
function safeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

// フロントエンドのすべてのルートをindex.htmlに向ける（SPA対応）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  requireAuth(req, res, () => {
    res.sendFile(path.join(__dirname, 'public', 'haruka.html'));
  });
});
// ==================== 初期管理者作成 ====================
async function seedAdminIfNeeded() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    console.log(`[SEED] ADMIN_EMAIL=${adminEmail || '未設定'} ADMIN_PASSWORD=${adminPassword ? '設定済み' : '未設定'}`);
    if (!adminEmail || !adminPassword) {
      console.log('[SEED] スキップ: 環境変数が未設定');
      return;
    }
    const existing = users.byEmail(adminEmail);
    if (existing) {
      console.log(`[SEED] スキップ: ${adminEmail} はすでに登録済み`);
      return;
    }
    const hash = await bcrypt.hash(adminPassword, 12);
    const created = users.create({ name: '管理者', email: adminEmail, role: 'admin', passwordHash: hash });
    console.log(`[SEED] 管理者アカウントを作成しました: ${adminEmail} (id=${created?.id})`);
  } catch(e) {
    console.error('[SEED] エラー:', e.message);
  }
}

// ==================== サーバー起動 ====================
app.listen(PORT, async () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   VIDEO OPS サーバー起動              ║
  ║   http://localhost:${PORT}              ║
  ╚═══════════════════════════════════════╝
  `);
  await seedAdminIfNeeded();
});

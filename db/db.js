// db/db.js — SQLite データベース管理
// better-sqlite3（ベタースクライトスリー）を使って同期的にDBを操作します
// SQLite（エスキューライト）はファイル1つで動くデータベースで、サーバー不要で運用できます

const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './db/videoops.db';
const db = new Database(path.resolve(DB_PATH));

// WAL モード：複数の読み取りと書き込みを同時に処理できるようにする設定
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== テーブル初期化 ====================
db.exec(`
  -- ユーザー認証テーブル
  -- role: admin / director / editor / client
  -- google_id: Google OAuthのユーザーID
  -- password_hash: bcryptでハッシュ化したパスワード（メール認証用）
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    google_id TEXT UNIQUE,
    password_hash TEXT,
    avatar_url TEXT,
    is_active INTEGER DEFAULT 1,
    last_login_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 招待トークンテーブル
  -- token: ランダムな招待URL用トークン（UUIDv4）
  -- expires_at: 有効期限（発行から24時間）
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    invited_by TEXT REFERENCES users(id),
    used INTEGER DEFAULT 0,
    used_by TEXT REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- メンバー
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    default_cost INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 案件
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    project_code TEXT UNIQUE,          -- 案件ID（例: PRJ-2025-001）
    name TEXT NOT NULL,
    client TEXT NOT NULL,
    start_date TEXT,
    status TEXT DEFAULT 'active',
    unit_price INTEGER DEFAULT 0,      -- クライアントへの請求単価（1本あたり）
    contract_count INTEGER DEFAULT 0,
    homepage_url TEXT,                 -- クライアントのホームページURL
    sns_urls TEXT DEFAULT '{}',        -- SNS各種URL（JSON形式で保存）
    drive_folder_url TEXT,
    frameio_project_id TEXT,
    remarks TEXT,                      -- 備考（全体サマリー）
    producer_rate INTEGER DEFAULT 0,   -- プロデューサー単価（1本あたり）
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 案件メモ（タイムライン形式・追記専用）
  -- 案件に関する日々の出来事や連絡事項を時系列で蓄積する
  CREATE TABLE IF NOT EXISTS project_memos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    author TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 編集者ランクマスター（管理者が自由に追加・削除可能）
  -- デフォルト: A / B / C の3段階
  CREATE TABLE IF NOT EXISTS editor_ranks (
    id TEXT PRIMARY KEY,
    rank_name TEXT NOT NULL UNIQUE,    -- 例: 'A', 'B', 'C', 'S'
    sort_order INTEGER DEFAULT 0,      -- 表示順
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 案件ごとのランク別単価
  -- project_id + rank_id の組み合わせで1レコード
  CREATE TABLE IF NOT EXISTS project_rates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rank_id TEXT NOT NULL REFERENCES editor_ranks(id) ON DELETE CASCADE,
    rate INTEGER DEFAULT 0,            -- このランクの編集者への支払い単価（1本あたり）
    UNIQUE(project_id, rank_id)
  );

  -- 納品物（動画1本単位）
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    edit_cost INTEGER DEFAULT 0,
    delivery_date TEXT,
    status TEXT DEFAULT 'pending',
    frameio_asset_id TEXT,
    frameio_review_link TEXT,
    note TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- Frame.io コメント（生データ）
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    delivery_id TEXT REFERENCES deliveries(id) ON DELETE CASCADE,
    frameio_comment_id TEXT UNIQUE,
    author TEXT,
    body TEXT NOT NULL,
    timestamp_seconds REAL,
    resolved INTEGER DEFAULT 0,
    raw_json TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- ナレッジ（AIが解析・構造化した指摘）
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
    delivery_id TEXT,
    project_id TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    how_to_avoid TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    vector_summary TEXT,
    occurrence_count INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  -- 素材アセット（動画ファイル管理）
  -- drive_file_id: Google DriveのファイルID
  -- original_name: アップロード時の元ファイル名
  -- renamed_name: 命名規約に従ってAIが生成したファイル名
  -- analysis_status: pending / analyzing / done / error
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    renamed_name TEXT,
    drive_file_id TEXT,
    drive_folder_id TEXT,
    mime_type TEXT DEFAULT 'video/mp4',
    duration_seconds REAL,
    file_size INTEGER,
    analysis_status TEXT DEFAULT 'pending',
    ai_summary TEXT,
    ai_report TEXT,
    transcript TEXT,
    version TEXT DEFAULT 'v1',
    seq_number INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 動画タイムスタンプコメント
  -- asset_idの動画上の特定秒(timestamp_seconds)に紐付いたコメント
  CREATE TABLE IF NOT EXISTS video_comments (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    timestamp_seconds REAL,
    is_pinned INTEGER DEFAULT 0,
    resolved INTEGER DEFAULT 0,
    promoted_to_knowledge INTEGER DEFAULT 0,
    knowledge_id TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  -- 請求書
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id),
    project_name TEXT,
    client_name TEXT,
    subtotal INTEGER DEFAULT 0,
    tax INTEGER DEFAULT 0,
    total_with_tax INTEGER DEFAULT 0,
    unit_price INTEGER DEFAULT 0,
    issued_at TEXT,
    delivery_ids TEXT DEFAULT '[]',
    deliveries_snapshot TEXT DEFAULT '[]',
    member_breakdown TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// ==================== ヘルパー関数 ====================

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// --- Members ---
const members = {
  all: () => db.prepare('SELECT * FROM members ORDER BY created_at DESC').all(),
  byId: (id) => db.prepare('SELECT * FROM members WHERE id = ?').get(id),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT INTO members (id, name, role, default_cost) VALUES (?, ?, ?, ?)`)
      .run(id, data.name, data.role || 'editor', data.defaultCost || 0);
    return members.byId(id);
  },
  update: (id, data) => {
    db.prepare(`UPDATE members SET name=?, role=?, default_cost=? WHERE id=?`)
      .run(data.name, data.role, data.defaultCost || 0, id);
    return members.byId(id);
  },
  delete: (id) => db.prepare('DELETE FROM members WHERE id = ?').run(id),
};

// --- Projects ---
const projects = {
  all: () => db.prepare('SELECT * FROM projects ORDER BY start_date DESC, created_at DESC').all(),
  byId: (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id),
  create: (data) => {
    const id = uid();
    // 案件コード自動採番: PRJ-YYYY-NNN
    const year = new Date().getFullYear();
    const count = db.prepare("SELECT COUNT(*) as n FROM projects WHERE project_code LIKE ?").get(`PRJ-${year}-%`).n;
    const projectCode = data.projectCode || `PRJ-${year}-${String(count+1).padStart(3,'0')}`;
    db.prepare(`INSERT INTO projects
      (id, project_code, name, client, unit_price, contract_count, status,
       homepage_url, sns_urls, drive_folder_url, frameio_project_id,
       start_date, remarks, producer_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectCode, data.name, data.client,
        data.unitPrice || 0, data.contractCount || 0, data.status || 'active',
        data.homepageUrl || null, JSON.stringify(data.snsUrls || {}),
        data.driveFolderUrl || null, data.frameioProjectId || null,
        data.startDate || null, data.remarks || null, data.producerRate || 0);
    return projects.byId(id);
  },
  update: (id, data) => {
    db.prepare(`UPDATE projects SET
      project_code=?, name=?, client=?, unit_price=?, contract_count=?, status=?,
      homepage_url=?, sns_urls=?, drive_folder_url=?, frameio_project_id=?,
      start_date=?, remarks=?, producer_rate=?
      WHERE id=?`)
      .run(data.projectCode, data.name, data.client,
        data.unitPrice || 0, data.contractCount || 0, data.status,
        data.homepageUrl || null, JSON.stringify(data.snsUrls || {}),
        data.driveFolderUrl || null, data.frameioProjectId || null,
        data.startDate || null, data.remarks || null, data.producerRate || 0, id);
    return projects.byId(id);
  },
  delete: (id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
};

// --- Project Memos（タイムライン形式メモ） ---
const projectMemos = {
  all: (projectId) => db.prepare(
    'SELECT * FROM project_memos WHERE project_id=? ORDER BY created_at DESC'
  ).all(projectId),
  create: (data) => {
    const id = uid();
    db.prepare('INSERT INTO project_memos (id, project_id, body, author) VALUES (?, ?, ?, ?)')
      .run(id, data.projectId, data.body, data.author || '');
    return db.prepare('SELECT * FROM project_memos WHERE id=?').get(id);
  },
  delete: (id) => db.prepare('DELETE FROM project_memos WHERE id=?').run(id),
};

// --- Editor Ranks（ランクマスター） ---
const editorRanks = {
  all: () => db.prepare('SELECT * FROM editor_ranks ORDER BY sort_order ASC, rank_name ASC').all(),
  byId: (id) => db.prepare('SELECT * FROM editor_ranks WHERE id=?').get(id),
  create: (data) => {
    const id = uid();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM editor_ranks').get().m || 0;
    db.prepare('INSERT OR IGNORE INTO editor_ranks (id, rank_name, sort_order) VALUES (?, ?, ?)')
      .run(id, data.rankName, data.sortOrder ?? maxOrder + 1);
    return editorRanks.byId(id);
  },
  delete: (id) => db.prepare('DELETE FROM editor_ranks WHERE id=?').run(id),
  // デフォルトランク初期化（初回起動時のみ）
  initDefaults: () => {
    const exists = db.prepare('SELECT COUNT(*) as n FROM editor_ranks').get().n;
    if (exists > 0) return;
    [['A',1],['B',2],['C',3]].forEach(([name,order]) => {
      const id = uid();
      db.prepare('INSERT OR IGNORE INTO editor_ranks (id, rank_name, sort_order) VALUES (?,?,?)')
        .run(id, name, order);
    });
  },
};
editorRanks.initDefaults();

// --- Project Rates（案件ごとのランク別単価） ---
const projectRates = {
  // 案件の全ランク単価を取得（ランク情報も結合）
  byProject: (projectId) => db.prepare(`
    SELECT pr.*, er.rank_name, er.sort_order
    FROM project_rates pr
    JOIN editor_ranks er ON pr.rank_id = er.id
    WHERE pr.project_id = ?
    ORDER BY er.sort_order ASC
  `).all(projectId),
  // 単価をupsert（あれば更新、なければ挿入）
  // UPSERT（アップサート）: UPDATE + INSERT を1回の操作で行う
  upsert: (projectId, rankId, rate) => {
    const id = uid();
    db.prepare(`INSERT INTO project_rates (id, project_id, rank_id, rate)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, rank_id) DO UPDATE SET rate=excluded.rate`)
      .run(id, projectId, rankId, rate);
  },
  // 案件・ランクから単価を取得
  getRate: (projectId, rankId) => {
    const r = db.prepare('SELECT rate FROM project_rates WHERE project_id=? AND rank_id=?').get(projectId, rankId);
    return r?.rate ?? 0;
  },
};

// --- Deliveries ---
const deliveries = {
  all: (filters = {}) => {
    let q = 'SELECT * FROM deliveries WHERE 1=1';
    const params = [];
    if (filters.projectId) { q += ' AND project_id = ?'; params.push(filters.projectId); }
    if (filters.status)    { q += ' AND status = ?';     params.push(filters.status); }
    if (filters.memberId)  { q += ' AND member_id = ?';  params.push(filters.memberId); }
    q += ' ORDER BY created_at DESC';
    return db.prepare(q).all(...params);
  },
  byId: (id) => db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id),
  byFrameioAssetId: (assetId) => db.prepare('SELECT * FROM deliveries WHERE frameio_asset_id = ?').get(assetId),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT INTO deliveries 
      (id, project_id, member_id, title, edit_cost, delivery_date, status, frameio_asset_id, frameio_review_link, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, data.projectId, data.memberId || null, data.title, data.editCost || 0,
        data.deliveryDate || null, data.status || 'pending',
        data.frameioAssetId || null, data.frameioReviewLink || null, data.note || null);
    return deliveries.byId(id);
  },
  update: (id, data) => {
    db.prepare(`UPDATE deliveries SET 
      project_id=?, member_id=?, title=?, edit_cost=?, delivery_date=?,
      status=?, frameio_asset_id=?, frameio_review_link=?, note=?
      WHERE id=?`)
      .run(data.projectId, data.memberId || null, data.title, data.editCost || 0,
        data.deliveryDate || null, data.status,
        data.frameioAssetId || null, data.frameioReviewLink || null,
        data.note || null, id);
    return deliveries.byId(id);
  },
  updateStatus: (id, status) => {
    db.prepare('UPDATE deliveries SET status=? WHERE id=?').run(status, id);
  },
  delete: (id) => db.prepare('DELETE FROM deliveries WHERE id = ?').run(id),
};

// --- Comments ---
const comments = {
  all: (deliveryId) => db.prepare('SELECT * FROM comments WHERE delivery_id = ? ORDER BY timestamp_seconds ASC').all(deliveryId),
  byId: (id) => db.prepare('SELECT * FROM comments WHERE id = ?').get(id),
  byFrameioId: (fid) => db.prepare('SELECT * FROM comments WHERE frameio_comment_id = ?').get(fid),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT OR IGNORE INTO comments 
      (id, delivery_id, frameio_comment_id, author, body, timestamp_seconds, resolved, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, data.deliveryId, data.frameioCommentId || null, data.author || 'unknown',
        data.body, data.timestampSeconds || null, data.resolved ? 1 : 0,
        data.rawJson ? JSON.stringify(data.rawJson) : null);
    return comments.byId(id);
  },
  resolve: (id) => db.prepare('UPDATE comments SET resolved=1 WHERE id=?').run(id),
};

// --- Knowledge ---
const knowledge = {
  all: (filters = {}) => {
    let q = 'SELECT * FROM knowledge WHERE 1=1';
    const params = [];
    if (filters.category) { q += ' AND category = ?'; params.push(filters.category); }
    if (filters.projectId) { q += ' AND project_id = ?'; params.push(filters.projectId); }
    if (filters.search) {
      q += ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)';
      const s = `%${filters.search}%`;
      params.push(s, s, s);
    }
    q += ' ORDER BY occurrence_count DESC, updated_at DESC';
    return db.prepare(q).all(...params);
  },
  byId: (id) => db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT INTO knowledge 
      (id, comment_id, delivery_id, project_id, category, severity, title, description, how_to_avoid, tags, vector_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, data.commentId || null, data.deliveryId || null, data.projectId || null,
        data.category, data.severity || 'medium', data.title, data.description,
        data.howToAvoid, JSON.stringify(data.tags || []), data.vectorSummary || null);
    return knowledge.byId(id);
  },
  incrementOccurrence: (id) => {
    db.prepare('UPDATE knowledge SET occurrence_count = occurrence_count + 1, updated_at = unixepoch() WHERE id = ?').run(id);
  },
  delete: (id) => db.prepare('DELETE FROM knowledge WHERE id = ?').run(id),
};

// --- Invoices ---
const invoices = {
  all: () => db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all(),
  byId: (id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id),
  count: () => db.prepare('SELECT COUNT(*) as n FROM invoices').get().n,
  create: (data) => {
    const id = uid();
    const num = String(invoices.count() + 1).padStart(4, '0');
    db.prepare(`INSERT INTO invoices 
      (id, number, project_id, project_name, client_name, subtotal, tax, total_with_tax,
       unit_price, issued_at, delivery_ids, deliveries_snapshot, member_breakdown)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, num, data.projectId, data.projectName, data.clientName,
        data.subtotal, data.tax, data.totalWithTax, data.unitPrice,
        data.issuedAt, JSON.stringify(data.deliveryIds || []),
        JSON.stringify(data.deliveriesSnapshot || []),
        JSON.stringify(data.memberBreakdown || {}));
    return invoices.byId(id);
  },
  delete: (id) => db.prepare('DELETE FROM invoices WHERE id = ?').run(id),
};

module.exports = { db, uid, members, projects, projectMemos, editorRanks, projectRates, deliveries, comments, knowledge, invoices };

// --- Assets（素材動画） ---
const assets = {
  all: (filters = {}) => {
    let q = 'SELECT * FROM assets WHERE 1=1';
    const params = [];
    if (filters.projectId)     { q += ' AND project_id = ?';      params.push(filters.projectId); }
    if (filters.deliveryId)    { q += ' AND delivery_id = ?';     params.push(filters.deliveryId); }
    if (filters.driveFolderId) { q += ' AND drive_folder_id = ?'; params.push(filters.driveFolderId); }
    q += ' ORDER BY created_at DESC';
    return db.prepare(q).all(...params);
  },
  byId:      (id)  => db.prepare('SELECT * FROM assets WHERE id = ?').get(id),
  byDriveId: (did) => db.prepare('SELECT * FROM assets WHERE drive_file_id = ?').get(did),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT INTO assets
      (id, project_id, delivery_id, original_name, renamed_name, drive_file_id, drive_folder_id,
       mime_type, duration_seconds, file_size, analysis_status, version, seq_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id,
        data.projectId    || null,
        data.deliveryId   || null,
        data.originalName,
        data.renamedName  || null,
        data.driveFileId  || null,
        data.driveFolderId|| null,
        data.mimeType     || 'video/mp4',
        data.durationSeconds || null,
        data.fileSize     || null,
        data.version      || 'v1',
        data.seqNumber    || 1);
    return assets.byId(id);
  },
  update: (id, data) => {
    const fields = [];
    const vals   = [];
    const map = {
      renamedName:     'renamed_name',
      analysisStatus:  'analysis_status',
      aiSummary:       'ai_summary',
      aiReport:        'ai_report',
      transcript:      'transcript',
      durationSeconds: 'duration_seconds',
      deliveryId:      'delivery_id',
      driveFileId:     'drive_file_id',
      version:         'version',
      seqNumber:       'seq_number',
    };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col}=?`); vals.push(data[k]); }
    }
    if (!fields.length) return assets.byId(id);
    vals.push(id);
    db.prepare(`UPDATE assets SET ${fields.join(',')} WHERE id=?`).run(...vals);
    return assets.byId(id);
  },
  delete:  (id) => db.prepare('DELETE FROM assets WHERE id = ?').run(id),
  // typeCode: 'MOV' か 'IMG' を渡すと、それぞれ独立した連番を返す
  nextSeq: (projectId, typeCode) => {
    const r = db.prepare(
      'SELECT MAX(seq_number) as m FROM assets WHERE project_id=? AND mime_type ' +
      (typeCode === "IMG" ? "LIKE 'image/%'" : "NOT LIKE 'image/%'")
    ).get(projectId);
    return (r?.m || 0) + 1;
  },
};

// --- Video Comments（タイムスタンプコメント） ---
const videoComments = {
  all: (assetId) => db.prepare(
    'SELECT * FROM video_comments WHERE asset_id=? ORDER BY COALESCE(timestamp_seconds,9999999) ASC, created_at ASC'
  ).all(assetId),
  byId:   (id) => db.prepare('SELECT * FROM video_comments WHERE id=?').get(id),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT INTO video_comments
      (id, asset_id, author, body, timestamp_seconds, is_pinned)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id,
        data.assetId,
        data.author || '匿名',
        data.body,
        data.timestampSeconds ?? null,
        data.isPinned ? 1 : 0);
    return videoComments.byId(id);
  },
  pin:     (id, v) => db.prepare('UPDATE video_comments SET is_pinned=? WHERE id=?').run(v ? 1 : 0, id),
  resolve: (id)    => db.prepare('UPDATE video_comments SET resolved=1   WHERE id=?').run(id),
  promoteToKnowledge: (id, knowledgeId) =>
    db.prepare('UPDATE video_comments SET promoted_to_knowledge=1, knowledge_id=? WHERE id=?').run(knowledgeId, id),
  delete: (id) => db.prepare('DELETE FROM video_comments WHERE id=?').run(id),
};

// 末尾のexportsを上書き
Object.assign(module.exports, { assets, videoComments, projectMemos, editorRanks, projectRates });

// --- Users ---
const users = {
  all: () => db.prepare('SELECT id,name,email,role,google_id,avatar_url,is_active,last_login_at,created_at FROM users ORDER BY created_at ASC').all(),
  byId:    (id)    => db.prepare('SELECT * FROM users WHERE id=?').get(id),
  byEmail: (email) => db.prepare('SELECT * FROM users WHERE email=?').get(email),
  byGoogleId: (gid) => db.prepare('SELECT * FROM users WHERE google_id=?').get(gid),
  create: (data) => {
    const id = uid();
    db.prepare(`INSERT OR IGNORE INTO users (id,name,email,role,google_id,password_hash,avatar_url)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, data.name, data.email, data.role||'editor',
        data.googleId||null, data.passwordHash||null, data.avatarUrl||null);
    return users.byId(id);
  },
  update: (id, data) => {
    const fields=[]; const vals=[];
    const map={name:'name',role:'role',avatarUrl:'avatar_url',isActive:'is_active',passwordHash:'password_hash',googleId:'google_id'};
    for(const[k,col] of Object.entries(map)){
      if(data[k]!==undefined){fields.push(`${col}=?`);vals.push(data[k]);}
    }
    if(!fields.length) return users.byId(id);
    vals.push(id);
    db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals);
    return users.byId(id);
  },
  touchLogin: (id) => db.prepare('UPDATE users SET last_login_at=unixepoch() WHERE id=?').run(id),
  delete: (id) => db.prepare('DELETE FROM users WHERE id=?').run(id),
  count: () => db.prepare('SELECT COUNT(*) as n FROM users').get().n,
};

// --- Invitations ---
const invitations = {
  byToken: (token) => db.prepare('SELECT * FROM invitations WHERE token=?').get(token),
  all: () => db.prepare('SELECT i.*,u.name as invited_by_name FROM invitations i LEFT JOIN users u ON i.invited_by=u.id ORDER BY i.created_at DESC').all(),
  create: (data) => {
    const id  = uid();
    const exp = Math.floor(Date.now()/1000) + 86400; // 24時間
    db.prepare(`INSERT INTO invitations (id,token,email,role,invited_by,expires_at) VALUES (?,?,?,?,?,?)`)
      .run(id, data.token, data.email, data.role||'editor', data.invitedBy||null, exp);
    return invitations.byToken(data.token);
  },
  markUsed: (token, userId) => db.prepare('UPDATE invitations SET used=1,used_by=? WHERE token=?').run(userId, token),
  delete: (id) => db.prepare('DELETE FROM invitations WHERE id=?').run(id),
  purgeExpired: () => db.prepare('DELETE FROM invitations WHERE expires_at < unixepoch() AND used=0').run(),
};

Object.assign(module.exports, { users, invitations });

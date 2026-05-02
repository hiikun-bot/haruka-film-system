// routes/accounting.js — 案件収支（Project Accounting）API — Step B 読み取り系
//
// 設計: docs/project_accounting_design_ja.md
// マイグレ: migrations/2026-05-02_project_accounting_step_a.sql
//
// Feature flag:
//   - 環境変数 ENABLE_PROJECT_ACCOUNTING が 'true' / '1' / 'on' のいずれかでない限り、
//     全エンドポイントは 503 を返す（既存環境への影響をゼロから始める）
//   - server.js 側でルーター自体をマウントしない設計と二重防御
//
// 権限:
//   - 全エンドポイント admin ロール必須（secretary・director・editor 等は 403）
//   - 経営機密（契約総額・粗利等）のため明示的にロックダウン
//
// 提供API（全て読み取り専用）:
//   - GET /projects             案件収支一覧
//   - GET /projects/:id         案件詳細（finance_book / estimates / cost_entries / revenue_entries / input_profile）
//   - GET /projects/:id/similar 類似案件比較（同 project_type + 正規化メトリクス近傍）

const express = require('express');
const router  = express.Router();
const supabase = require('../supabase');
const { requireAuth, requireLevel } = require('../auth');

// 案件収支は **admin ロールのみ** に強制制限。
// secretary を含む他のロールは一切アクセス不可（API は 403、UI 側はタブ非表示）。
// 業務的に契約総額・粗利は経営機密のため、明示的なロックダウンを行う。
const requireAdmin = requireLevel('admin');

// ---------- Feature flag ----------
function isEnabled() {
  const v = String(process.env.ENABLE_PROJECT_ACCOUNTING || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

router.use((req, res, next) => {
  if (!isEnabled()) {
    return res.status(503).json({
      error: '案件収支機能は無効化されています',
      hint:  'Railway 環境変数 ENABLE_PROJECT_ACCOUNTING=true を設定してください',
    });
  }
  next();
});

// ---------- ヘルパ ----------

// 数値正規化（NULL/undefined → 0）
const n = v => Number(v) || 0;

// project_id 配列から finance_books を取り、id→row Map にする
async function fetchFinanceBooksByProjectIds(projectIds) {
  if (!projectIds.length) return new Map();
  const { data, error } = await supabase
    .from('project_finance_books')
    .select('*')
    .in('project_id', projectIds);
  if (error) throw new Error(`project_finance_books 取得失敗: ${error.message}`);
  const map = new Map();
  (data || []).forEach(row => map.set(row.project_id, row));
  return map;
}

// 集計済の cost / revenue を project_id ごとに合算
async function aggregateActualsByProject(projectIds) {
  const result = new Map();
  if (!projectIds.length) return result;

  const ensure = (pid) => {
    if (!result.has(pid)) result.set(pid, { actual_cost: 0, actual_revenue: 0, cost_entry_count: 0, revenue_entry_count: 0 });
    return result.get(pid);
  };

  const { data: costs, error: costErr } = await supabase
    .from('project_cost_entries')
    .select('project_id, amount')
    .in('project_id', projectIds);
  if (costErr) throw new Error(`project_cost_entries 集計失敗: ${costErr.message}`);
  (costs || []).forEach(r => {
    const e = ensure(r.project_id);
    e.actual_cost += n(r.amount);
    e.cost_entry_count += 1;
  });

  const { data: revs, error: revErr } = await supabase
    .from('project_revenue_entries')
    .select('project_id, amount')
    .in('project_id', projectIds);
  if (revErr) throw new Error(`project_revenue_entries 集計失敗: ${revErr.message}`);
  (revs || []).forEach(r => {
    const e = ensure(r.project_id);
    e.actual_revenue += n(r.amount);
    e.revenue_entry_count += 1;
  });

  return result;
}

// ---------- GET /projects 案件収支一覧 ----------
router.get('/projects', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const includeHidden = req.query.include_hidden === 'true';

    let q = supabase
      .from('projects')
      .select('id, name, status, client_id, start_date, end_date, is_hidden')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (!includeHidden) q = q.eq('is_hidden', false);

    const { data: projects, error } = await q;
    if (error) throw new Error(error.message);

    const projectIds = (projects || []).map(p => p.id);
    const [booksByPid, actualsByPid, clientsByCid] = await Promise.all([
      fetchFinanceBooksByProjectIds(projectIds),
      aggregateActualsByProject(projectIds),
      (async () => {
        const cids = Array.from(new Set((projects || []).map(p => p.client_id).filter(Boolean)));
        if (!cids.length) return new Map();
        const { data } = await supabase.from('clients').select('id, name').in('id', cids);
        const m = new Map();
        (data || []).forEach(c => m.set(c.id, c.name));
        return m;
      })(),
    ]);

    const items = (projects || []).map(p => {
      const book    = booksByPid.get(p.id) || {};
      const actuals = actualsByPid.get(p.id) || { actual_cost: 0, actual_revenue: 0 };
      const actual_revenue = n(actuals.actual_revenue);
      const actual_cost    = n(actuals.actual_cost);
      const gross_margin   = actual_revenue - actual_cost;
      const gross_margin_rate = actual_revenue > 0 ? gross_margin / actual_revenue : null;
      return {
        project_id:        p.id,
        name:              p.name,
        status:            p.status,
        client_id:         p.client_id,
        client_name:       clientsByCid.get(p.client_id) || null,
        start_date:        p.start_date,
        end_date:          p.end_date,
        contract_total:    n(book.contract_total),
        estimated_revenue: n(book.estimated_revenue),
        estimated_cost:    n(book.estimated_cost),
        actual_revenue,
        actual_cost,
        gross_margin,
        gross_margin_rate, // null 可（actual_revenue=0 の場合）
        book_status:       book.status || 'open',
      };
    });

    res.json({ items, count: items.length, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message || '案件収支一覧の取得に失敗しました' });
  }
});

// ---------- GET /projects/:id 案件詳細 ----------
router.get('/projects/:id', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  if (!projectId) return res.status(400).json({ error: 'project id is required' });

  try {
    const { data: project, error: pErr } = await supabase
      .from('projects')
      .select('id, name, status, client_id, start_date, end_date, is_hidden')
      .eq('id', projectId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const [bookRes, profileRes, estimatesRes, costsRes, revenuesRes, clientRes] = await Promise.all([
      supabase.from('project_finance_books').select('*').eq('project_id', projectId).maybeSingle(),
      supabase.from('project_input_profiles').select('*').eq('project_id', projectId).maybeSingle(),
      supabase.from('project_estimates').select('*').eq('project_id', projectId).order('version', { ascending: false }),
      supabase.from('project_cost_entries').select('*').eq('project_id', projectId).order('occurred_on', { ascending: false }),
      supabase.from('project_revenue_entries').select('*').eq('project_id', projectId).order('occurred_on', { ascending: false }),
      project.client_id
        ? supabase.from('clients').select('id, name').eq('id', project.client_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    // 各見積の明細を取得
    const estimates = estimatesRes.data || [];
    let estimateItemsByEstId = new Map();
    if (estimates.length) {
      const estIds = estimates.map(e => e.id);
      const { data: items } = await supabase
        .from('project_estimate_items')
        .select('*')
        .in('estimate_id', estIds)
        .order('sort_order', { ascending: true });
      (items || []).forEach(it => {
        if (!estimateItemsByEstId.has(it.estimate_id)) estimateItemsByEstId.set(it.estimate_id, []);
        estimateItemsByEstId.get(it.estimate_id).push(it);
      });
    }

    const costs    = costsRes.data || [];
    const revenues = revenuesRes.data || [];
    const actual_cost    = costs.reduce((s, r) => s + n(r.amount), 0);
    const actual_revenue = revenues.reduce((s, r) => s + n(r.amount), 0);
    const gross_margin   = actual_revenue - actual_cost;

    res.json({
      project: {
        ...project,
        client_name: clientRes.data?.name || null,
      },
      finance_book:  bookRes.data || null,
      input_profile: profileRes.data || null,
      estimates: estimates.map(e => ({
        ...e,
        items: estimateItemsByEstId.get(e.id) || [],
      })),
      cost_entries:    costs,
      revenue_entries: revenues,
      summary: {
        actual_revenue,
        actual_cost,
        gross_margin,
        gross_margin_rate: actual_revenue > 0 ? gross_margin / actual_revenue : null,
        cost_entry_count:    costs.length,
        revenue_entry_count: revenues.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '案件詳細の取得に失敗しました' });
  }
});

// ---------- GET /projects/:id/similar 類似案件比較 ----------
//
// 比較ロジック:
//   1) 対象案件の input_profile.project_type と normalized_metrics を取得
//   2) 同じ project_type の他案件を取得
//   3) 正規化メトリクス（complexity_score, delivery_days, estimated_person_hours, outsource_ratio）の
//      ユークリッド距離で近い順にソート
//   4) 上位 N 件を返す（差分ハイライト用に raw データも同梱）
router.get('/projects/:id/similar', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  const topN = Math.min(parseInt(req.query.limit, 10) || 3, 10);
  if (!projectId) return res.status(400).json({ error: 'project id is required' });

  try {
    const { data: targetProfile } = await supabase
      .from('project_input_profiles')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle();

    if (!targetProfile) {
      return res.json({
        project_id: projectId,
        target_profile: null,
        similar: [],
        note: '類似比較には input_profile（案件タイプ + 正規化メトリクス）の登録が必要です',
      });
    }

    const { data: candidates, error } = await supabase
      .from('project_input_profiles')
      .select('*')
      .eq('project_type', targetProfile.project_type)
      .neq('project_id', projectId);
    if (error) throw new Error(error.message);

    const targetMetrics = targetProfile.normalized_metrics || {};
    const axes = ['complexity_score', 'delivery_days', 'estimated_person_hours', 'outsource_ratio'];

    const distance = (m1, m2) => {
      let sum = 0;
      let used = 0;
      for (const k of axes) {
        const a = Number(m1[k]); const b = Number(m2[k]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          // 0〜100 / 0〜365 / 0〜200 / 0〜1 のスケール差を緩和するための単純正規化
          const scale = (k === 'complexity_score') ? 100
                      : (k === 'delivery_days') ? 365
                      : (k === 'estimated_person_hours') ? 200
                      : 1;
          sum += Math.pow((a - b) / scale, 2);
          used += 1;
        }
      }
      if (used === 0) return Infinity;
      return Math.sqrt(sum / used);
    };

    const ranked = (candidates || [])
      .map(c => ({ profile: c, dist: distance(targetMetrics, c.normalized_metrics || {}) }))
      .filter(r => Number.isFinite(r.dist))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, topN);

    // 各類似案件の名前 / 収支台帳を埋める
    const similarPids = ranked.map(r => r.profile.project_id);
    const [namesRes, booksMap, actualsMap] = await Promise.all([
      similarPids.length
        ? supabase.from('projects').select('id, name, status, client_id').in('id', similarPids)
        : Promise.resolve({ data: [] }),
      fetchFinanceBooksByProjectIds(similarPids),
      aggregateActualsByProject(similarPids),
    ]);
    const nameById = new Map();
    (namesRes.data || []).forEach(p => nameById.set(p.id, p));

    const similar = ranked.map(r => {
      const meta = nameById.get(r.profile.project_id) || {};
      const book = booksMap.get(r.profile.project_id) || {};
      const act  = actualsMap.get(r.profile.project_id) || {};
      const ar = n(act.actual_revenue);
      const ac = n(act.actual_cost);
      return {
        project_id:        r.profile.project_id,
        name:              meta.name || null,
        status:            meta.status || null,
        distance:          Number(r.dist.toFixed(4)),
        project_type:      r.profile.project_type,
        normalized_metrics: r.profile.normalized_metrics,
        input_payload:      r.profile.input_payload,
        contract_total:    n(book.contract_total),
        actual_revenue:    ar,
        actual_cost:       ac,
        gross_margin:      ar - ac,
        gross_margin_rate: ar > 0 ? (ar - ac) / ar : null,
      };
    });

    res.json({
      project_id: projectId,
      target_profile: targetProfile,
      similar,
      axes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '類似案件比較に失敗しました' });
  }
});

// =====================================================================
// 書き込み系（Step B-2）— すべて secretary 以上 + feature flag 有効時のみ
// =====================================================================

// --- 入力サニタイズ -----------------------------------------------------
const allowedBookStatus    = new Set(['open', 'closed']);
const allowedProjectTypes  = new Set(['video', 'hp', 'lp', 'other']);
const allowedEstimateStat  = new Set(['draft', 'sent', 'accepted', 'rejected', 'archived']);
const allowedCostSources   = new Set(['manual']);          // API 経由は manual のみ。invoice_item はトリガ経由
const allowedRevSources    = new Set(['manual']);          // 同上 client_invoice はトリガ経由
const allowedRevenueTypes  = new Set(['deposit', 'final', 'monthly', 'lump_sum', 'other']);

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function intOrZero(v) {
  return intOrNull(v) ?? 0;
}

// --- PUT /projects/:id/finance-book  契約総額・状態の upsert ---------------
router.put('/projects/:id/finance-book', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  if (!projectId) return res.status(400).json({ error: 'project id is required' });

  const body = req.body || {};
  const patch = {};
  if (body.contract_total    !== undefined) patch.contract_total    = intOrZero(body.contract_total);
  if (body.estimated_revenue !== undefined) patch.estimated_revenue = intOrZero(body.estimated_revenue);
  if (body.estimated_cost    !== undefined) patch.estimated_cost    = intOrZero(body.estimated_cost);
  if (body.note              !== undefined) patch.note              = body.note ? String(body.note) : null;
  if (body.status            !== undefined) {
    if (!allowedBookStatus.has(body.status)) {
      return res.status(400).json({ error: `status は ${[...allowedBookStatus].join('/')} のいずれか` });
    }
    patch.status = body.status;
    patch.closed_at = body.status === 'closed' ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: '更新項目がありません' });
  }
  patch.updated_at = new Date().toISOString();

  try {
    const { data: existing } = await supabase
      .from('project_finance_books')
      .select('id')
      .eq('project_id', projectId)
      .maybeSingle();

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('project_finance_books')
        .update(patch)
        .eq('project_id', projectId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('project_finance_books')
        .insert({ project_id: projectId, ...patch })
        .select()
        .single();
      if (error) throw new Error(error.message);
      saved = data;
    }
    res.json({ finance_book: saved });
  } catch (e) {
    res.status(500).json({ error: e.message || '保存に失敗しました' });
  }
});

// --- PUT /projects/:id/input-profile  案件タイプ別入力 + メトリクス upsert ----
router.put('/projects/:id/input-profile', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  if (!projectId) return res.status(400).json({ error: 'project id is required' });

  const body = req.body || {};
  const patch = {};
  if (body.project_type !== undefined) {
    if (!allowedProjectTypes.has(body.project_type)) {
      return res.status(400).json({ error: `project_type は ${[...allowedProjectTypes].join('/')} のいずれか` });
    }
    patch.project_type = body.project_type;
  }
  if (body.input_payload !== undefined) {
    if (typeof body.input_payload !== 'object' || Array.isArray(body.input_payload)) {
      return res.status(400).json({ error: 'input_payload は object である必要があります' });
    }
    patch.input_payload = body.input_payload;
  }
  if (body.normalized_metrics !== undefined) {
    if (typeof body.normalized_metrics !== 'object' || Array.isArray(body.normalized_metrics)) {
      return res.status(400).json({ error: 'normalized_metrics は object である必要があります' });
    }
    patch.normalized_metrics = body.normalized_metrics;
  }
  if (body.raw_request_text !== undefined) {
    patch.raw_request_text = body.raw_request_text ? String(body.raw_request_text) : null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: '更新項目がありません' });
  patch.updated_at = new Date().toISOString();

  try {
    const { data: existing } = await supabase
      .from('project_input_profiles')
      .select('id')
      .eq('project_id', projectId)
      .maybeSingle();
    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('project_input_profiles')
        .update(patch).eq('project_id', projectId).select().single();
      if (error) throw new Error(error.message);
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('project_input_profiles')
        .insert({ project_id: projectId, project_type: patch.project_type || 'other', ...patch })
        .select().single();
      if (error) throw new Error(error.message);
      saved = data;
    }
    res.json({ input_profile: saved });
  } catch (e) {
    res.status(500).json({ error: e.message || '保存に失敗しました' });
  }
});

// --- POST /projects/:id/estimates  見積を新規作成（明細同梱） ----------------
router.post('/projects/:id/estimates', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  if (!projectId) return res.status(400).json({ error: 'project id is required' });

  const body  = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (body.status && !allowedEstimateStat.has(body.status)) {
    return res.status(400).json({ error: `status は ${[...allowedEstimateStat].join('/')} のいずれか` });
  }

  try {
    // 次バージョン番号
    const { data: maxRow } = await supabase
      .from('project_estimates')
      .select('version')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1).maybeSingle();
    const nextVersion = (maxRow?.version || 0) + 1;

    // items の合計を計算（body.total_amount が無ければ自動計算）
    const computedTotal = items.reduce((s, it) => s + intOrZero(it.amount), 0);
    const totalAmount = body.total_amount !== undefined ? intOrZero(body.total_amount) : computedTotal;

    const { data: est, error: estErr } = await supabase
      .from('project_estimates')
      .insert({
        project_id: projectId,
        version:    nextVersion,
        title:      body.title || null,
        total_amount: totalAmount,
        status:     body.status || 'draft',
        created_by: req.user?.id || null,
        note:       body.note || null,
      })
      .select().single();
    if (estErr) throw new Error(estErr.message);

    let savedItems = [];
    if (items.length) {
      const rows = items.map((it, idx) => ({
        estimate_id: est.id,
        category:    it.category || null,
        label:       String(it.label || '(無題)'),
        quantity:    Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1,
        unit:        it.unit || null,
        unit_price:  intOrZero(it.unit_price),
        amount:      intOrZero(it.amount),
        sort_order:  Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : idx,
        note:        it.note || null,
      }));
      const { data: itemsRes, error: itErr } = await supabase
        .from('project_estimate_items').insert(rows).select();
      if (itErr) throw new Error(itErr.message);
      savedItems = itemsRes || [];
    }

    res.status(201).json({ estimate: { ...est, items: savedItems } });
  } catch (e) {
    res.status(500).json({ error: e.message || '見積の作成に失敗しました' });
  }
});

// --- PUT /estimates/:eid  見積メタの更新（明細は別 PR） ---------------------
router.put('/estimates/:eid', requireAuth, requireAdmin, async (req, res) => {
  const eid = req.params.eid;
  if (!eid) return res.status(400).json({ error: 'estimate id is required' });
  const body = req.body || {};
  const patch = {};
  if (body.title  !== undefined) patch.title  = body.title ? String(body.title) : null;
  if (body.note   !== undefined) patch.note   = body.note ? String(body.note) : null;
  if (body.total_amount !== undefined) patch.total_amount = intOrZero(body.total_amount);
  if (body.status !== undefined) {
    if (!allowedEstimateStat.has(body.status)) {
      return res.status(400).json({ error: `status は ${[...allowedEstimateStat].join('/')} のいずれか` });
    }
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: '更新項目がありません' });
  patch.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('project_estimates').update(patch).eq('id', eid).select().single();
    if (error) throw new Error(error.message);
    res.json({ estimate: data });
  } catch (e) {
    res.status(500).json({ error: e.message || '見積の更新に失敗しました' });
  }
});

// --- DELETE /estimates/:eid  見積削除（明細は CASCADE で消える） --------------
router.delete('/estimates/:eid', requireAuth, requireAdmin, async (req, res) => {
  const eid = req.params.eid;
  if (!eid) return res.status(400).json({ error: 'estimate id is required' });
  try {
    const { error } = await supabase.from('project_estimates').delete().eq('id', eid);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '見積の削除に失敗しました' });
  }
});

// --- POST /projects/:id/cost-entries  手動の原価エントリ追加 ----------------
//   トリガ経由（source='invoice_item'）の自動連携と区別するため、API は manual のみ
router.post('/projects/:id/cost-entries', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  const body = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'project id is required' });
  if (body.amount === undefined) return res.status(400).json({ error: 'amount は必須' });

  try {
    const { data, error } = await supabase
      .from('project_cost_entries')
      .insert({
        project_id:  projectId,
        source:      'manual',
        cost_type:   body.cost_type || null,
        label:       body.label ? String(body.label) : null,
        amount:      intOrZero(body.amount),
        occurred_on: body.occurred_on || null,
        user_id:     body.user_id || null,
        note:        body.note || null,
      })
      .select().single();
    if (error) throw new Error(error.message);
    res.status(201).json({ cost_entry: data });
  } catch (e) {
    res.status(500).json({ error: e.message || '原価エントリ追加に失敗しました' });
  }
});

// --- DELETE /cost-entries/:cid  手動エントリのみ削除可（自動連携は触らない） ---
router.delete('/cost-entries/:cid', requireAuth, requireAdmin, async (req, res) => {
  const cid = req.params.cid;
  if (!cid) return res.status(400).json({ error: 'cost entry id is required' });
  try {
    const { data: existing, error: gErr } = await supabase
      .from('project_cost_entries').select('source').eq('id', cid).maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!existing) return res.status(404).json({ error: 'cost entry not found' });
    if (!allowedCostSources.has(existing.source)) {
      return res.status(409).json({
        error: `source=${existing.source} のエントリは API 経由で削除できません（請求書側で操作してください）`,
      });
    }
    const { error } = await supabase.from('project_cost_entries').delete().eq('id', cid);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '原価エントリ削除に失敗しました' });
  }
});

// --- POST /projects/:id/revenue-entries  手動の売上エントリ追加（手付金等） --
router.post('/projects/:id/revenue-entries', requireAuth, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  const body = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'project id is required' });
  if (body.amount === undefined) return res.status(400).json({ error: 'amount は必須' });
  if (body.revenue_type && !allowedRevenueTypes.has(body.revenue_type)) {
    return res.status(400).json({ error: `revenue_type は ${[...allowedRevenueTypes].join('/')} のいずれか` });
  }

  try {
    const { data, error } = await supabase
      .from('project_revenue_entries')
      .insert({
        project_id:    projectId,
        source:        'manual',
        revenue_type:  body.revenue_type || 'other',
        label:         body.label ? String(body.label) : null,
        amount:        intOrZero(body.amount),
        occurred_on:   body.occurred_on || null,
        client_id:     body.client_id || null,
        note:          body.note || null,
      })
      .select().single();
    if (error) throw new Error(error.message);
    res.status(201).json({ revenue_entry: data });
  } catch (e) {
    res.status(500).json({ error: e.message || '売上エントリ追加に失敗しました' });
  }
});

// --- DELETE /revenue-entries/:rid  手動エントリのみ削除可 --------------------
router.delete('/revenue-entries/:rid', requireAuth, requireAdmin, async (req, res) => {
  const rid = req.params.rid;
  if (!rid) return res.status(400).json({ error: 'revenue entry id is required' });
  try {
    const { data: existing, error: gErr } = await supabase
      .from('project_revenue_entries').select('source').eq('id', rid).maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!existing) return res.status(404).json({ error: 'revenue entry not found' });
    if (!allowedRevSources.has(existing.source)) {
      return res.status(409).json({
        error: `source=${existing.source} のエントリは API 経由で削除できません（クライアント請求書側で操作してください）`,
      });
    }
    const { error } = await supabase.from('project_revenue_entries').delete().eq('id', rid);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '売上エントリ削除に失敗しました' });
  }
});

module.exports = router;

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
//   - 全エンドポイント analytics.view 権限が必要（admin / secretary のみ）
//
// 提供API（全て読み取り専用）:
//   - GET /projects             案件収支一覧
//   - GET /projects/:id         案件詳細（finance_book / estimates / cost_entries / revenue_entries / input_profile）
//   - GET /projects/:id/similar 類似案件比較（同 project_type + 正規化メトリクス近傍）

const express = require('express');
const router  = express.Router();
const supabase = require('../supabase');
const { requireAuth, requirePermission } = require('../auth');

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
router.get('/projects', requireAuth, requirePermission('analytics.view'), async (req, res) => {
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
router.get('/projects/:id', requireAuth, requirePermission('analytics.view'), async (req, res) => {
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
router.get('/projects/:id/similar', requireAuth, requirePermission('analytics.view'), async (req, res) => {
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

module.exports = router;

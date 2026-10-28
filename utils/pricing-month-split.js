'use strict';
// ===== 単価の変更は「今月の納品分から」（ADR 037 追補 2026-10-28 その3） =====
// 単価は納品月の月末時点で解決する（ADR 030）が、同じグループの単価を書き換えると、まだ請求書を
// 出していない先月以前の納品分まで新単価になってしまう。そこで単価に効く書き込みの直前に、
// 先月以前の納品があるグループを「先月末で停止した旧グループ」と「今月1日から適用する新グループ」に
// 分け、書き込みは新グループへ向ける。先月以前の納品分は旧グループに残るので旧単価のまま。
// 分けないもの:
//   - 先月以前に納品したクリエイティブが無い（今月分しか無い＝そのまま書き換えてよい）
//   - 停止中のグループ（過去月の単価の訂正として、そのまま直す）
//   - 今月から適用のグループ・単価がまだ何も入っていないグループ（¥0 の入れ忘れは遡って直す）
//   - 月額定額・分割支払のあるグループ（金額は各月の行が持つ・ADR 029 / 053）
//   - 一式（fixed_total）・時給（hourly）の単価行を持つグループ（予定本数で按分するので分けると金額が変わる）
// 安全側に倒す（PR #1269 の指摘対応）:
//   - 旧グループの停止を最初に「条件付き更新（applies_to IS NULL のときだけ）」で行い、取れなければ 409。
//     同時保存で二重に分けたり、分けた後の旧グループへ書いたりしない。
//   - 新グループは旧グループの承認状態をそのまま引き継いで作る（承認待ちの値が承認済みに化けない）。
//   - 途中で失敗したら元に戻して error を返す。呼び出し側は保存を止める（旧グループへ書き続けない）。
//   - 書き込み自体が失敗したら、呼び出し側が undoMonthlySplit で元に戻す。
//   - 予定本数は旧（先月以前の納品数）と新（残り）で分け合う（売上見込みの二重計上防止）。
// 戻り値: { lineId: 書き込み先, split: null | { from_line_id, to_line_id, applies_from }, costIdMap, error?: { status, message } }
//   costIdMap: Map<旧 line_cost id, 新 line_cost id>（PUT/DELETE /costs/:cost_id の付け替え用）
//
// DB（supabase）や周辺の関数は routes/haruka.js から渡す（jest で偽の DB を差し込んでテストするため）。

const { jstMonthBoundary } = require('./pricing');

const PRICING_SPLIT_FAILED_MESSAGE = '単価を月ごとに分ける処理に失敗したため保存を中止しました。先月以前に納品した分の単価は変わっていません。時間をおいてもう一度保存してください';

function createMonthlyPricingSplitter({
  supabase,
  todayStrJST,
  buildLinePricingSnapshot,
  isMissingAppliesColumn,
  isMissingPricingApprovalColumn,
  isMissingLpiTable,
  monthlyFeeLinePrefix,
  notifyAutoError,
}) {
  const MONTHLY_FEE_LINE_PREFIX = monthlyFeeLinePrefix;

  async function splitLineForMonthlyPricing(req, lineId) {
    const noSplit = { lineId, split: null, costIdMap: new Map() };
    const fail = (status, message) => ({ ...noSplit, error: { status, message } });
    const { data: line, error } = await supabase
      .from('project_estimate_lines')
      .select('id, project_id, category_id, rank, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, applies_from, applies_to, pricing_approval, pricing_prev_snapshot, pricing_requested_by, pricing_requested_at')
      .eq('id', lineId)
      .maybeSingle();
    if (error) {
      // 列が未適用の環境（applies / pricing_*）では分割の仕組み自体が使えないので従来どおり
      if (isMissingAppliesColumn(error) || isMissingPricingApprovalColumn(error)) return noSplit;
      console.warn('[pricing-split] line read failed:', error.message);
      return fail(500, PRICING_SPLIT_FAILED_MESSAGE);
    }
    if (!line) return noSplit;
    if (line.applies_to) {
      // 画面では現役だと思って編集したのに、その間に別の保存で月の境目で分かれて停止されていた
      // （?expect_active=1）→ 先月分の単価を書き換えないよう止める。停止中と分かって直すのは過去月の訂正なので通す
      if (String(req.query?.expect_active || '') === '1') {
        return fail(409, 'この成果物グループは月の境目で分かれて停止されました（先月までの納品分の単価です）。画面を開き直して、今月からのグループを編集してください');
      }
      return noSplit;
    }
    if (String(line.name || '').startsWith(MONTHLY_FEE_LINE_PREFIX)) return noSplit;
    const { monthStart, prevMonthEnd, monthStartIso } = jstMonthBoundary(todayStrJST());
    if (line.applies_from && line.applies_from >= monthStart) return noSplit;

    const { data: costs, error: costErr } = await supabase
      .from('project_estimate_line_costs')
      .select('id, role_id, user_id, unit_price, currency, pricing_type, percentage, actual_hours')
      .eq('line_id', lineId);
    if (costErr) { console.warn('[pricing-split] costs read failed:', costErr.message); return fail(500, PRICING_SPLIT_FAILED_MESSAGE); }
    if ((costs || []).some(c => ['fixed_total', 'hourly'].includes(c.pricing_type))) return noSplit;
    const hasPrice = (Number(line.client_unit_price) || 0) > 0
      || (costs || []).some(c => (Number(c.unit_price) || 0) > 0 || (Number(c.percentage) || 0) > 0);
    if (!hasPrice) return noSplit;

    const { count: pastCount, error: pastErr } = await supabase
      .from('creatives').select('id', { count: 'exact', head: true })
      .eq('line_id', lineId).lt('delivered_at', monthStartIso);
    if (pastErr) { console.warn('[pricing-split] creatives count failed:', pastErr.message); return fail(500, PRICING_SPLIT_FAILED_MESSAGE); }
    if (!pastCount) return noSplit;

    const { count: instCount, error: instErr } = await supabase
      .from('line_payment_installments').select('id', { count: 'exact', head: true }).eq('line_id', lineId);
    if (instErr && !isMissingLpiTable(instErr)) { console.warn('[pricing-split] installments count failed:', instErr.message); return fail(500, PRICING_SPLIT_FAILED_MESSAGE); }
    if (instCount) return noSplit;

    // 1) 旧グループを先に止めて確保する（applies_to IS NULL のときだけ）。取れなければ同時保存
    const origPlanned = Math.max(0, parseInt(line.planned_count, 10) || 0);
    const oldPlanned = Math.min(origPlanned, pastCount);
    const { data: claimed, error: claimErr } = await supabase
      .from('project_estimate_lines')
      .update({ applies_to: prevMonthEnd, planned_count: oldPlanned })
      .eq('id', lineId).is('applies_to', null)
      .select('id');
    if (claimErr) { console.warn('[pricing-split] old line claim failed:', claimErr.message); return fail(500, PRICING_SPLIT_FAILED_MESSAGE); }
    if (!claimed || !claimed.length) {
      return fail(409, '同じ成果物グループを別の人が同時に保存しました。画面を開き直してから、もう一度保存してください');
    }
    const reopenOld = () => supabase.from('project_estimate_lines')
      .update({ applies_to: null, planned_count: origPlanned }).eq('id', lineId);

    // 2) 新グループ（今月1日から）。承認状態は旧グループを引き継ぐ（承認待ちの値を承認済みにしない）
    const splitSnapBase = (line.pricing_approval === 'pending' && line.pricing_prev_snapshot && typeof line.pricing_prev_snapshot === 'object')
      ? line.pricing_prev_snapshot : null;
    const insertRow = {
      project_id: line.project_id,
      category_id: line.category_id || null,
      rank: line.rank || null,
      name: line.name || null,
      planned_count: Math.max(0, origPlanned - oldPlanned),
      client_unit_price: Number(line.client_unit_price) || 0,
      sort_order: line.sort_order ?? null,
      currency: line.currency || 'JPY',
      tax_included: line.tax_included === false ? false : true,
      status: line.status || 'contracted',
      status_changed_at: new Date().toISOString(),
      applies_from: monthStart,
    };
    if (line.pricing_approval === 'pending') {
      const { split_from_line_id: _f, split_applies_from: _a, ...rest } = splitSnapBase || {};
      Object.assign(insertRow, {
        pricing_approval: 'pending',
        pricing_requested_by: line.pricing_requested_by || null,
        pricing_requested_at: line.pricing_requested_at || new Date().toISOString(),
        // 旧グループが一度も承認されていない新規グループ（スナップショット無し）でも、差し戻しで 1 グループへ戻せるよう分け元を持つ
        pricing_prev_snapshot: { ...(splitSnapBase ? rest : { client_unit_price: 0, costs: [] }), split_from_line_id: lineId, split_applies_from: monthStart },
      });
    }
    const { data: inserted, error: insErr } = await supabase
      .from('project_estimate_lines').insert(insertRow).select('id').single();
    if (insErr) {
      console.warn('[pricing-split] new line insert failed:', insErr.message);
      await reopenOld();
      return fail(500, PRICING_SPLIT_FAILED_MESSAGE);
    }
    const newLineId = inserted.id;
    const rollback = async () => {
      await supabase.from('creatives').update({ line_id: lineId }).eq('line_id', newLineId);
      await supabase.from('project_estimate_lines').delete().eq('id', newLineId);
      await reopenOld();
    };

    // 3) 単価行を写す
    const costIdMap = new Map();
    if ((costs || []).length) {
      const { data: newCosts, error: copyErr } = await supabase
        .from('project_estimate_line_costs')
        .insert(costs.map(c => ({
          line_id: newLineId,
          role_id: c.role_id,
          user_id: c.user_id ?? null,
          unit_price: c.unit_price,
          currency: c.currency || 'JPY',
          pricing_type: c.pricing_type || 'fixed_per_unit',
          percentage: c.percentage ?? null,
          actual_hours: c.actual_hours ?? null,
        })))
        .select('id, role_id, user_id');
      if (copyErr || (newCosts || []).length !== costs.length) {
        console.warn('[pricing-split] costs copy failed:', copyErr?.message || 'count mismatch');
        await rollback();
        return fail(500, PRICING_SPLIT_FAILED_MESSAGE);
      }
      // UNIQUE (line_id, role_id, user_id) なので (role_id, user_id) で 1 対 1 に対応する
      const keyOf = (c) => `${c.role_id}|${c.user_id || ''}`;
      const newByKey = new Map(newCosts.map(c => [keyOf(c), c.id]));
      for (const c of costs) if (newByKey.has(keyOf(c))) costIdMap.set(c.id, newByKey.get(keyOf(c)));
    }

    // 4) 今月の納品分・未納品は新グループへ。先月以前の納品分は旧グループに残す
    const { error: moveErr } = await supabase
      .from('creatives')
      .update({ line_id: newLineId })
      .eq('line_id', lineId)
      .or(`delivered_at.is.null,delivered_at.gte.${monthStartIso}`);
    if (moveErr) {
      console.warn('[pricing-split] creatives move failed:', moveErr.message);
      await rollback();
      return fail(500, PRICING_SPLIT_FAILED_MESSAGE);
    }

    // 並び順: 新グループを旧グループの直前に置く（今の単価が上に来る）。失敗しても金額には影響しない
    try {
      const { data: allLines } = await supabase
        .from('project_estimate_lines').select('id')
        .eq('project_id', line.project_id)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (Array.isArray(allLines)) {
        const ids = allLines.map(l => l.id).filter(id => id !== newLineId);
        const idx = ids.indexOf(lineId);
        ids.splice(idx >= 0 ? idx : ids.length, 0, newLineId);
        await Promise.all(ids.map((id, i) =>
          supabase.from('project_estimate_lines').update({ sort_order: (i + 1) * 10 }).eq('id', id)));
      }
    } catch (e) { console.warn('[pricing-split] reorder failed:', e?.message); }

    // 承認権限のない人の書き込みで承認待ちにするときのスナップショット（差し戻し＝分ける前の 1 グループへ戻す）。
    // 旧グループが承認待ちなら新グループは作成時点で承認待ち（上で設定済み）。
    if (line.pricing_approval !== 'pending') {
      const baseSnap = await buildLinePricingSnapshot(newLineId);
      if (!(req._pricingSplitSnapshots instanceof Map)) req._pricingSplitSnapshots = new Map();
      req._pricingSplitSnapshots.set(newLineId, { ...baseSnap, split_from_line_id: lineId, split_applies_from: monthStart });
    }

    console.log(`[pricing-split] line ${lineId} → ${newLineId}（${monthStart} から・先月以前の納品 ${pastCount} 件は旧単価のまま）`);
    return { lineId: newLineId, split: { from_line_id: lineId, to_line_id: newLineId, applies_from: monthStart }, costIdMap };
  }

  // 分割した後の書き込みが失敗したときに、分ける前の 1 グループへ戻す（保存失敗で状態を残さない）
  async function undoMonthlySplit(split) {
    if (!split) return;
    try {
      const { data: newLine } = await supabase.from('project_estimate_lines')
        .select('planned_count').eq('id', split.to_line_id).maybeSingle();
      const { data: oldLine } = await supabase.from('project_estimate_lines')
        .select('planned_count').eq('id', split.from_line_id).maybeSingle();
      await supabase.from('creatives').update({ line_id: split.from_line_id }).eq('line_id', split.to_line_id);
      const { error: delErr } = await supabase.from('project_estimate_lines').delete().eq('id', split.to_line_id);
      if (delErr) throw new Error(delErr.message);
      await supabase.from('project_estimate_lines')
        .update({ applies_to: null, planned_count: (Number(oldLine?.planned_count) || 0) + (Number(newLine?.planned_count) || 0) })
        .eq('id', split.from_line_id);
    } catch (e) {
      console.error('[pricing-split] undo failed:', e?.message, split);
      Promise.resolve(notifyAutoError && notifyAutoError({
        source: 'server', kind: 'pricing-split-undo',
        message: `単価の月またぎ分割の取り消しに失敗（手で 1 グループへ戻す必要あり）: ${e?.message} ${JSON.stringify(split)}`,
      })).catch(() => {});
    }
  }

  return { splitLineForMonthlyPricing, undoMonthlySplit };
}

module.exports = { createMonthlyPricingSplitter, PRICING_SPLIT_FAILED_MESSAGE };

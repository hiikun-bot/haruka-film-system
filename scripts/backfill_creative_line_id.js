#!/usr/bin/env node
// scripts/backfill_creative_line_id.js
//
// 役割:
//   creatives.line_id（どの成果物グループの単価で払うか）を埋め直す。
//   line_id を書き込む経路がアプリに無かったため、2026-05-06 の移行 SQL で
//   バックフィルした分にしか値が入っておらず、それ以降の登録分は全件 NULL。
//   ADR 031 で集計側はフォールバック解決するようになったが、データとしても
//   正しい紐付けを持たせる（紐付けの誤りを画面で追えるようにする）。
//
// 解決ルール（routes/haruka.js の pickLineIdForCreative と完全に同一。実装を共有する）:
//   - 制作担当（editor/designer/director_as_editor）の rank_applied 一致を最優先
//   - ランク一致が無ければ、単価行を持つ候補が 1 つに絞れるときだけ採用
//   - 曖昧（複数候補）なら埋めない。誤った line_id は ADR 030 の単価解決を誤らせるため
//   - 停止済み（applies_to が過去）・cancelled/rejected の line は対象外
//
// 実行方法:
//   node scripts/backfill_creative_line_id.js --dry-run     # 変更内容だけ表示（推奨: まずこれ）
//   node scripts/backfill_creative_line_id.js               # 実際に UPDATE
//
//   オプション:
//     --dry-run       UPDATE せず、埋まる件数と単価の変化だけ表示
//     --limit=N       先頭 N 件だけ処理（テスト用）
//     --all           既に line_id が入っているものも対象にする（既定は NULL のみ）
//     --project=UUID  特定案件だけ処理
//
// 冪等: 同じ line_id なら UPDATE しない。何度実行しても安全。
//
// 環境変数: .env の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY

require('dotenv').config();
const supabase = require('../supabase');
const { loadProjectLinePricing, pickLineIdForCreative } = require('../routes/haruka');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INCLUDE_LINKED = args.includes('--all');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;
const PROJECT_ARG = args.find(a => a.startsWith('--project='));
const PROJECT_ID = PROJECT_ARG ? PROJECT_ARG.split('=')[1] : null;

const CREATOR_ROLES = ['editor', 'designer', 'director_as_editor'];

// 制作担当ロールの単価行から「この 1 本の支払単価」を取り出す（変化の可視化用。金額計算の正は集計側）
function creatorUnitPrice(lineId, costsByLine) {
  const costs = costsByLine.get(lineId) || [];
  const lc = costs.find(c => CREATOR_ROLES.includes(c.role?.code));
  if (!lc) return null;
  if ((lc.pricing_type || 'fixed_per_unit') !== 'fixed_per_unit') return null;
  return Number(lc.unit_price) || 0;
}

async function main() {
  console.log('[backfill] creatives.line_id バックフィル開始');
  console.log('[backfill] DRY_RUN =', DRY_RUN, '/ 対象 =', INCLUDE_LINKED ? '全件' : 'line_id が NULL のみ',
    '/ LIMIT =', LIMIT || '(なし)', '/ PROJECT =', PROJECT_ID || '(全案件)');

  let q = supabase
    .from('creatives')
    .select('id, file_name, project_id, line_id, category_id, creative_type, status, projects(name), creative_assignments(role, rank_applied)')
    .order('created_at', { ascending: true });
  if (!INCLUDE_LINKED) q = q.is('line_id', null);
  if (PROJECT_ID) q = q.eq('project_id', PROJECT_ID);
  if (LIMIT) q = q.limit(LIMIT);

  const { data: creatives, error } = await q;
  if (error) { console.error('[backfill] creatives 取得失敗:', error.message); process.exit(1); }
  console.log(`[backfill] 対象クリエイティブ: ${creatives.length} 件`);
  if (!creatives.length) return;

  const projectIds = Array.from(new Set(creatives.map(c => c.project_id).filter(Boolean)));
  const ctx = await loadProjectLinePricing(projectIds, 'backfill_creative_line_id');
  console.log(`[backfill] 案件数 ${projectIds.length} / line 数 ${[...ctx.linesByProject.values()].reduce((n, a) => n + a.length, 0)}`);

  let filled = 0, unchanged = 0, ambiguous = 0, priceChanged = 0, failed = 0;
  for (const c of creatives) {
    const newLineId = pickLineIdForCreative(c, ctx);
    if (!newLineId) { ambiguous++; continue; }
    if (newLineId === c.line_id) { unchanged++; continue; }

    const before = c.line_id ? creatorUnitPrice(c.line_id, ctx.costsByLine) : null;
    const after  = creatorUnitPrice(newLineId, ctx.costsByLine);
    const line   = (ctx.linesByProject.get(c.project_id) || []).find(l => l.id === newLineId);
    const rank   = (c.creative_assignments || []).find(a => CREATOR_ROLES.includes(a.role))?.rank_applied || '-';
    if (before !== null && before !== after) priceChanged++;

    console.log(
      `  ${DRY_RUN ? '[dry]' : '[set]'} ${(c.file_name || '').slice(0, 40).padEnd(40)}`,
      `| ${(c.projects?.name || '').slice(0, 18).padEnd(18)}`,
      `| rank=${rank}`,
      `| → ${(line?.name || `${line?.rank}ランク`)}(${line?.status})`,
      `| 単価 ${before === null ? '（未設定）' : `¥${before}`} → ${after === null ? '（単価行なし）' : `¥${after}`}`,
    );

    if (!DRY_RUN) {
      const { error: upErr } = await supabase.from('creatives').update({ line_id: newLineId }).eq('id', c.id);
      if (upErr) { console.warn(`  [warn] id=${c.id} UPDATE 失敗:`, upErr.message); failed++; continue; }
    }
    filled++;
  }

  console.log('[backfill] 完了');
  console.log(`  紐付け${DRY_RUN ? '予定' : '実施'}: ${filled} 件`);
  console.log(`  変更なし（既に同じ line）: ${unchanged} 件`);
  console.log(`  解決できず（候補が複数 / 単価行なし）: ${ambiguous} 件`);
  if (priceChanged) console.log(`  ⚠ 既存の紐付けから支払単価が変わるもの: ${priceChanged} 件（上の一覧で要確認）`);
  if (failed) console.log(`  UPDATE 失敗: ${failed} 件`);
}

main().catch(e => {
  console.error('[backfill] 予期せぬエラー:', e.stack || e.message);
  process.exit(1);
});

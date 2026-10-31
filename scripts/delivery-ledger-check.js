#!/usr/bin/env node
// scripts/delivery-ledger-check.js
//
// 役割（ADR 055）:
//   納品完了メッセージ（Slack / Chatwork）に積み上げた「当月の案件内 納品カウント」と、
//   HFS 本番 DB（creatives.delivered_at の JST 月）をダブルチェックする。
//
//   1) DB 側: 指定の案件・月の納品済み一覧と件数を出す（[HFS-LEDGER] タグも再生成）
//   2) ログ側（任意）: Slack / Chatwork のやり取りを貼り付けたテキストファイルから
//      [HFS-LEDGER] タグを全部拾い、案件×月ごとの「最後に投稿された month_total」と
//      タグに出てきた creative の集合を DB と突き合わせる
//
// 実行方法:
//   node scripts/delivery-ledger-check.js --project <案件UUID> --month 2026-10
//   node scripts/delivery-ledger-check.js --log ./chat.txt                 # ログ内の全案件×月を DB と突合
//   node scripts/delivery-ledger-check.js --log ./chat.txt --month 2026-10 # 月で絞る
//   node scripts/delivery-ledger-check.js --project <UUID> --month 2026-10 --json  # JSON 出力
//   node scripts/delivery-ledger-check.js --fetch --month 2026-10 [--project <UUID>] [--json]
//       ← 全自動版（ADR 055 追補）。HFS が案件の Slack / Chatwork を自分で読んで DB と突合する
//          （本番と同じ utils/delivery-ledger-recon.js。.env の CHATWORK_API_TOKEN と slack_workspaces の bot_token を使う）
//
// 環境変数:
//   .env から SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を読む（既存の supabase.js と同じ仕組み）。読み取りのみ。

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const PROJECT = opt('project');
const MONTH = opt('month');
const LOG = opt('log');
const AS_JSON = args.includes('--json');

const FETCH = args.includes('--fetch');

const L = require('../utils/delivery-ledger');

// 全自動版: チャンネルの読み取りも HFS 側で行う（ADR 055 追補）
async function mainFetch() {
  const supabase = require('../supabase');
  const notifications = require('../notifications');
  const R = require('../utils/delivery-ledger-recon');
  const ym = MONTH || L.jstYearMonthOf(new Date().toISOString());
  const result = await R.reconMonth({ supabase, notifications }, { ym, projectIds: PROJECT ? [PROJECT] : null });
  if (AS_JSON) { console.log(JSON.stringify(result, null, 2)); return; }
  for (const r of result.results) {
    const label = `${r.client_name ? `【${r.client_name}】` : ''}${r.project_name}`;
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`${label}  ${L.monthLabelOf(r.month)}  （project=${r.project_id}）`);
    console.log(`DB      : 当月 ${r.db ? r.db.month_total : '-'}件 ／ 案件累計 ${r.db ? r.db.project_total : '-'}件`);
    for (const pf of ['slack', 'chatwork']) {
      const x = r[pf];
      if (!x) { console.log(`${pf.padEnd(8)}: （通知先なし）`); continue; }
      console.log(`${pf.padEnd(8)}: ${R.VERDICT_LABEL[x.verdict]} タグ ${x.tag_count}件 ／ 最後の month_total=${x.last_month_total ?? '-'}${x.reason ? ` ／ ${x.reason}` : ''}`);
      if (x.only_in_log.length) console.log(`           ⚠️ 投稿にあるが DB に無い: ${x.only_in_log.join(', ')}`);
      if (x.unmentioned_in_db.length) console.log(`           ⚠️ DB にあるが投稿に出てこない: ${x.unmentioned_in_db.join(', ')}`);
      if (x.missing_posts.length) console.log(`           ⚠️ 投稿記録があるのにチャンネルに無い: ${x.missing_posts.join(', ')}`);
    }
    console.log(`判定    : ${R.VERDICT_LABEL[r.verdict] || r.verdict}`);
  }
  const s = result.summary;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`合計 ${s.total}案件 ／ ✅${s.match} ❌${s.mismatch} ⚠️投稿なし${s.no_posts} 🚫取得不可${s.fetch_error} ➖通知先なし${s.no_channel}`);
}

async function main() {
  if (FETCH) return mainFetch();
  if (!PROJECT && !LOG) {
    console.error('使い方: --fetch --month YYYY-MM ／ --project <UUID> --month YYYY-MM ／ --log <chat.txt> [--month YYYY-MM]');
    process.exit(2);
  }
  const supabase = require('../supabase');
  const nowYm = L.jstYearMonthOf(new Date().toISOString());

  // 突合対象（案件×月）の集合を決める
  const targets = new Map(); // key `${project}|${ym}` → { project, ym, tags: [] }
  if (LOG) {
    const text = fs.readFileSync(path.resolve(LOG), 'utf-8');
    const tags = L.parseLedgerTags(text);
    if (tags.length === 0) console.warn('[check] ログに [HFS-LEDGER] タグが見つかりませんでした');
    for (const t of tags) {
      if (MONTH && t.month !== MONTH) continue;
      if (PROJECT && t.project !== PROJECT) continue;
      const key = `${t.project}|${t.month}`;
      if (!targets.has(key)) targets.set(key, { project: t.project, ym: t.month, tags: [] });
      targets.get(key).tags.push(t);
    }
  }
  if (PROJECT && targets.size === 0) {
    const ym = MONTH || nowYm;
    targets.set(`${PROJECT}|${ym}`, { project: PROJECT, ym, tags: [] });
  }

  const report = [];
  for (const { project, ym, tags } of targets.values()) {
    const { data: proj } = await supabase.from('projects').select('id, name, clients(name)').eq('id', project).maybeSingle();
    const ledger = await L.loadProjectDeliveryLedger(supabase, { projectId: project, ym });
    const block = L.buildDeliveryLedgerBlock({ ledger, projectId: project, currentIds: [] });

    // ログ側のまとめ: 最後（最大）の month_total と、タグに出てきた creative 集合
    const logMax = tags.reduce((m, t) => Math.max(m, Number.isFinite(t.month_total) ? t.month_total : -1), -1);
    const logCreatives = new Set(tags.map(t => t.creative).filter(Boolean));
    const dbCreatives = new Set(ledger.items.map(it => it.id));
    const onlyInLog = [...logCreatives].filter(id => !dbCreatives.has(id));
    const onlyInDb = ledger.items.filter(it => !logCreatives.has(it.id)).map(it => it.id);

    const verdict = tags.length === 0
      ? 'DB_ONLY'
      : (logMax === ledger.monthTotal && onlyInLog.length === 0 ? 'MATCH' : 'MISMATCH');

    report.push({
      project_id: project,
      project_name: proj?.name || '(案件不明)',
      client_name: proj?.clients?.name || null,
      month: ym,
      db: { month_total: ledger.monthTotal, project_total: ledger.projectTotal, items: ledger.items, tag: block.tag },
      log: { tag_count: tags.length, last_month_total: logMax >= 0 ? logMax : null, creatives: [...logCreatives] },
      diff: { only_in_log: onlyInLog, only_in_db_unmentioned: onlyInDb },
      verdict,
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const r of report) {
    const label = `${r.client_name ? `【${r.client_name}】` : ''}${r.project_name}`;
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`${label}  ${L.monthLabelOf(r.month)}  （project=${r.project_id}）`);
    console.log(`DB   : 当月 ${r.db.month_total}件 ／ 案件累計 ${r.db.project_total}件`);
    for (const it of r.db.items) {
      const mark = r.log.tag_count > 0 && !r.log.creatives.includes(it.id) ? '   ※ログのタグに未登場（一括納品分か、投稿失敗の可能性）' : '';
      console.log(`  ${String(it.seq).padStart(2, ' ')}. ${L.jstMonthDayOf(it.delivered_at)}  ${it.file_name}  (${it.id})${mark}`);
    }
    console.log(`  ${r.db.tag}`);
    if (r.log.tag_count > 0) {
      console.log(`ログ : タグ ${r.log.tag_count}件 ／ 最後の month_total=${r.log.last_month_total}`);
      if (r.diff.only_in_log.length) console.log(`  ⚠️ ログにあるが DB の当月納品に無い creative: ${r.diff.only_in_log.join(', ')}`);
    } else {
      console.log('ログ : （タグなし。--log を渡すと突合します）');
    }
    const icon = r.verdict === 'MATCH' ? '✅ 一致' : r.verdict === 'MISMATCH' ? '❌ 不一致' : 'ℹ️ DB のみ';
    console.log(`判定 : ${icon}`);
  }
}

main().catch(e => { console.error('[check] failed:', e?.message || e); process.exit(1); });

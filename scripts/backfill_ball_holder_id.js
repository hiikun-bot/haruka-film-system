#!/usr/bin/env node
// scripts/backfill_ball_holder_id.js
//
// 役割:
//   migration 2026-05-03_notification_phase1.sql で creatives.ball_holder_id 列を新設したあと、
//   既存の全クリエイティブに対して getBallHolder() を実行して ball_holder_id を一度だけ埋める。
//   この初期投入が無いと「過去のクリエイティブのボール保持者」が NULL のままで、
//   ステータス変更 → ball 返却通知が誤発火（NULL → 実IDの遷移は通知発火条件を満たしてしまう）する。
//
// 重要:
//   このスクリプトは一回限り。マイグレーション直後に1度だけ実行する。
//   2回目以降の実行は冪等（同じIDなら UPDATE しない実装になっている）なので無害。
//
// 実行方法:
//   cd haruka_film_system
//   node scripts/backfill_ball_holder_id.js
//
//   オプション:
//     --dry-run   実際のUPDATEを行わず、見込み変更件数だけ表示
//     --limit=N   先頭 N 件だけ処理（テスト用）
//
// 環境変数:
//   .env から SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を読む（既存の supabase.js と同じ仕組み）。

require('dotenv').config();
const supabase = require('../supabase');
const { syncBallHolderId } = require('../routes/haruka');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

async function main() {
  console.log('[backfill] ball_holder_id バックフィル開始');
  console.log('[backfill] DRY_RUN =', DRY_RUN, ' LIMIT =', LIMIT || '(なし)');

  // 全クリエイティブIDを取得（納品済みも含めて全件対象。NULL の現状維持を防ぐため）
  let q = supabase.from('creatives').select('id, status, ball_holder_id').order('created_at', { ascending: true });
  if (LIMIT) q = q.limit(LIMIT);
  const { data: creatives, error } = await q;
  if (error) {
    console.error('[backfill] 取得失敗:', error.message);
    process.exit(1);
  }
  console.log(`[backfill] 対象クリエイティブ件数: ${creatives.length}`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (let i = 0; i < creatives.length; i++) {
    const c = creatives[i];
    if (i % 50 === 0) console.log(`[backfill] 進捗 ${i}/${creatives.length}`);

    if (DRY_RUN) {
      // dry-run でも syncBallHolderId は副作用ありなので、ここでは件数表示のみ
      continue;
    }

    try {
      const before = c.ball_holder_id;
      const after = await syncBallHolderId(c.id);
      if ((before || null) === (after || null)) unchanged++;
      else updated++;
    } catch (e) {
      failed++;
      console.warn(`[backfill] id=${c.id} 失敗:`, e.message);
    }
  }

  console.log('[backfill] 完了');
  console.log(`  更新: ${updated} 件`);
  console.log(`  変更なし: ${unchanged} 件`);
  console.log(`  失敗: ${failed} 件`);
  if (DRY_RUN) console.log('  ※ DRY_RUN モードのため実際の UPDATE はしていません');

  // 注意: 初回バックフィルは既存通知が大量発火するのを避けるため、
  //       本来は「トリガーを一時無効化 → バックフィル → トリガー有効化」がセオリー。
  //       しかし notify_ball_returned は OLD.ball_holder_id IS DISTINCT FROM NEW.ball_holder_id を見るので、
  //       NULL → 実ID への変化は通知INSERTが走る。
  //       本番投入前に必要に応じて以下を SQL Editor で実行してから本スクリプトを叩く:
  //         ALTER TABLE creatives DISABLE TRIGGER trg_creatives_ball_returned;
  //         (バックフィル実行)
  //         ALTER TABLE creatives ENABLE TRIGGER trg_creatives_ball_returned;
  //       こうすれば既存案件のボール保持者を初期化するだけで通知は飛ばない。
}

main().catch(e => {
  console.error('[backfill] 予期せぬエラー:', e.stack || e.message);
  process.exit(1);
});

// workers/bug-triage-sla-checker.js
// =============================================================
// バグ報告 24h トリアージ SLA チェッカ
//
// 役割:
//   1時間ごとに bug_reports を走査し、
//     status='open' AND triage_decision IS NULL AND created_at < NOW() - 24h
//   の行を抽出 → admin 全員に "対応方針未確定" の通知を送る。
//
//   既に通知済みのバグ報告にもう一度通知しないよう、bug_reports に
//   sla_notified_at を追加…せず、本worker は「直近1時間で created_at が
//   24h 経過したばかり」のものだけを対象にする方式で実装する（重複検知の
//   ためのカラムを増やさない）。
//
//     created_at が NOW()-25h 〜 NOW()-24h の範囲にある報告だけを通知対象とする。
//
//   これにより、admin が長期に放置していても通知は1度だけ飛ぶ（cron が
//   1時間ごとに走るので、運用上ほぼ確実に1回拾える）。停止していた
//   時間帯に取りこぼしが起きるケースは Step 8 の統計拡張で「未トリアージ
//   一覧」を見ることで補える。
//
// 起動:
//   server.js の起動時に startBugTriageSlaChecker() を1回だけ呼ぶ。
//
// 制約:
//   ・通知は notification_type='global' を使う（専用 type を増やさない）
//   ・admin の判定は users.role = 'admin' で取得
// =============================================================

const supabase = require('../supabase');
const { createBulkNotifications } = require('../utils/notification');

const TICK_MS = 60 * 60 * 1000; // 1時間

let intervalHandle = null;
let isRunning = false;

async function checkOverdueTriage() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = Date.now();
    const cutoffOlder = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h前
    const cutoffNewer = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 24h前

    // 24h 〜 25h 前に作成され、まだ未トリアージ かつ open のもの
    const { data: rows, error } = await supabase
      .from('bug_reports')
      .select('id, title, severity, is_urgent, created_at')
      .is('triage_decision', null)
      .eq('status', 'open')
      .gte('created_at', cutoffOlder)
      .lt('created_at', cutoffNewer);

    if (error) {
      console.error('[bug-triage-sla] SELECT 失敗:', error.message);
      return;
    }
    if (!rows || rows.length === 0) return;

    // admin 全員を取得
    const { data: admins, error: aErr } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .eq('is_active', true);
    if (aErr) {
      console.error('[bug-triage-sla] admin取得失敗:', aErr.message);
      return;
    }
    if (!admins || admins.length === 0) return;

    // bugs × admins の通知をまとめて1回の bulk insert にする（N+1 解消）
    const notifs = [];
    for (const r of rows) {
      const shortId = String(r.id).replace(/-/g, '').slice(0, 8);
      const sevTag = r.is_urgent ? '🚨 至急 ' : '';
      const title = `${sevTag}🦋 24h 経過: 対応方針が未確定です`;
      const body = `#${shortId} 「${(r.title || '').slice(0, 80)}」 の対応方針を決めてください`;
      const linkUrl = `/haruka.html?bug-report=${r.id}`;
      for (const a of admins) {
        notifs.push({
          user_id: a.id,
          notification_type: 'global',
          title,
          body,
          link_url: linkUrl,
          meta: { bug_report_id: r.id, kind: 'triage_sla_24h' },
        });
      }
    }
    let total = 0;
    if (notifs.length) {
      try {
        const created = await createBulkNotifications(notifs);
        total = Array.isArray(created) ? created.length : notifs.length;
      } catch (e) {
        console.error('[bug-triage-sla] bulk notify失敗:', e.message);
      }
    }
    if (total > 0) {
      console.log(`[bug-triage-sla] 通知発行: ${rows.length}件 × ${admins.length}名 = ${total}件`);
    }
  } catch (e) {
    console.error('[bug-triage-sla] 例外:', e.message);
  } finally {
    isRunning = false;
  }
}

function startBugTriageSlaChecker() {
  if (intervalHandle) return;
  console.log(`[bug-triage-sla] 起動（${TICK_MS}ms 周期）`);
  // 起動直後にも1回流す
  checkOverdueTriage().catch(e => console.error('[bug-triage-sla] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    checkOverdueTriage().catch(e => console.error('[bug-triage-sla] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }
}

function stopBugTriageSlaChecker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startBugTriageSlaChecker, stopBugTriageSlaChecker, checkOverdueTriage };

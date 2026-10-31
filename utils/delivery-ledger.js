// utils/delivery-ledger.js
//
// 納品完了メッセージの「当月の案件内 納品カウント（積み上げ台帳）」（ADR 055）。
//
// 目的:
//   納品完了の通知（Slack / Chatwork の案件チャンネル）に「この案件で今月は何件目か」を
//   毎回積み上げて載せ、あとから AI が Slack / Chatwork のやり取りだけを読んでも
//   「その案件の当月の対応本数」を文字列で追えるようにする。
//   同じ数字を HFS のデータベース（creatives.delivered_at の JST 月）からも出せるので、
//   メッセージ側と DB 側のダブルチェックができる。
//
// 本モジュールは純粋関数＋Supabase 読み取りだけ（書き込みなし）。
//   - loadProjectDeliveryLedger(): DB から当月の納品済み一覧と件数を取る
//   - buildDeliveryLedgerBlock(): Slack / Chatwork 向けの表示ブロックを組む
//   - formatLedgerTag() / parseLedgerTags(): 機械可読タグ `[HFS-LEDGER] key=value ...` の生成と解析
//
// 「当月」は必ず JST で判定する（Railway は UTC 動作。feedback: 時間ロジックはJST明示）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LEDGER_TAG = '[HFS-LEDGER]';
// 一覧に載せる最大行数。超えた分は先頭側を「…ほか N 件」に畳む（最新側を残す）。
const MAX_LIST_ROWS = 15;
const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];

// 'YYYY-MM'（JST）→ timestamptz 比較用の [startIso, endIso)
// 例: '2026-10' → start=2026-09-30T15:00:00.000Z（JST 10/1 00:00）, end=2026-10-31T15:00:00.000Z（JST 11/1 00:00）
function jstMonthRangeIso(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!(month >= 1 && month <= 12)) return null;
  return {
    startIso: new Date(Date.UTC(year, month - 1, 1) - JST_OFFSET_MS).toISOString(),
    endIso:   new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS).toISOString(),
  };
}

// TIMESTAMPTZ ISO → JST の 'YYYY-MM'。不正なら null。
function jstYearMonthOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 7);
}

// TIMESTAMPTZ ISO → JST の 'M/D'（一覧の日付表示用）。
function jstMonthDayOf(iso) {
  if (!iso) return '--/--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--/--';
  const ymd = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}

// 'YYYY-MM' → 'YYYY年M月' の表示ラベル
function monthLabelOf(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  return `${m[1]}年${Number(m[2])}月`;
}

// 当月の案件内 納品台帳を DB から取る。
//   - 対象: creatives.project_id = projectId ∧ status='納品' ∧ delivered_at ∈ JST 月（ADR 026 と同じ判定）
//   - 並び: delivered_at 昇順（同時刻は id で安定化）。seq は 1 始まり
//   - projectTotal: 案件の全期間の納品済み件数（status='納品' ∧ delivered_at 非 NULL）
// 戻り値: { ym, monthTotal, projectTotal, items: [{ id, file_name, creative_type, delivered_at, seq }] }
// 取得失敗は throw（呼び出し側で握る。通知の主処理を止めない）。
async function loadProjectDeliveryLedger(supabase, { projectId, ym }) {
  const range = jstMonthRangeIso(ym);
  if (!projectId || !range) throw new Error(`delivery-ledger: invalid args (projectId=${projectId}, ym=${ym})`);

  const { data: rows, error } = await supabase
    .from('creatives')
    .select('id, file_name, creative_type, delivered_at')
    .eq('project_id', projectId)
    .eq('status', '納品')
    .gte('delivered_at', range.startIso)
    .lt('delivered_at', range.endIso)
    .order('delivered_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`delivery-ledger: select failed: ${error.message}`);

  const { count, error: cntErr } = await supabase
    .from('creatives')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', '納品')
    .not('delivered_at', 'is', null);
  if (cntErr) throw new Error(`delivery-ledger: count failed: ${cntErr.message}`);

  const items = (rows || []).map((r, i) => ({
    id: r.id,
    file_name: r.file_name || '',
    creative_type: r.creative_type || null,
    delivered_at: r.delivered_at || null,
    seq: i + 1,
  }));
  return { ym, monthTotal: items.length, projectTotal: Number(count) || 0, items };
}

// 機械可読タグ 1 行。AI が Slack / Chatwork の本文から正規表現で拾う前提の固定書式。
//   [HFS-LEDGER] project=<uuid> month=YYYY-MM seq=<今回の件目> month_total=<当月件数> project_total=<案件累計> creative=<uuid>
//   一括納品（複数件）のときは seq / creative の代わりに added=<今回の件数> を出す。
function formatLedgerTag({ projectId, ym, seq, monthTotal, projectTotal, creativeId, added }) {
  const parts = [LEDGER_TAG, `project=${projectId}`, `month=${ym}`];
  if (seq != null) parts.push(`seq=${seq}`);
  if (added != null) parts.push(`added=${added}`);
  parts.push(`month_total=${monthTotal}`);
  parts.push(`project_total=${projectTotal}`);
  if (creativeId) parts.push(`creative=${creativeId}`);
  return parts.join(' ');
}

// 本文（Slack / Chatwork のログを貼り付けたテキスト）から [HFS-LEDGER] 行を全部拾う。
// 戻り値: [{ project, month, seq, added, month_total, project_total, creative, raw }]
// Slack の mrkdwn で `*` や `>` が混ざっていても拾えるよう、行頭の装飾は無視する。
function parseLedgerTags(text) {
  const out = [];
  const re = /\[HFS-LEDGER\]([^\n\r]*)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const body = m[1];
    const rec = { raw: `${LEDGER_TAG}${body}`.trim() };
    const kv = /(\w+)=([^\s*`>]+)/g;
    let p;
    while ((p = kv.exec(body)) !== null) {
      const key = p[1];
      const val = p[2];
      if (['seq', 'added', 'month_total', 'project_total'].includes(key)) {
        const n = Number(val);
        rec[key] = Number.isFinite(n) ? n : null;
      } else {
        rec[key] = val;
      }
    }
    if (rec.project && rec.month) out.push(rec);
  }
  return out;
}

// タグ列（parseLedgerTags の戻り値。ログの出現順＝投稿の時系列）から「最後に投稿されたタグ」を返す。
// 突合で DB と比べるのは必ずこの 1 件の month_total（最大値ではない）。
//   納品を戻して 5件→3件 に訂正した場合、ログには month_total=5 のあとに month_total=3 が残る。
//   最大値 5 を使うと「訂正後の正しい 3件」を不一致、「古い 5件」を一致と誤判定してしまう。
// month_total が数値でないタグは飛ばす。該当なしは null。
function latestLedgerTag(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (t && Number.isFinite(t.month_total)) return t;
  }
  return null;
}

// 表示ブロックを組む（Slack / Chatwork 共通の行配列を返す。装飾は呼び出し側）。
//
// @param {object} p
// @param {object} p.ledger loadProjectDeliveryLedger() の戻り値
// @param {string} p.projectId
// @param {string[]} [p.currentIds] 今回納品した creative の id（1 件なら「⬅ 今回」印、複数なら「🆕」印）
// @param {boolean} [p.bulk] 一括納品（月次消込）のとき true
// 戻り値: { headline, lines: string[], tag }
//   headline: 「📊 納品カウント（2026年10月）: 5件目 ／ 案件累計 23件」
//   lines   : 一覧（①10/2 ファイル名 …）。多すぎる場合は先頭側を畳む
//   tag     : [HFS-LEDGER] 行
function buildDeliveryLedgerBlock({ ledger, projectId, currentIds, bulk }) {
  const ids = new Set((currentIds || []).filter(Boolean));
  const { ym, monthTotal, projectTotal, items } = ledger;
  const label = monthLabelOf(ym);

  // 今回分の seq（単件のとき）。delivered_at の手動補正で途中に挿入されることもあるので
  // 「最後の行」ではなく id で探す。
  const current = ids.size === 1 ? items.find(it => ids.has(it.id)) : null;
  const seq = current ? current.seq : null;

  let headline;
  if (bulk) {
    headline = `📊 納品カウント（${label}）: 今回 ${ids.size}件 → 当月 ${monthTotal}件 ／ 案件累計 ${projectTotal}件`;
  } else if (seq != null) {
    headline = `📊 納品カウント（${label}）: ${seq}件目 ／ 当月 ${monthTotal}件 ／ 案件累計 ${projectTotal}件`;
  } else {
    headline = `📊 納品カウント（${label}）: 当月 ${monthTotal}件 ／ 案件累計 ${projectTotal}件`;
  }

  const lines = [];
  const overflow = Math.max(0, items.length - MAX_LIST_ROWS);
  const shown = overflow > 0 ? items.slice(overflow) : items;
  if (overflow > 0) lines.push(`　…ほか ${overflow}件（先行分。HFS の案件画面で確認）`);
  for (const it of shown) {
    const num = CIRCLED[it.seq - 1] || `(${it.seq})`;
    const mark = ids.has(it.id) ? (ids.size === 1 ? ' ⬅ 今回' : ' 🆕') : '';
    lines.push(`　${num}${jstMonthDayOf(it.delivered_at)} ${it.file_name || '(ファイル名なし)'}${mark}`);
  }
  if (items.length === 0) lines.push('　（当月の納品済みはまだありません）');

  const tag = formatLedgerTag({
    projectId, ym, monthTotal, projectTotal,
    seq: bulk ? null : seq,
    added: bulk ? ids.size : null,
    creativeId: (!bulk && current) ? current.id : null,
  });
  return { headline, lines, tag };
}

// Slack 用: mrkdwn で見出しを太字、タグはコードスパン（装飾されても parseLedgerTags が拾える）。
function renderLedgerSlack(block) {
  return [
    `*${block.headline}*`,
    ...block.lines,
    `\`${block.tag}\``,
  ].join('\n');
}

// Chatwork 用: 装飾なし（[info] の内側に置く前提）。
function renderLedgerChatwork(block) {
  return [block.headline, ...block.lines, block.tag].join('\n');
}

module.exports = {
  LEDGER_TAG,
  MAX_LIST_ROWS,
  jstMonthRangeIso,
  jstYearMonthOf,
  jstMonthDayOf,
  monthLabelOf,
  loadProjectDeliveryLedger,
  formatLedgerTag,
  parseLedgerTags,
  latestLedgerTag,
  buildDeliveryLedgerBlock,
  renderLedgerSlack,
  renderLedgerChatwork,
};

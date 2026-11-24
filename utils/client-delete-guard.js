// utils/client-delete-guard.js
// クライアント削除の前に「紐づく実データが本当に 0 件か」を確かめる純関数（#1316 のレビュー対応）。
//
// 方針（2026-11-24 さとるさん決定）: 実データがあるクライアントは削除せず「取引終了（非表示）」にする。
//   消せるのは誤登録で中身が空のクライアントだけ。
//
// 守ること:
//   - 件数の確認が 1 つでも失敗したら（テーブルや列が無い・通信エラー・件数が返らない）削除しない。
//     以前は「テーブルが無い」系のエラーを 0 件扱いにしていたため、確認できていないのに削除へ進めた。
//   - 削除で黙って紐づきが外れる（SET NULL）・行ごと消える（CASCADE）テーブルは全部ここに並べる。
//     クライアントを参照する FK を増やしたら、この一覧にも足すこと。
//   - client_teams / client_configs / client_products / client_appeal_axes（CASCADE）はクライアントの設定で
//     実データではないので対象外（products / appeal_axes 系は Stage C で削除予定）。

const CLIENT_LINKED_TABLES = [
  { table: 'projects',                key: 'projects',                label: '案件' },               // NO ACTION
  { table: 'project_revenue_entries', key: 'revenue_entries',         label: '売上' },               // SET NULL
  { table: 'contract_documents',      key: 'contract_documents',      label: '契約文書' },           // SET NULL（client_pledge）
  { table: 'material_square_folders', key: 'material_square_folders', label: '素材広場のフォルダ' }, // CASCADE
  { table: 'sales_contacts',          key: 'sales_contacts',          label: '営業の連絡先（名刺）' }, // SET NULL（ADR 056）
];

/**
 * @param {(table: string) => Promise<{ count: number|null, error: any }>} countFn
 *   table の client_id = 対象 の件数を返す（supabase の head:true + count:'exact' の結果をそのまま渡す）
 * @returns {Promise<{ ok: boolean, failed: Array<{table:string,message:string}>, counts: Record<string,number>, hasData: boolean, summary: string }>}
 *   ok=false … 確認できなかったテーブルがある（削除してはいけない）
 */
async function checkClientLinkedData(countFn, tables = CLIENT_LINKED_TABLES) {
  const results = await Promise.all(tables.map(async (t) => {
    try {
      const r = await countFn(t.table);
      if (!r || r.error) return { t, error: (r && r.error && (r.error.message || String(r.error))) || '結果が返りませんでした' };
      const n = Number(r.count);
      if (r.count === null || r.count === undefined || !Number.isFinite(n) || n < 0) return { t, error: '件数が返りませんでした' };
      return { t, count: n };
    } catch (e) {
      return { t, error: (e && e.message) || String(e) };
    }
  }));
  const failed = results.filter(r => r.error !== undefined).map(r => ({ table: r.t.table, message: r.error }));
  const counts = {};
  const parts = [];
  for (const r of results) {
    if (r.error !== undefined) continue;
    counts[r.t.key] = r.count;
    if (r.count > 0) parts.push(`${r.t.label} ${r.count} 件`);
  }
  return {
    ok: failed.length === 0,
    failed,
    counts,
    hasData: parts.length > 0,
    summary: parts.length ? `${parts.join('・')}が紐づいています。` : '',
  };
}

module.exports = { CLIENT_LINKED_TABLES, checkClientLinkedData };

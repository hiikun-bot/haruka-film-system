// 請求書番号（INV-YYYYMM-NNN）の採番。メンバー請求書（旧 /invoices/generate・請求書エディタ）と
// クライアント請求書（/client-invoice/generate）で共用する。
//
// 直したこと（2026-11-24）
//   ・年月は日本時間（JST）で決める。サーバー（Railway）は UTC で動くので、new Date().getMonth() だと
//     毎月 1 日の 0〜9 時（JST）に作った請求書が前月の番号になっていた
//   ・連番は「その年月の件数 + 1」ではなく「その年月の番号の最大 + 1」。下書きを消すと件数が減り、
//     残っている番号と同じ番号を振ってしまう（invoice_number は UNIQUE なので作成が失敗し続ける）
//   ・同時に作ると同じ番号になりうるので、一意制約違反（23505）なら番号を取り直して入れ直す
//     （一意制約は invoices.invoice_number の UNIQUE（supabase_schema.sql）。本番に無い場合に備えて
//      migrations/2026-11-24c_invoices_invoice_number_unique.sql で、無ければ一意インデックスを作る）

const PREFIX = 'INV-';
const MAX_ATTEMPTS = 6;

// JST の年・月と 'YYYYMM'。now は Date（省略時は現在）。サーバーの TZ に左右されない
function jstYearMonth(now = new Date()) {
  const ymd = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // 'YYYY-MM-DD'
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  return { year, month, ym: ymd.slice(0, 4) + ymd.slice(5, 7) };
}

// 既存の番号の一覧から、その年月の次の番号を返す（形の違う番号は数えない）
function nextInvoiceNumber(existingNumbers, ym) {
  const re = new RegExp('^' + PREFIX + ym + '-(\\d+)$');
  let max = 0;
  for (const n of (existingNumbers || [])) {
    const m = re.exec(String(n || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${PREFIX}${ym}-${String(max + 1).padStart(3, '0')}`;
}

function isInvoiceNumberConflict(err) {
  return !!err && err.code === '23505' && /invoice_number/.test(String(err.message || '') + String(err.details || ''));
}

// その年月の番号をすべて読む（PostgREST は 1 回に最大 1000 行なので、ページを送って読む。
// 番号の文字列順は 999 → 1000 で崩れるので「並べて先頭 1 件」は使わない）
const PAGE = 1000;
async function loadMonthNumbers(supabase, ym) {
  const list = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('invoices').select('invoice_number').like('invoice_number', `${PREFIX}${ym}-%`)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { error, list: null };
    for (const r of (data || [])) list.push(r.invoice_number);
    if (!data || data.length < PAGE) return { error: null, list };
  }
}

// 番号を振って invoices に 1 行入れる。番号がぶつかったら取り直して入れ直す。
//   buildRow(invoiceNumber) … 入れる行（invoice_number 以外）を返す
//   select … insert 後に返す列（既定 '*'）
// 返り値: { data, error, invoiceNumber }（error は最後の試行のもの）
async function insertInvoiceWithNumber(supabase, buildRow, { now = new Date(), select = '*' } = {}) {
  const { ym } = jstYearMonth(now);
  let last = { data: null, error: null, invoiceNumber: null };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const numbers = await loadMonthNumbers(supabase, ym);
    if (numbers.error) return { data: null, error: numbers.error, invoiceNumber: null };
    const invoiceNumber = nextInvoiceNumber(numbers.list, ym);
    const { data, error } = await supabase
      .from('invoices').insert({ ...buildRow(invoiceNumber), invoice_number: invoiceNumber })
      .select(select).single();
    last = { data, error, invoiceNumber };
    if (!isInvoiceNumberConflict(error)) return last;
  }
  return last;
}

module.exports = { jstYearMonth, nextInvoiceNumber, isInvoiceNumberConflict, insertInvoiceWithNumber, MAX_ATTEMPTS };

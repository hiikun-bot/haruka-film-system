// 請求書番号の採番（JST の年月・最大 + 1・重複は取り直し）。TZ=UTC / TZ=Asia/Tokyo のどちらでも同じ結果になること
const { jstYearMonth, nextInvoiceNumber, isInvoiceNumberConflict, insertInvoiceWithNumber, MAX_ATTEMPTS } = require('../../utils/invoice-number');

describe('jstYearMonth', () => {
  test('毎月 1 日の 0〜9 時（JST）は UTC では前月だが、JST の当月になる', () => {
    // 2026-12-01 03:00 JST = 2026-11-30T18:00Z
    expect(jstYearMonth(new Date('2026-11-30T18:00:00Z'))).toEqual({ year: 2026, month: 12, ym: '202612' });
    // 2027-01-01 00:00 JST = 2026-12-31T15:00Z（年またぎ）
    expect(jstYearMonth(new Date('2026-12-31T15:00:00Z'))).toEqual({ year: 2027, month: 1, ym: '202701' });
  });
  test('月末 23:59 JST は当月のまま', () => {
    expect(jstYearMonth(new Date('2026-11-30T14:59:59Z'))).toEqual({ year: 2026, month: 11, ym: '202611' });
  });
});

describe('nextInvoiceNumber', () => {
  test('件数ではなく最大 + 1（途中が消えていても重ならない）', () => {
    expect(nextInvoiceNumber(['INV-202611-001', 'INV-202611-003'], '202611')).toBe('INV-202611-004');
  });
  test('その月が 0 件なら 001。形の違う番号・別の月は数えない', () => {
    expect(nextInvoiceNumber([], '202611')).toBe('INV-202611-001');
    expect(nextInvoiceNumber(['INV-202610-009', 'INV-202611-x', null], '202611')).toBe('INV-202611-001');
  });
  test('1000 件を超えても桁があふれず続く', () => {
    expect(nextInvoiceNumber(['INV-202611-999'], '202611')).toBe('INV-202611-1000');
    expect(nextInvoiceNumber(['INV-202611-1000', 'INV-202611-999'], '202611')).toBe('INV-202611-1001');
  });
});

describe('isInvoiceNumberConflict', () => {
  test('invoice_number の一意制約違反だけを拾う', () => {
    expect(isInvoiceNumberConflict({ code: '23505', message: 'duplicate key value violates unique constraint "invoices_invoice_number_key"' })).toBe(true);
    expect(isInvoiceNumberConflict({ code: '23505', message: 'x', details: 'Key (invoice_number)=(INV-202611-001) already exists.' })).toBe(true);
    expect(isInvoiceNumberConflict({ code: '23505', message: 'duplicate key "invoices_pkey"' })).toBe(false);
    expect(isInvoiceNumberConflict({ code: '23502', message: 'invoice_number' })).toBe(false);
    expect(isInvoiceNumberConflict(null)).toBe(false);
  });
});

// invoices の select(like) / insert だけを持つ偽 DB。insert は invoice_number が重なれば 23505
function fakeDb(existing, { failSelect = false, beforeInsert = null } = {}) {
  const rows = existing.map(n => ({ invoice_number: n }));
  const inserted = [];
  return {
    rows, inserted,
    from(table) {
      expect(table).toBe('invoices');
      return {
        select() {
          return {
            like(_col, pattern) {
              const prefix = pattern.replace(/%$/, '');
              const q = {
                order() { return q; },
                range(from, to) {
                  if (failSelect) return Promise.resolve({ data: null, error: { message: 'boom' } });
                  const hit = rows.filter(r => r.invoice_number.startsWith(prefix)).map(r => ({ ...r }));
                  return Promise.resolve({ data: hit.slice(from, to + 1), error: null });
                },
              };
              return q;
            },
          };
        },
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  if (beforeInsert) beforeInsert(rows, row);
                  if (rows.some(r => r.invoice_number === row.invoice_number)) {
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "invoices_invoice_number_key"' } };
                  }
                  rows.push({ ...row });
                  inserted.push(row);
                  return { data: { id: 'new', ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe('insertInvoiceWithNumber', () => {
  const now = new Date('2026-11-30T18:00:00Z'); // JST 2026-12-01 03:00

  test('JST の年月で採番して入れる（buildRow の値に番号が足される）', async () => {
    const db = fakeDb(['INV-202611-005']);
    const r = await insertInvoiceWithNumber(db, (no) => ({ issuer_id: 'u1', note: no }), { now });
    expect(r.error).toBeNull();
    expect(r.invoiceNumber).toBe('INV-202612-001');
    expect(r.data).toMatchObject({ invoice_number: 'INV-202612-001', issuer_id: 'u1' });
  });

  test('同時に作られて番号がぶつかったら取り直して入れ直す', async () => {
    let raced = false;
    const db = fakeDb(['INV-202612-001'], {
      // 1 回目の insert の直前に、別のリクエストが同じ番号を先に入れた
      beforeInsert(rows, row) {
        if (!raced) { raced = true; rows.push({ invoice_number: row.invoice_number }); }
      },
    });
    const r = await insertInvoiceWithNumber(db, () => ({ issuer_id: 'u1' }), { now });
    expect(r.error).toBeNull();
    expect(r.invoiceNumber).toBe('INV-202612-003');
    expect(db.rows.map(x => x.invoice_number)).toEqual(['INV-202612-001', 'INV-202612-002', 'INV-202612-003']);
  });

  test('ぶつかり続けたら最後の 23505 を返して止まる（無限ループしない）', async () => {
    const db = fakeDb([], { beforeInsert(rows, row) { rows.push({ invoice_number: row.invoice_number }); } });
    const r = await insertInvoiceWithNumber(db, () => ({}), { now });
    expect(r.error && r.error.code).toBe('23505');
    expect(db.inserted).toHaveLength(0);
    expect(db.rows).toHaveLength(MAX_ATTEMPTS);
  });

  test('1000 件を超える月もページを送って最大を読む（1 ページ目だけで決めない）', async () => {
    const existing = Array.from({ length: 1500 }, (_, i) => `INV-202612-${String(i + 1).padStart(3, '0')}`);
    const db = fakeDb(existing);
    const r = await insertInvoiceWithNumber(db, () => ({}), { now });
    expect(r.error).toBeNull();
    expect(r.invoiceNumber).toBe('INV-202612-1501');
  });

  test('番号の読み出しに失敗したら入れない', async () => {
    const db = fakeDb([], { failSelect: true });
    const r = await insertInvoiceWithNumber(db, () => ({}), { now });
    expect(r.error).toEqual({ message: 'boom' });
    expect(db.inserted).toHaveLength(0);
  });
});

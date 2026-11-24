const { CLIENT_LINKED_TABLES, checkClientLinkedData } = require('../../utils/client-delete-guard');

const zeros = async () => ({ count: 0, error: null });

describe('checkClientLinkedData', () => {
  test('営業の連絡先（sales_contacts）も確認の対象に入っている', () => {
    expect(CLIENT_LINKED_TABLES.map(t => t.table)).toEqual(expect.arrayContaining([
      'projects', 'project_revenue_entries', 'contract_documents', 'material_square_folders', 'sales_contacts',
    ]));
  });

  test('全部 0 件なら削除してよい', async () => {
    const r = await checkClientLinkedData(zeros);
    expect(r).toMatchObject({ ok: true, hasData: false, failed: [] });
    expect(r.counts.sales_contacts).toBe(0);
  });

  test('営業の連絡先だけが紐づいていても止める', async () => {
    const r = await checkClientLinkedData(async (t) => ({ count: t === 'sales_contacts' ? 2 : 0, error: null }));
    expect(r.hasData).toBe(true);
    expect(r.summary).toContain('営業の連絡先（名刺） 2 件');
  });

  test('テーブルが無いエラーでも 0 件扱いにしない（確認失敗）', async () => {
    const r = await checkClientLinkedData(async (t) => (t === 'sales_contacts'
      ? { count: null, error: { message: 'relation "sales_contacts" does not exist' } }
      : { count: 0, error: null }));
    expect(r.ok).toBe(false);
    expect(r.hasData).toBe(false);
    expect(r.failed).toEqual([{ table: 'sales_contacts', message: 'relation "sales_contacts" does not exist' }]);
  });

  test('例外・件数なし（null）も確認失敗', async () => {
    const r = await checkClientLinkedData(async (t) => {
      if (t === 'projects') throw new Error('fetch failed');
      if (t === 'contract_documents') return { count: null, error: null };
      return { count: 0, error: null };
    });
    expect(r.ok).toBe(false);
    expect(r.failed.map(f => f.table).sort()).toEqual(['contract_documents', 'projects']);
  });

  test('一部失敗でも、見つかったデータがあれば hasData で知らせる', async () => {
    const r = await checkClientLinkedData(async (t) => (t === 'projects'
      ? { count: 3, error: null }
      : { count: null, error: { message: 'timeout' } }));
    expect(r.hasData).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.counts.projects).toBe(3);
  });
});

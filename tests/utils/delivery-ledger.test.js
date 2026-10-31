// tests/utils/delivery-ledger.test.js
// ADR 055: 納品完了メッセージの「当月の案件内 納品カウント（積み上げ台帳）」のユニットテスト。
// TZ=UTC / TZ=Asia/Tokyo どちらで走らせても同じ結果になること（feedback: 時間ロジックはJST明示）。

const L = require('../../utils/delivery-ledger');

// Supabase の from().select()...チェーンを最小限に模した mock。
// select(.., {head:true, count:'exact'}) → count 系、それ以外 → rows を返す。
function makeSupabaseMock({ rows = [], count = 0, selectError = null } = {}) {
  const calls = [];
  const build = (mode) => {
    const q = { _mode: mode, _filters: [] };
    const chain = (name) => (...a) => { q._filters.push([name, ...a]); return q; };
    ['eq', 'gte', 'lt', 'not', 'order'].forEach(n => { q[n] = chain(n); });
    q.then = (resolve, reject) => {
      calls.push(q);
      if (selectError) return Promise.resolve({ data: null, error: { message: selectError }, count: null }).then(resolve, reject);
      if (mode === 'count') return Promise.resolve({ data: null, error: null, count }).then(resolve, reject);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return q;
  };
  return {
    calls,
    from: jest.fn(() => ({
      select: jest.fn((_cols, opts) => build(opts && opts.head ? 'count' : 'rows')),
    })),
  };
}

describe('jstMonthRangeIso / jstYearMonthOf / jstMonthDayOf', () => {
  test('2026-10 の JST 月範囲は UTC で 9/30 15:00 〜 10/31 15:00', () => {
    expect(L.jstMonthRangeIso('2026-10')).toEqual({
      startIso: '2026-09-30T15:00:00.000Z',
      endIso: '2026-10-31T15:00:00.000Z',
    });
  });
  test('不正な month は null', () => {
    expect(L.jstMonthRangeIso('2026-13')).toBeNull();
    expect(L.jstMonthRangeIso('202610')).toBeNull();
    expect(L.jstMonthRangeIso(null)).toBeNull();
  });
  test('月末深夜（UTC 10/31 15:30 = JST 11/1 00:30）は 11 月に入る', () => {
    expect(L.jstYearMonthOf('2026-10-31T15:30:00Z')).toBe('2026-11');
    expect(L.jstYearMonthOf('2026-10-31T14:30:00Z')).toBe('2026-10');
    expect(L.jstYearMonthOf(null)).toBeNull();
    expect(L.jstYearMonthOf('not-a-date')).toBeNull();
  });
  test('jstMonthDayOf は JST の M/D', () => {
    expect(L.jstMonthDayOf('2026-10-31T15:30:00Z')).toBe('11/1');
    expect(L.jstMonthDayOf('2026-10-02T01:00:00Z')).toBe('10/2');
    expect(L.jstMonthDayOf(null)).toBe('--/--');
  });
  test('monthLabelOf', () => {
    expect(L.monthLabelOf('2026-10')).toBe('2026年10月');
    expect(L.monthLabelOf('2026-01')).toBe('2026年1月');
  });
});

describe('loadProjectDeliveryLedger', () => {
  test('delivered_at 昇順で seq を振り、案件累計 count も返す', async () => {
    const sb = makeSupabaseMock({
      rows: [
        { id: 'c1', file_name: 'A.mp4', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
        { id: 'c2', file_name: 'B.mp4', creative_type: '動画', delivered_at: '2026-10-05T01:00:00Z' },
      ],
      count: 23,
    });
    const r = await L.loadProjectDeliveryLedger(sb, { projectId: 'p1', ym: '2026-10' });
    expect(r.ym).toBe('2026-10');
    expect(r.monthTotal).toBe(2);
    expect(r.projectTotal).toBe(23);
    expect(r.items.map(i => i.seq)).toEqual([1, 2]);
    // フィルタ: project_id / status=納品 / delivered_at の JST 月範囲
    const rowsQ = sb.calls.find(q => q._mode === 'rows');
    expect(rowsQ._filters).toEqual(expect.arrayContaining([
      ['eq', 'project_id', 'p1'],
      ['eq', 'status', '納品'],
      ['gte', 'delivered_at', '2026-09-30T15:00:00.000Z'],
      ['lt', 'delivered_at', '2026-10-31T15:00:00.000Z'],
    ]));
    const countQ = sb.calls.find(q => q._mode === 'count');
    expect(countQ._filters).toEqual(expect.arrayContaining([
      ['eq', 'project_id', 'p1'],
      ['eq', 'status', '納品'],
      ['not', 'delivered_at', 'is', null],
    ]));
  });
  test('引数不正・select 失敗は throw（呼び出し側で握る）', async () => {
    await expect(L.loadProjectDeliveryLedger(makeSupabaseMock(), { projectId: null, ym: '2026-10' })).rejects.toThrow(/invalid args/);
    await expect(L.loadProjectDeliveryLedger(makeSupabaseMock(), { projectId: 'p1', ym: '2026/10' })).rejects.toThrow(/invalid args/);
    await expect(L.loadProjectDeliveryLedger(makeSupabaseMock({ selectError: 'boom' }), { projectId: 'p1', ym: '2026-10' })).rejects.toThrow(/boom/);
  });
});

function ledgerOf(n, { ym = '2026-10', projectTotal = 40 } = {}) {
  const items = [];
  for (let i = 1; i <= n; i++) {
    items.push({
      id: `c${i}`, file_name: `FILE_${i}.mp4`, creative_type: '動画',
      delivered_at: new Date(Date.UTC(2026, 9, i, 1, 0, 0)).toISOString(), seq: i,
    });
  }
  return { ym, monthTotal: n, projectTotal, items };
}

describe('buildDeliveryLedgerBlock', () => {
  test('単件納品: N件目・当月・案件累計の見出し、今回印、[HFS-LEDGER] タグ', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(5), projectId: 'p1', currentIds: ['c5'] });
    expect(b.headline).toBe('📊 納品カウント（2026年10月）: 5件目 ／ 当月 5件 ／ 案件累計 40件');
    expect(b.lines).toHaveLength(5);
    expect(b.lines[0]).toBe('　①10/1 FILE_1.mp4');
    expect(b.lines[4]).toBe('　⑤10/5 FILE_5.mp4 ⬅ 今回');
    expect(b.tag).toBe('[HFS-LEDGER] project=p1 month=2026-10 seq=5 month_total=5 project_total=40 creative=c5');
  });
  test('手動補正で途中に入った納品は、その位置の seq が「今回」になる', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(5), projectId: 'p1', currentIds: ['c3'] });
    expect(b.headline).toMatch(/^📊 納品カウント（2026年10月）: 3件目 ／ 当月 5件/);
    expect(b.lines[2]).toMatch(/⬅ 今回$/);
    expect(b.tag).toContain('seq=3 month_total=5');
  });
  test('一括納品: 今回 N件 → 当月 M件、🆕 印、added= タグ', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(4), projectId: 'p1', currentIds: ['c3', 'c4'], bulk: true });
    expect(b.headline).toBe('📊 納品カウント（2026年10月）: 今回 2件 → 当月 4件 ／ 案件累計 40件');
    expect(b.lines[2]).toMatch(/ 🆕$/);
    expect(b.lines[3]).toMatch(/ 🆕$/);
    expect(b.lines[0]).not.toMatch(/🆕/);
    expect(b.tag).toBe('[HFS-LEDGER] project=p1 month=2026-10 added=2 month_total=4 project_total=40');
  });
  test('16件以上は先頭側を畳み、最新 15 行だけ出す', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(20), projectId: 'p1', currentIds: ['c20'] });
    expect(b.lines).toHaveLength(16); // 畳み行 + 15
    expect(b.lines[0]).toBe('　…ほか 5件（先行分。HFS の案件画面で確認）');
    expect(b.lines[1]).toBe('　⑥10/6 FILE_6.mp4');
    expect(b.lines[15]).toBe('　⑳10/20 FILE_20.mp4 ⬅ 今回');
    expect(b.tag).toContain('seq=20 month_total=20');
  });
  test('当月 0 件（取得と納品の間にズレ）でも落ちない', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(0), projectId: 'p1', currentIds: ['cX'] });
    expect(b.headline).toBe('📊 納品カウント（2026年10月）: 当月 0件 ／ 案件累計 40件');
    expect(b.lines).toEqual(['　（当月の納品済みはまだありません）']);
    expect(b.tag).toBe('[HFS-LEDGER] project=p1 month=2026-10 month_total=0 project_total=40');
  });
  test('Slack はタグをコードスパン・見出しを太字、Chatwork は素のまま', () => {
    const b = L.buildDeliveryLedgerBlock({ ledger: ledgerOf(1), projectId: 'p1', currentIds: ['c1'] });
    const slack = L.renderLedgerSlack(b);
    expect(slack.split('\n')[0]).toBe(`*${b.headline}*`);
    expect(slack).toContain(`\`${b.tag}\``);
    const cw = L.renderLedgerChatwork(b);
    expect(cw.split('\n')[0]).toBe(b.headline);
    expect(cw.split('\n').pop()).toBe(b.tag);
  });
});

describe('parseLedgerTags', () => {
  test('Slack の引用・コードスパン混じりでも全タグを拾い、数値に変換する', () => {
    const text = [
      '> ━━━━━━',
      '> 🎉 *クライアントOK！納品完了*',
      '`[HFS-LEDGER] project=p1 month=2026-10 seq=1 month_total=1 project_total=37 creative=c1`',
      'ほかの会話',
      '> `[HFS-LEDGER] project=p1 month=2026-10 seq=2 month_total=2 project_total=38 creative=c2`',
      '[HFS-LEDGER] project=p2 month=2026-10 added=3 month_total=7 project_total=12',
    ].join('\n');
    const tags = L.parseLedgerTags(text);
    expect(tags).toHaveLength(3);
    expect(tags[0]).toMatchObject({ project: 'p1', month: '2026-10', seq: 1, month_total: 1, project_total: 37, creative: 'c1' });
    expect(tags[1]).toMatchObject({ project: 'p1', seq: 2, month_total: 2, creative: 'c2' });
    expect(tags[2]).toMatchObject({ project: 'p2', added: 3, month_total: 7, project_total: 12 });
    expect(tags[2].creative).toBeUndefined();
  });
  test('formatLedgerTag → parseLedgerTags の往復', () => {
    const tag = L.formatLedgerTag({ projectId: 'p9', ym: '2026-11', seq: 4, monthTotal: 4, projectTotal: 50, creativeId: 'c9' });
    const [t] = L.parseLedgerTags(`前後の文章 ${tag} 後ろ`);
    expect(t).toMatchObject({ project: 'p9', month: '2026-11', seq: 4, month_total: 4, project_total: 50, creative: 'c9' });
  });
  test('タグが無ければ空配列', () => {
    expect(L.parseLedgerTags('なにもない')).toEqual([]);
    expect(L.parseLedgerTags(null)).toEqual([]);
  });
});

describe('latestLedgerTag', () => {
  test('最後に投稿されたタグを返す（最大値ではない）: 5件→3件に訂正したログで 3 を採る', () => {
    const text = [
      '[HFS-LEDGER] project=p1 month=2026-10 seq=4 month_total=4 project_total=10 creative=c4',
      '[HFS-LEDGER] project=p1 month=2026-10 seq=5 month_total=5 project_total=11 creative=c5',
      '（c4・c5 の納品を戻して再納品）',
      '[HFS-LEDGER] project=p1 month=2026-10 seq=3 month_total=3 project_total=9 creative=c3',
    ].join('\n');
    const tags = L.parseLedgerTags(text);
    expect(L.latestLedgerTag(tags)).toMatchObject({ month_total: 3, creative: 'c3' });
  });
  test('month_total が読めないタグは飛ばし、無ければ null', () => {
    const tags = [{ project: 'p1', month: '2026-10', month_total: 2 }, { project: 'p1', month: '2026-10', month_total: null }];
    expect(L.latestLedgerTag(tags).month_total).toBe(2);
    expect(L.latestLedgerTag([])).toBeNull();
    expect(L.latestLedgerTag(null)).toBeNull();
  });
});

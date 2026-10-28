// tests/pricing-pending-reminder.test.js
// 単価の承認待ちリマインド（ADR 037 追補）の本文組み立て・日数計算のテスト。
const { daysWaiting, groupByProject, buildPricingPendingReminderText, isoToJstYmd } = require('../utils/pricing-pending-reminder');

describe('isoToJstYmd / daysWaiting', () => {
  test('UTC の深夜は JST で翌日として数える', () => {
    expect(isoToJstYmd('2026-10-27T16:00:00Z')).toBe('2026-10-28');
    expect(daysWaiting('2026-10-27T16:00:00Z', '2026-10-28')).toBe(0);
    expect(daysWaiting('2026-10-25T03:00:00Z', '2026-10-28')).toBe(3);
    expect(daysWaiting(null, '2026-10-28')).toBeNull();
  });
});

describe('groupByProject', () => {
  test('案件ごとに件数・申請者をまとめ、申請が古い案件を先に並べる', () => {
    const g = groupByProject([
      { project_id: 'p2', client_name: 'B社', project_name: 'B案件', requester_label: 'ぴょん', requested_at: '2026-10-27T01:00:00Z' },
      { project_id: 'p1', client_name: 'A社', project_name: 'A案件', requester_label: 'たごん', requested_at: '2026-10-20T01:00:00Z' },
      { project_id: 'p2', client_name: 'B社', project_name: 'B案件', requester_label: 'ぴょん', requested_at: '2026-10-26T01:00:00Z' },
    ]);
    expect(g.map(x => x.project_id)).toEqual(['p1', 'p2']);
    expect(g[1].count).toBe(2);
    expect(g[1].oldest_at).toBe('2026-10-26T01:00:00Z');
    expect([...g[1].requesters]).toEqual(['ぴょん']);
  });
});

describe('buildPricingPendingReminderText', () => {
  test('件数・案件・待ち日数・まとめページのリンクを含む', () => {
    const text = buildPricingPendingReminderText({
      items: [
        { project_id: 'p1', client_name: '東京ガス', project_name: 'LPディレクション', requester_label: 'ぴょん', requested_at: '2026-10-26T01:00:00Z' },
        { project_id: 'p1', client_name: '東京ガス', project_name: 'LPディレクション', requester_label: 'ぴょん', requested_at: '2026-10-27T01:00:00Z' },
      ],
      todayYmd: '2026-10-28',
      pageUrl: 'https://hfs.example.com/haruka.html?page=pricing-approvals',
    });
    expect(text).toContain('[title]💴 単価の承認待ちが残っています（2件）[/title]');
    expect(text).toContain('・東京ガス / LPディレクション：2グループ（2日待ち） ／ ぴょんさん');
    expect(text).toContain('まとめて承認する: https://hfs.example.com/haruka.html?page=pricing-approvals');
  });

  test('11 案件以上は「ほか N 案件」に畳む', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ project_id: `p${i}`, client_name: 'C', project_name: `案件${i}`, requested_at: `2026-10-${String(10 + i).padStart(2, '0')}T01:00:00Z` }));
    const text = buildPricingPendingReminderText({ items, todayYmd: '2026-10-28', pageUrl: null });
    expect(text).toContain('…ほか 2案件');
    expect(text).not.toContain('まとめて承認する');
  });
});

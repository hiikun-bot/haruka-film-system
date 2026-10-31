// tests/notifications-delivery-role-lines.test.js
// 納品完了メッセージの「担当者／ディレクター／プロデューサー／ダブルチェック」行（ADR 055 追補 2026-10-31）

jest.mock('../supabase', () => ({}));
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));
jest.mock('axios');

const { buildDeliveryRoleLines, buildCreativeNotifBody } = require('../notifications');

const ito = { id: 'u1', full_name: '伊東' };
const katayama = { id: 'u2', full_name: '片山 紗季' };
const kawasaki = { id: 'u3', full_name: '川崎 かおり' };
const w = { id: 'u4', full_name: '奥田' };

describe('buildDeliveryRoleLines', () => {
  test('役割ごとに 1 行ずつ。ダブルチェックは担当がいるときだけ', () => {
    expect(buildDeliveryRoleLines({ editors: [ito], directors: [katayama], producers: [kawasaki], wchecks: [w] })).toEqual([
      '担当者: 伊東',
      'ディレクター: 片山 紗季',
      'プロデューサー: 川崎 かおり',
      'ダブルチェック: 奥田',
    ]);
    expect(buildDeliveryRoleLines({ editors: [ito], directors: [katayama], producers: [kawasaki], wchecks: [] })).toHaveLength(3);
  });
  test('案件 D と担当 D が同じ人なら 1 回だけ。null や空は無視し、空なら（未設定）', () => {
    expect(buildDeliveryRoleLines({ editors: [], directors: [katayama, null, katayama], producers: [undefined] })).toEqual([
      '担当者: （未設定）',
      'ディレクター: 片山 紗季',
      'プロデューサー: （未設定）',
    ]);
  });
});

describe('buildCreativeNotifBody with roleLines', () => {
  const base = {
    kind: 'クライアントOK！納品完了', emoji: '🎉',
    project: { name: 'LP制作' }, client: { name: '東京ガス' },
    fileName: 'A.mp4', slackName: '<u|A.mp4>', actor: katayama, recipient: [ito, katayama],
    comment: null, creativeUrl: 'https://x/haruka.html?creative=1',
  };
  test('roleLines があれば「担当者: A → B」行を置き換える（Slack / Chatwork とも）', () => {
    const roleLines = buildDeliveryRoleLines({ editors: [ito], directors: [katayama], producers: [kawasaki], wchecks: [] });
    const { slackBody, cwBody } = buildCreativeNotifBody({ ...base, roleLines });
    for (const body of [slackBody, cwBody]) {
      expect(body).not.toContain('→');
      expect(body).toContain('担当者: 伊東\nディレクター: 片山 紗季\nプロデューサー: 川崎 かおり\nコメント:');
    }
    expect(slackBody).toContain('ファイル: <u|A.mp4>\n担当者: 伊東');
  });
  test('roleLines が無ければ従来どおり「A → B」', () => {
    const { slackBody } = buildCreativeNotifBody(base);
    expect(slackBody).toContain('担当者: 片山 紗季 → 伊東, 片山 紗季');
  });
});

// tests/cost-ledger-director-fee.test.js
// 費用台帳シートの「ディレクション費」列が読む先のユニットテスト。
//
// 背景: 台帳同期のディレクション費だけが旧 project_director_rates に読み書きされており、
// システム本体（成果報酬・案件編集モーダル）が見る project_estimate_line_costs(role=director)
// と分断されていた。シートに入れてインポートしても成果報酬が ¥0／「単価不明」のままで、
// エクスポートすると旧テーブルの値が戻るため「差分0件・一致しています」と表示されていた。
//
// cost-ledger-sync.js は supabase.js（env 必須）と googleapis を require するためモックする。

jest.mock('../supabase', () => ({ from: () => ({}) }));
jest.mock('googleapis', () => ({ google: { auth: { GoogleAuth: class {} }, sheets: () => ({}) } }));

const { directorFeeOfGroup } = require('../utils/cost-ledger-sync');

// m のうち directorFeeOfGroup が使うのは costsByLine と roleById だけ
const DIRECTOR_ROLE = 'role-director';
const DESIGNER_ROLE = 'role-designer';
const model = (costsByLine) => ({
  costsByLine,
  roleById: {
    [DIRECTOR_ROLE]: { id: DIRECTOR_ROLE, code: 'director' },
    [DESIGNER_ROLE]: { id: DESIGNER_ROLE, code: 'designer' },
  },
});
const line = id => ({ id });

describe('directorFeeOfGroup（台帳の「ディレクション費」列 = line_costs の role=director）', () => {
  test('1本あたりのディレクター単価を読む', () => {
    const m = model({ L1: [
      { role_id: DESIGNER_ROLE, unit_price: 4000, pricing_type: 'fixed_per_unit' },
      { role_id: DIRECTOR_ROLE, unit_price: 1000, pricing_type: 'fixed_per_unit' },
    ] });
    expect(directorFeeOfGroup([line('L1')], m)).toBe(1000);
  });

  test('ディレクター単価が無いグループは null（シートには — が出る）', () => {
    const m = model({ L1: [{ role_id: DESIGNER_ROLE, unit_price: 2000, pricing_type: 'fixed_per_unit' }] });
    expect(directorFeeOfGroup([line('L1')], m)).toBeNull();
  });

  test('時給（ADR 028 の時間制ディレクター費）は 1本あたり単価として読まない', () => {
    const m = model({ L1: [{ role_id: DIRECTOR_ROLE, unit_price: 1500, pricing_type: 'hourly' }] });
    expect(directorFeeOfGroup([line('L1')], m)).toBeNull();
  });

  test('メンバー個別単価（user_id あり）はロール共通単価として読まない', () => {
    const m = model({ L1: [{ role_id: DIRECTOR_ROLE, user_id: 'u1', unit_price: 3000, pricing_type: 'fixed_per_unit' }] });
    expect(directorFeeOfGroup([line('L1')], m)).toBeNull();
  });

  test('A/B/C でディレクター単価が揃っていれば その値', () => {
    const m = model({
      A: [{ role_id: DIRECTOR_ROLE, unit_price: 500, pricing_type: 'fixed_per_unit' }],
      B: [{ role_id: DIRECTOR_ROLE, unit_price: 500, pricing_type: 'fixed_per_unit' }],
      C: [{ role_id: DIRECTOR_ROLE, unit_price: 500, pricing_type: 'fixed_per_unit' }],
    });
    expect(directorFeeOfGroup([line('A'), line('B'), line('C')], m)).toBe(500);
  });

  test('グループ間で食い違う場合は最大値を代表値にする（クライアント請求列と同じ扱い）', () => {
    const m = model({
      A: [{ role_id: DIRECTOR_ROLE, unit_price: 1000, pricing_type: 'fixed_per_unit' }],
      B: [{ role_id: DIRECTOR_ROLE, unit_price: 500, pricing_type: 'fixed_per_unit' }],
    });
    expect(directorFeeOfGroup([line('A'), line('B')], m)).toBe(1000);
  });

  test('pricing_type 未指定は fixed_per_unit とみなす（既定値）', () => {
    const m = model({ L1: [{ role_id: DIRECTOR_ROLE, unit_price: 800 }] });
    expect(directorFeeOfGroup([line('L1')], m)).toBe(800);
  });

  test('明示的に 0 が入っている場合は 0（未設定の null と区別する）', () => {
    const m = model({ L1: [{ role_id: DIRECTOR_ROLE, unit_price: 0, pricing_type: 'fixed_per_unit' }] });
    expect(directorFeeOfGroup([line('L1')], m)).toBe(0);
  });
});

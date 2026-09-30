// ADR 046: 請求書テンプレ下書き出力の純関数テスト。
// TZ=UTC / TZ=Asia/Tokyo の両方で同じ結果になること（日付は JST 固定）。
const d = require('../../utils/invoice-sheet-draft');

const UID = 'u-me';
const proj = (over = {}) => ({ id: 'p1', name: 'hertech_動画編集', director_id: 'u-dir', producer_id: 'u-pro', billing_timing: 'on_delivery', clients: { name: 'hertech', billing_org: 'haruka' }, ...over });
const cr = (over = {}) => ({
  id: over.id || 'c1',
  file_name: over.file_name || 'file_a',
  status: '納品',
  creative_type: 'video',
  delivered_at: '2026-09-10T03:00:00Z',
  first_draft_submitted_at: null,
  final_deadline: '2026-09-15',
  draft_deadline: null,
  is_payable: true,
  special_payable: false,
  project_id: 'p1',
  projects: proj(),
  creative_assignments: [{ user_id: UID, role: 'editor' }],
  delivered_director_ids: [],
  delivered_producer_ids: [],
  ...over,
});

describe('日付（JST 固定）', () => {
  test('jstYmdOfIso は JST の日付（UTC 15:00 以降は翌日）', () => {
    expect(d.jstYmdOfIso('2026-09-30T14:59:59Z')).toBe('2026-09-30');
    expect(d.jstYmdOfIso('2026-09-30T15:00:00Z')).toBe('2026-10-01');
    expect(d.jstYmdOfIso(null)).toBeNull();
  });
  test('ymdToSheetSerial は Sheets の日付シリアル値', () => {
    expect(d.ymdToSheetSerial('1899-12-30')).toBe(0);
    expect(d.ymdToSheetSerial('1970-01-01')).toBe(25569);
    expect(d.ymdToSheetSerial('2026-01-01')).toBe(46023);
    expect(d.ymdToSheetSerial('2026-09-30')).toBe(46295);
  });
  test('invoiceDates: 請求日=月末 / 支払期限=翌月末（年跨ぎ・うるう年）', () => {
    expect(d.invoiceDates(2026, 9)).toEqual({ issueYmd: '2026-09-30', dueYmd: '2026-10-31' });
    expect(d.invoiceDates(2026, 12)).toEqual({ issueYmd: '2026-12-31', dueYmd: '2027-01-31' });
    expect(d.invoiceDates(2028, 1)).toEqual({ issueYmd: '2028-01-31', dueYmd: '2028-02-29' });
  });
});

describe('groupCreativesForDraft', () => {
  test('区分×案件×役割×種別でまとめ、数量・単位・最新納品日（JST）を入れる', () => {
    const list = [
      cr({ id: 'c1', file_name: 'v1', delivered_at: '2026-09-05T01:00:00Z' }),
      cr({ id: 'c2', file_name: 'v2', delivered_at: '2026-09-29T15:30:00Z' }), // JST 9/30
      cr({ id: 'c3', file_name: 'i1', creative_type: 'design_banner', creative_assignments: [{ user_id: UID, role: 'designer' }] }),
      cr({ id: 'c4', file_name: 'g1', project_id: 'p2', projects: proj({ id: 'p2', name: 'JTG証券', clients: { billing_org: 'gnd' } }) }),
    ];
    const { groups, creativeCount } = d.groupCreativesForDraft(list, UID);
    expect(creativeCount).toBe(4);
    expect(groups.map(g => [g.kubun, g.projectName, g.role, g.kind, g.unit, g.count])).toEqual([
      ['HF', 'hertech_動画編集', '編集', '動画', '本', 2],
      ['HF', 'hertech_動画編集', 'デザイン', '静止画', '枚', 1],
      ['GND', 'JTG証券', '編集', '動画', '本', 1],
    ]);
    expect(groups[0].latestYmd).toBe('2026-09-30');
    expect(groups[0].itemText).toBe('hertech_動画編集 編集（動画）\nv1\nv2');
  });

  test('未納品（締切が当月なだけ）は載せない', () => {
    const { groups } = d.groupCreativesForDraft([cr({ status: '制作中', delivered_at: null })], UID);
    expect(groups).toHaveLength(0);
  });

  test('on_first_draft 案件は初稿提出済みなら載る（納品日=初稿提出日）', () => {
    const p = proj({ billing_timing: 'on_first_draft' });
    const { groups } = d.groupCreativesForDraft([
      cr({ id: 'a', status: 'クライアントチェック中', delivered_at: null, is_payable: false, first_draft_submitted_at: '2026-09-20T16:00:00Z', projects: p }),
      cr({ id: 'b', status: '制作中', delivered_at: null, is_payable: false, first_draft_submitted_at: null, projects: p }),
    ], UID);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
    expect(groups[0].latestYmd).toBe('2026-09-21');
  });

  test('Wチェック担当だけの分・支払対象外（is_payable=false）は載せない。special_payable は載る', () => {
    const { groups } = d.groupCreativesForDraft([
      cr({ id: 'w', creative_assignments: [{ user_id: UID, role: 'wcheck' }] }),
      cr({ id: 'np', is_payable: false }),
      cr({ id: 'sp', is_payable: false, special_payable: true }),
    ], UID);
    expect(groups).toHaveLength(1);
    expect(groups[0].creatives.map(c => c.id)).toEqual(['sp']);
  });

  test('案件ディレクター（スナップショット優先）はディレクション枠になる', () => {
    const { groups } = d.groupCreativesForDraft([
      cr({ id: 'x', creative_assignments: [{ user_id: 'other', role: 'editor' }], delivered_director_ids: [UID] }),
    ], UID);
    expect(groups.map(g => g.role)).toEqual(['ディレクション']);
  });

  test('内訳は 15 件まで並べて残りは「ほか N 件」', () => {
    const list = Array.from({ length: 18 }, (_, i) => cr({ id: `c${i}`, file_name: `f${String(i).padStart(2, '0')}` }));
    const { groups } = d.groupCreativesForDraft(list, UID);
    const lines = groups[0].itemText.split('\n');
    expect(lines).toHaveLength(1 + 15 + 1);
    expect(lines[16]).toBe('ほか 3 件');
    expect(groups[0].count).toBe(18);
  });
});

describe('数式', () => {
  // 2026-09-28 時点のテンプレ（SA で読み取り）と同一であること
  const TEMPLATE = {
    H14: '=IF(ISNUMBER(K57),K57,"")',
    A15: '=IF(COUNTA(H18:H49,I18:I49,E18:E49)=0,"薄黄色の欄に入力してください。単価は税抜金額です。",IF(K57="要確認","入力確認：発行者区分・品目・税抜単価・数量・源泉区分をご確認ください。","下記のとおりご請求申し上げます。"))',
    K52: '=IF(COUNT(K18:K49)=0,"",SUM(K18:K49))',
    C53: '=K52',
    E53: '=K53',
    K53: '=IF(K52="","",ROUNDDOWN(K52*$A$53,0))',
    K54: '=IF(K52="","",K52+K53)',
    K55: '=IF(K52="","",IF(D8="法人（国内）",0,IF(D8="個人（居住者）",IF(COUNTIFS(K18:K49,">=0",K18:K49,"<>",L18:L49,"対象")+COUNTIFS(K18:K49,">=0",K18:K49,"<>",L18:L49,"対象外")=COUNT(K18:K49),SUMIF(L18:L49,"対象",K18:K49),"要確認"),"要確認")))',
    K56: '=IF(K52="","",IF(ISNUMBER(K55),ROUNDDOWN(MIN(K55,1000000)*10.21%+MAX(K55-1000000,0)*20.42%,0),"要確認"))',
    K57: '=IF(COUNTA(H18:H49,I18:I49,E18:E49)=0,"",IF(OR(COUNT(K18:K49)<>COUNT(H18:H49),COUNT(K18:K49)<>COUNT(I18:I49),COUNT(K18:K49)<>COUNTA(E18,E22,E26,E30,E34,E38,E42,E46),NOT(ISNUMBER(K56))),"要確認",K54-K56))',
  };
  test('8 枠以下ではテンプレの数式と完全一致', () => {
    expect(d.buildTotalsFormulas(d.layoutForGroups(3))).toEqual(TEMPLATE);
    expect(d.blockAmountFormula(18)).toBe('=IF(OR(H18="",I18=""),"",ROUND(H18*I18,0))');
  });
  test('12 枠では明細範囲・E セル一覧・合計行がずれる', () => {
    const lay = d.layoutForGroups(12);
    expect(lay.lastItemRow).toBe(65);
    expect(lay.shift).toBe(16);
    const f = d.buildTotalsFormulas(lay);
    expect(f.K68).toBe('=IF(COUNT(K18:K65)=0,"",SUM(K18:K65))');
    expect(f.K73).toContain('COUNTA(E18,E22,E26,E30,E34,E38,E42,E46,E50,E54,E58,E62)');
    expect(f.K73).toContain('K70-K72');
    expect(f.H14).toBe('=IF(ISNUMBER(K73),K73,"")');
    expect(f.K69).toBe('=IF(K68="","",ROUNDDOWN(K68*$A$69,0))');
  });
});

describe('buildDraftRequests', () => {
  const groups = d.groupCreativesForDraft([cr({ id: 'c1' }), cr({ id: 'c2' })], UID).groups;
  const user = { full_name: '山田 太郎', postal_code: '650-0001', address: '兵庫県神戸市', phone: '090-0000-0000', invoice_registration_number: 'T1234567890123', bank_name: 'みなと銀行', bank_code: '0562', branch_name: '本店', branch_code: '001', account_type: '普通', account_number: '0123456', account_holder_kana: 'ヤマダ タロウ' };
  const { requests } = d.buildDraftRequests({ invoiceSheetId: 1, masterSheetId: 2, metaSheetId: 3, cfRule: null, projectValidation: null, groups, user, year: 2026, month: 9, masterNames: ['hertech_動画編集'], meta: { user_id: UID, generated_at: 'x' } });
  const cellWrites = requests.filter(r => r.updateCells && r.updateCells.range.sheetId === 1);
  const at = (col, row) => cellWrites.filter(r => r.updateCells.range.startColumnIndex <= col && r.updateCells.range.endColumnIndex > col && r.updateCells.range.startRowIndex === row - 1)
    .map(r => r.updateCells.rows[0].values[col - r.updateCells.range.startColumnIndex]?.userEnteredValue);

  test('税抜単価（明細の H 列 18〜49 行）は一切書かない', () => {
    const hCol = 7;
    expect(cellWrites.some(r => r.updateCells.range.startColumnIndex <= hCol && r.updateCells.range.endColumnIndex > hCol
      && r.updateCells.range.startRowIndex >= 17 && r.updateCells.range.startRowIndex < 49)).toBe(false);
  });
  test('源泉区分は「対象」、数量・単位・納品日（シリアル値）', () => {
    expect(at(11, 18)).toEqual([{ stringValue: '対象' }]);
    expect(at(8, 18)).toEqual([{ numberValue: 2 }]);
    expect(at(9, 18)).toEqual([{ stringValue: '本' }]);
    expect(at(0, 18)).toEqual([{ numberValue: d.ymdToSheetSerial('2026-09-10') }]);
    expect(at(1, 18)).toEqual([{ stringValue: 'HF' }]);
    expect(at(13, 18)).toEqual([{ stringValue: 'c1,c2' }]);
  });
  test('ヘッダー: 発行者・登録番号・期間・件名・日付・振込先。発行者区分 D8 は書かない', () => {
    expect(at(7, 5)).toEqual([{ stringValue: '山田 太郎' }]);
    expect(at(10, 9)).toEqual([{ stringValue: 'T1234567890123' }]);
    expect(at(0, 6)).toEqual([{ stringValue: '請求対象期間：2026年9月1日〜9月30日' }]);
    expect(at(0, 11)).toEqual([{ stringValue: '件名：2026年9月分 業務委託費' }]);
    expect(at(10, 11)).toEqual([{ numberValue: d.ymdToSheetSerial('2026-09-30') }]);
    expect(at(10, 12)).toEqual([{ numberValue: d.ymdToSheetSerial('2026-10-31') }]);
    expect(at(9, 59)).toEqual([{ stringValue: '0562' }]);
    expect(at(2, 61)).toEqual([{ stringValue: '普通' }]);
    expect(at(3, 8)).toEqual([]);
  });
  test('非表示シート _hfs と N 列の非表示', () => {
    expect(requests.some(r => r.addSheet && r.addSheet.properties.title === '_hfs' && r.addSheet.properties.hidden)).toBe(true);
    expect(requests.some(r => r.updateDimensionProperties && r.updateDimensionProperties.range.dimension === 'COLUMNS' && r.updateDimensionProperties.range.startIndex === 13)).toBe(true);
  });
  test('9 枠以上なら行挿入＋枠コピー、案件名の入力規則を全枠に張り直す', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...groups[0], projectName: `P${i}` }));
    const { requests: r2 } = d.buildDraftRequests({ invoiceSheetId: 1, masterSheetId: 2, metaSheetId: 3, cfRule: { index: 0, rule: { ranges: [], booleanRule: {} } }, projectValidation: null, groups: many, user: {}, year: 2026, month: 9, masterNames: many.map(g => g.projectName), meta: {} });
    const ins = r2.find(r => r.insertDimension);
    expect(ins.insertDimension.range).toMatchObject({ startIndex: 49, endIndex: 57 });
    expect(r2.filter(r => r.copyPaste)).toHaveLength(2);
    expect(r2.filter(r => r.setDataValidation)).toHaveLength(10);
    const cf = r2.find(r => r.updateConditionalFormatRule);
    expect(cf.updateConditionalFormatRule.rule.ranges[0]).toMatchObject({ startRowIndex: 17, endRowIndex: 57, startColumnIndex: 11 });
  });
});

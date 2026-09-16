const {
  normalizeMentionText,
  buildMentionDirectory,
  resolveMentions,
  extractMentionIds,
  filterMentionCandidates,
} = require('../../utils/mention-resolve');

const USERS = [
  { id: 'u-tagon',  full_name: '川崎 かおり', nickname: 'たごん' },
  { id: 'u-pyon',   full_name: '片山 紗季',   nickname: 'ぴょん' },
  { id: 'u-haru',   full_name: '髙橋 聖',     nickname: 'ハル' },
  { id: 'u-taro',   full_name: 'Yamada Taro', nickname: '' },
  { id: 'u-dup',    full_name: '山田 太郎',   nickname: 'たごん' }, // 同じニックネームの別人
];

describe('normalizeMentionText', () => {
  test('NFKC・空白除去・小文字化', () => {
    expect(normalizeMentionText('Ｙａｍａｄａ　Ｔａｒｏ')).toBe('yamadataro');
    expect(normalizeMentionText(' 川崎 かおり ')).toBe('川崎かおり');
    expect(normalizeMentionText(null)).toBe('');
  });
});

describe('buildMentionDirectory', () => {
  test('nickname / full_name / 姓 をキーにする', () => {
    const dir = buildMentionDirectory([USERS[0]]);
    expect(dir).toHaveLength(1);
    expect(new Set(dir[0].keys)).toEqual(new Set(['たごん', '川崎かおり', '川崎']));
  });
  test('1文字の姓はキーにしない・名前が無いユーザーは除外', () => {
    const dir = buildMentionDirectory([
      { id: 'a', full_name: '王 大', nickname: '' },
      { id: 'b', full_name: '', nickname: '' },
    ]);
    expect(dir).toHaveLength(1);
    expect(dir[0].keys).toEqual(['王大']);
  });
});

describe('resolveMentions', () => {
  test('名前の直後に空白が無くても解決する（旧実装の再現バグ）', () => {
    const ids = extractMentionIds('@ぴょんお疲れ様です！', USERS);
    expect(ids).toEqual(['u-pyon']);
  });
  test('全角＠・末尾の「さん」付きでも解決する', () => {
    expect(extractMentionIds('＠ぴょんさん、ありがとう', USERS)).toEqual(['u-pyon']);
  });
  test('full_name（空白あり/なし）・姓のみでも解決する', () => {
    expect(extractMentionIds('@片山 紗季 お願いします', USERS)).toEqual(['u-pyon']);
    expect(extractMentionIds('@片山紗季お願いします', USERS)).toEqual(['u-pyon']);
    expect(extractMentionIds('@片山さん確認お願いします', USERS)).toEqual(['u-pyon']);
  });
  test('最長一致: 「@たごん」より「@川崎 かおり」が長くても正しく片方に解決', () => {
    const spans = resolveMentions('@川崎 かおり と @たごん', USERS);
    expect(spans).toHaveLength(2);
    expect(spans[0].text).toBe('@川崎 かおり');
    expect(spans[0].userIds).toEqual(['u-tagon']);
    expect(spans[1].text).toBe('@たごん');
    // 同じニックネームの別人も対象（同名対策）
    expect(new Set(spans[1].userIds)).toEqual(new Set(['u-tagon', 'u-dup']));
  });
  test('英字は大文字小文字・全角半角を無視', () => {
    expect(extractMentionIds('@yamada taro thanks', USERS)).toEqual(['u-taro']);
    expect(extractMentionIds('@ＹＡＭＡＤＡ', USERS)).toEqual(['u-taro']);
  });
  test('「@ 名前」（@ 直後が空白）・該当者なし・メールアドレス風は対象外', () => {
    expect(extractMentionIds('@ ぴょん', USERS)).toEqual([]);
    expect(extractMentionIds('@だれか', USERS)).toEqual([]);
    expect(extractMentionIds('mail@example.com', USERS)).toEqual([]);
    expect(extractMentionIds('', USERS)).toEqual([]);
    expect(extractMentionIds(null, USERS)).toEqual([]);
  });
  test('絵文字（サロゲートペア）を含んでも区間オフセットが正しい', () => {
    const body = '🎉🎉@ハル🎬ありがとう';
    const spans = resolveMentions(body, USERS);
    expect(spans).toHaveLength(1);
    expect(body.slice(spans[0].start, spans[0].end)).toBe('@ハル');
    expect(spans[0].userIds).toEqual(['u-haru']);
  });
  test('同じ人を2回メンションしても id は一意', () => {
    expect(extractMentionIds('@ハル @ハル', USERS)).toEqual(['u-haru']);
  });
  test('辞書（buildMentionDirectory の戻り値）を直接渡しても動く', () => {
    const dir = buildMentionDirectory(USERS);
    expect(extractMentionIds('@ぴょん', dir)).toEqual(['u-pyon']);
  });
});

describe('filterMentionCandidates', () => {
  test('空クエリは全員（上限つき）', () => {
    expect(filterMentionCandidates(USERS, '', 3)).toHaveLength(3);
    expect(filterMentionCandidates(USERS, '')).toHaveLength(5);
  });
  test('前方一致を優先し、部分一致も拾う', () => {
    const r = filterMentionCandidates(USERS, 'かお');
    expect(r.map(u => u.id)).toEqual(['u-tagon']);
    const r2 = filterMentionCandidates(USERS, 'ta');
    // 'tagon'(nickname はカナなので不一致) → Yamada Taro は full_name に "ta" を含む
    expect(r2.map(u => u.id)).toEqual(['u-taro']);
  });
  test('全角半角・大文字小文字を無視', () => {
    expect(filterMentionCandidates(USERS, 'ＹＡＭＡ').map(u => u.id)).toEqual(['u-taro']);
  });
});

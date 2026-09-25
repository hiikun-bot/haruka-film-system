// utils/reactions.js — つぶやき / 作品ギャラリー共通のリアクション定義（基本 5 種＋拡張パレット ADR 044）
const R = require('../../utils/reactions');

describe('utils/reactions', () => {
  test('基本 5 種の定義は不変（作品ギャラリー・既存 UI が依存）', () => {
    expect(R.REACTION_TYPES).toEqual(['good', 'heart', 'clap', 'smile', 'surprised']);
    expect(R.REACTION_EMOJI.clap).toBe('👏');
    expect(R.isBaseReactionType('clap')).toBe(true);
    expect(R.isBaseReactionType('lol')).toBe(false);
  });

  test('type 判定は基本＋拡張の全部を受け付ける（つぶやきの API が使う）', () => {
    expect(R.isReactionType('clap')).toBe(true);
    expect(R.isReactionType('lol')).toBe(true);
    expect(R.isReactionType('fire')).toBe(true);
    expect(R.isReactionType('nope_not_defined')).toBe(false);
    expect(R.isReactionType(null)).toBe(false);
    expect(R.isReactionType('')).toBe(false);
  });

  test('拡張パレット: 🤣 爆笑を含み、基本 5 種とは重ならず、type / 絵文字が一意', () => {
    expect(R.EXTRA_REACTIONS.length).toBeGreaterThanOrEqual(20);
    const lol = R.EXTRA_REACTIONS.find(r => r.type === 'lol');
    expect(lol).toEqual({ type: 'lol', emoji: '🤣', label: '爆笑' });

    const extraTypes = R.EXTRA_REACTIONS.map(r => r.type);
    for (const t of R.REACTION_TYPES) expect(extraTypes).not.toContain(t);

    const allTypes = R.ALL_REACTIONS.map(r => r.type);
    expect(new Set(allTypes).size).toBe(allTypes.length);
    const allEmojis = R.ALL_REACTIONS.map(r => r.emoji);
    expect(new Set(allEmojis).size).toBe(allEmojis.length);
    for (const r of R.ALL_REACTIONS) {
      expect(r.emoji.length).toBeGreaterThan(0);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  test('ALL_* は「基本 5 種 → 拡張」の順（サマリのピルの並び順）', () => {
    expect(R.ALL_REACTION_TYPES.slice(0, 5)).toEqual(R.REACTION_TYPES);
    expect(R.ALL_REACTION_TYPES.slice(5)).toEqual(R.EXTRA_REACTION_TYPES);
    expect(R.ALL_REACTIONS.length).toBe(R.REACTIONS.length + R.EXTRA_REACTIONS.length);
  });

  test('すべての type が DB の形式 CHECK（^[a-z][a-z0-9_]{0,31}$）を満たす', () => {
    expect(R.REACTION_TYPE_PATTERN.source).toBe('^[a-z][a-z0-9_]{0,31}$');
    for (const t of R.ALL_REACTION_TYPES) {
      expect(t).toMatch(R.REACTION_TYPE_PATTERN);
      expect(t).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });

  test('REACTION_EMOJI / REACTION_LABEL は基本＋拡張の全部を引ける（通知の文面で使う）', () => {
    for (const r of R.ALL_REACTIONS) {
      expect(R.REACTION_EMOJI[r.type]).toBe(r.emoji);
      expect(R.REACTION_LABEL[r.type]).toBe(r.label);
    }
    expect(R.REACTION_EMOJI.lol).toBe('🤣');
  });

  test('作品ギャラリー用: 種別・絵文字は基本 5 種と同一、言い回しだけ違う（拡張は含まない）', () => {
    expect(R.PORTFOLIO_REACTIONS.map(r => r.type).sort()).toEqual([...R.REACTION_TYPES].sort());
    for (const r of R.PORTFOLIO_REACTIONS) {
      expect(r.emoji).toBe(R.REACTION_EMOJI[r.type]);
      expect(r.label).toBe(R.PORTFOLIO_LABEL[r.type]);
      expect(r.label).not.toBe(R.REACTION_LABEL[r.type]);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  test('作品ギャラリーの主ボタンは 👏 で先頭に並ぶ', () => {
    expect(R.PORTFOLIO_PRIMARY).toBe('clap');
    expect(R.PORTFOLIO_REACTIONS[0].type).toBe('clap');
    expect(R.PORTFOLIO_LABEL.clap).toBe('ナイス！');
  });
});

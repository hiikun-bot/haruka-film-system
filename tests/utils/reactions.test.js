// utils/reactions.js — つぶやき / 作品ギャラリー共通のリアクション定義
const R = require('../../utils/reactions');

describe('utils/reactions', () => {
  test('5 種の定義と type 判定', () => {
    expect(R.REACTION_TYPES).toEqual(['good', 'heart', 'clap', 'smile', 'surprised']);
    expect(R.REACTION_EMOJI.clap).toBe('👏');
    expect(R.isReactionType('clap')).toBe(true);
    expect(R.isReactionType('fire')).toBe(false);
    expect(R.isReactionType(null)).toBe(false);
  });

  test('作品ギャラリー用: 種別・絵文字はつぶやきと同一、言い回しだけ違う', () => {
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

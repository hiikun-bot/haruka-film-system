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

  // ---- 動く絵文字（ADR 044 追補 2026-09-26）----
  describe('動く絵文字（Noto Emoji Animation）', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../../public/img/emoji-anim');

    test('絵文字 → コードポイント（FE0F を除く・複数は _ 連結）', () => {
      expect(R.emojiCodepoint('🤣')).toBe('1f923');
      expect(R.emojiCodepoint('❤️')).toBe('2764');   // FE0F を落とす
      expect(R.emojiCodepoint('✌️')).toBe('270c');
      expect(R.emojiCodepoint('☕')).toBe('2615');
      expect(R.emojiCodepoint('')).toBe('');
      expect(R.emojiCodepoint(null)).toBe('');
    });

    test('REACTION_ANIM_SRC は素材が無い 4 種を除く全種別を /img/emoji-anim/<cp>.webp で指す', () => {
      const types = Object.keys(R.REACTION_ANIM_SRC);
      expect(types.length).toBe(R.ALL_REACTIONS.length - R.ANIM_UNAVAILABLE.size);
      expect(R.REACTION_ANIM_SRC.lol).toBe('/img/emoji-anim/1f923.webp');
      expect(R.REACTION_ANIM_SRC.beer).toBeUndefined();   // 🍺 は Noto に素材なし
      for (const t of types) {
        expect(R.REACTION_ANIM_SRC[t]).toMatch(/^\/img\/emoji-anim\/[0-9a-f_]+\.webp$/);
      }
    });

    test('定義にある動く絵文字のファイルが実在し、逆に定義に無いファイルも置かれていない', () => {
      const expected = new Set(Object.values(R.REACTION_ANIM_SRC).map(u => path.basename(u)));
      for (const f of expected) {
        const p = path.join(dir, f);
        expect(fs.existsSync(p)).toBe(true);
        // 1 個 256KB 以内（96px・多くは 60〜120KB、😇 💯 など動きの大きいものが 200KB 強。超えたら変換設定を疑う）
        expect(fs.statSync(p).size).toBeLessThan(256 * 1024);
      }
      const actual = fs.readdirSync(dir).filter(f => f.endsWith('.webp'));
      expect(actual.sort()).toEqual([...expected].sort());
    });
  });
});

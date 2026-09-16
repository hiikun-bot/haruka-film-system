// utils/reactions.js
// リアクション（👍 / ❤️ / 👏 / 😊 / 😳）の種類の定義。
// 作品ギャラリー向けの言い回し（PORTFOLIO_REACTIONS）もここで持つ（種別・絵文字は共通）。
//
// つぶやき（tweet_reactions）と作品ギャラリー（portfolio_reactions）で同じ 5 種を使う。
// 以前はサーバー（routes/haruka.js の TWEET_REACTION_TYPES）とフロント（haruka.html の
// TWEET_REACTIONS）に別々に書かれていたので、ここ 1 箇所に集約した。
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/reactions')
//   - ブラウザ: server.js が /js/reactions.js で配信 → window.ReactionsUtils
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ReactionsUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 並び順＝UI の表示順（つぶやきのピッカーと同じ）
  const REACTIONS = [
    { type: 'good',      emoji: '👍', label: 'いいね' },
    { type: 'heart',     emoji: '❤️', label: 'ハート' },
    { type: 'clap',      emoji: '👏', label: '拍手' },
    { type: 'smile',     emoji: '😊', label: 'スマイル' },
    { type: 'surprised', emoji: '😳', label: 'びっくり' },
  ];
  const REACTION_TYPES = REACTIONS.map(r => r.type);
  const REACTION_EMOJI = Object.fromEntries(REACTIONS.map(r => [r.type, r.emoji]));
  const REACTION_LABEL = Object.fromEntries(REACTIONS.map(r => [r.type, r.label]));

  function isReactionType(type) {
    return REACTION_TYPES.includes(String(type || ''));
  }

  // ---- 作品ギャラリー用の言い回し（ADR 042 追補 2026-09-17）----
  // 種別・絵文字・DB の値はつぶやきと同じ 5 種のまま、ボタンに出す言葉だけ
  // 「作品を褒める言葉」に置き換える。「いいね/ハート」のような絵文字の名前ではなく、
  // 押した瞬間に「何を伝えたか」が分かる短い一言にする（押す理由を作る）。
  //   👏 clap      → ナイス！     …一番押しやすい万能の褒め言葉（ワンクリックの主ボタン）
  //   ❤️ heart     → 好き         …好みに刺さった
  //   👍 good      → 参考になる   …自分の制作に活かしたい（お世辞でなく実利があると押しやすい）
  //   😊 smile     → ほっこり     …見ていて気持ちがいい・和む
  //   😳 surprised → すごい…！    …驚き・レベルの高さ
  const PORTFOLIO_LABEL = {
    clap:      'ナイス！',
    heart:     '好き',
    good:      '参考になる',
    smile:     'ほっこり',
    surprised: 'すごい…！',
  };
  // 作品ギャラリーでの表示順（主ボタンの 👏 を先頭に）
  const PORTFOLIO_REACTION_ORDER = ['clap', 'heart', 'good', 'smile', 'surprised'];
  const PORTFOLIO_REACTIONS = PORTFOLIO_REACTION_ORDER.map(t => {
    const base = REACTIONS.find(r => r.type === t);
    return { type: t, emoji: base.emoji, label: PORTFOLIO_LABEL[t] };
  });
  // ワンクリックで押せる主リアクション
  const PORTFOLIO_PRIMARY = 'clap';

  return {
    REACTIONS, REACTION_TYPES, REACTION_EMOJI, REACTION_LABEL, isReactionType,
    PORTFOLIO_REACTIONS, PORTFOLIO_LABEL, PORTFOLIO_PRIMARY,
  };
});

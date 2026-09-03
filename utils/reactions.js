// utils/reactions.js
// リアクション（👍 / ❤️ / 👏 / 😊 / 😳）の種類の定義。
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

  return { REACTIONS, REACTION_TYPES, REACTION_EMOJI, REACTION_LABEL, isReactionType };
});

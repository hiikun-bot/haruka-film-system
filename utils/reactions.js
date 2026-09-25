// utils/reactions.js
// リアクションの種類の定義。
//   ・基本 5 種（👍 / ❤️ / 👏 / 😊 / 😳）: つぶやき・作品ギャラリーで共通。ピッカーに常時並ぶ
//   ・拡張パレット（🤣 / 🔥 / 🎉 …）: つぶやき（本体・返信）のピッカーで「＋」を押すと開く（ADR 044）
// 作品ギャラリー向けの言い回し（PORTFOLIO_REACTIONS）もここで持つ（種別・絵文字は共通）。
//
// 以前はサーバー（routes/haruka.js の TWEET_REACTION_TYPES）とフロント（haruka.html の
// TWEET_REACTIONS）に別々に書かれていたので、ここ 1 箇所に集約した。
//
// 種別（type）の書き方: 英小文字で始まる 英小文字・数字・_ の 1〜32 文字。
//   DB（tweet_reactions / tweet_comment_reactions）はこの形式だけを CHECK し、どの種類を
//   許可するかはこのファイルが正（migration `2026-09-25_tweet_reactions_relax_type_check.sql`）。
//   絵文字を足すときは EXTRA_REACTIONS に 1 行足すだけでよい（migration 不要）。
//   一度使った type は変えない（DB に文字列で残るため。絵文字・label の差し替えは可）。
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

  // 基本 5 種。並び順＝UI の表示順（つぶやきのピッカーと同じ）
  const REACTIONS = [
    { type: 'good',      emoji: '👍', label: 'いいね' },
    { type: 'heart',     emoji: '❤️', label: 'ハート' },
    { type: 'clap',      emoji: '👏', label: '拍手' },
    { type: 'smile',     emoji: '😊', label: 'スマイル' },
    { type: 'surprised', emoji: '😳', label: 'びっくり' },
  ];
  const REACTION_TYPES = REACTIONS.map(r => r.type);

  // ---- 拡張パレット（ADR 044・2026-09-25）----
  // 「基本スタンプに＋ボタンを置いて、爆笑などいろんな絵文字をリアクションとして選べるように」
  // という要望から。並び順＝パレットの表示順（顔 → 手 → もの）。
  //   ・全部入りの絵文字ピッカー（数千種）は入れない。社内 SNS で「押す理由」が立つものを厳選する
  //   ・端末差で豆腐にならないよう、Emoji 11（2018）までの絵文字に絞る
  //   ・label はホバー／ピルの吹き出しに出る「何を伝えたか」の短い一言
  const EXTRA_REACTIONS = [
    // 顔
    { type: 'lol',          emoji: '🤣', label: '爆笑' },
    { type: 'joy',          emoji: '😂', label: 'うれし泣き' },
    { type: 'cry',          emoji: '😭', label: '号泣' },
    { type: 'love_eyes',    emoji: '😍', label: '大好き' },
    { type: 'star_eyes',    emoji: '🤩', label: 'キラキラ' },
    { type: 'warm',         emoji: '🥰', label: 'しあわせ' },
    { type: 'sweat_smile',  emoji: '😅', label: 'あせあせ' },
    { type: 'thinking',     emoji: '🤔', label: '考え中' },
    { type: 'cool',         emoji: '😎', label: 'かっこいい' },
    { type: 'scream',       emoji: '😱', label: 'ぎゃー' },
    { type: 'mind_blown',   emoji: '🤯', label: '衝撃' },
    { type: 'pleading',     emoji: '🥺', label: 'うるうる' },
    { type: 'party_face',   emoji: '🥳', label: 'おめでとう' },
    { type: 'hug',          emoji: '🤗', label: 'なでなで' },
    { type: 'wink',         emoji: '😉', label: 'ウインク' },
    { type: 'yum',          emoji: '😋', label: 'おいしそう' },
    { type: 'sad',          emoji: '😢', label: 'かなしい' },
    { type: 'sleepy',       emoji: '😴', label: 'ねむい' },
    { type: 'angel',        emoji: '😇', label: 'いい人' },
    { type: 'see_no_evil',  emoji: '🙈', label: '見ちゃった' },
    // 手
    { type: 'raised_hands', emoji: '🙌', label: 'ばんざい' },
    { type: 'pray',         emoji: '🙏', label: 'おねがい・感謝' },
    { type: 'muscle',       emoji: '💪', label: 'がんばろう' },
    { type: 'ok_hand',      emoji: '👌', label: 'OK' },
    { type: 'peace',        emoji: '✌️', label: 'ピース' },
    { type: 'handshake',    emoji: '🤝', label: 'よろしく' },
    { type: 'eyes',         emoji: '👀', label: '見てる' },
    { type: 'bow',          emoji: '🙇', label: 'ありがとうございます' },
    { type: 'wave',         emoji: '👋', label: 'やあ' },
    // もの
    { type: 'fire',         emoji: '🔥', label: 'アツい' },
    { type: 'tada',         emoji: '🎉', label: 'おめでとう！' },
    { type: 'hundred',      emoji: '💯', label: '最高' },
    { type: 'sparkles',     emoji: '✨', label: 'キラッ' },
    { type: 'rocket',       emoji: '🚀', label: 'いくぞ' },
    { type: 'trophy',       emoji: '🏆', label: '優勝' },
    { type: 'clapper',      emoji: '🎬', label: 'いい作品' },
    { type: 'bulb',         emoji: '💡', label: 'なるほど' },
    { type: 'coffee',       emoji: '☕', label: 'おつかれさま' },
    { type: 'beer',         emoji: '🍺', label: 'かんぱい' },
    { type: 'cake',         emoji: '🎂', label: 'お祝い' },
    { type: 'bouquet',      emoji: '💐', label: 'ありがとう' },
    { type: 'clover',       emoji: '🍀', label: 'がんばって' },
    { type: 'sweat_drops',  emoji: '💦', label: 'あせる' },
    { type: 'zzz',          emoji: '💤', label: 'おやすみ' },
  ];
  const EXTRA_REACTION_TYPES = EXTRA_REACTIONS.map(r => r.type);

  // 基本 5 種 → 拡張パレットの順（表示順・サマリのピルの並び順）
  const ALL_REACTIONS = REACTIONS.concat(EXTRA_REACTIONS);
  const ALL_REACTION_TYPES = ALL_REACTIONS.map(r => r.type);
  // type → 絵文字 / 言葉（基本＋拡張の全部。通知の文面などはこれを引く）
  const REACTION_EMOJI = Object.fromEntries(ALL_REACTIONS.map(r => [r.type, r.emoji]));
  const REACTION_LABEL = Object.fromEntries(ALL_REACTIONS.map(r => [r.type, r.label]));

  // DB の形式 CHECK と同じ規則（type を足すときの自己チェック用）
  const REACTION_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

  // つぶやき（本体・返信）で受け付ける種別か（基本＋拡張）
  function isReactionType(type) {
    return ALL_REACTION_TYPES.includes(String(type || ''));
  }
  // 基本 5 種か（作品ギャラリーはこちらだけ）
  function isBaseReactionType(type) {
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
  // 拡張パレットは作品ギャラリーには（今は）出さない。ADR 044 参照。
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
    REACTIONS, REACTION_TYPES,
    EXTRA_REACTIONS, EXTRA_REACTION_TYPES,
    ALL_REACTIONS, ALL_REACTION_TYPES,
    REACTION_EMOJI, REACTION_LABEL, REACTION_TYPE_PATTERN,
    isReactionType, isBaseReactionType,
    PORTFOLIO_REACTIONS, PORTFOLIO_LABEL, PORTFOLIO_PRIMARY,
  };
});

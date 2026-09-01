// utils/portfolio-genre.js
// =====================================================
// 作品ギャラリー（ポートフォリオ）の「系統」まわりの純関数。
//
// 系統は 2 軸ある。
//
//   1) 業種軸（genre）… 「金融・保険」「教育・スクール」など、クライアントの業種。
//      値は区分マスター（master_categories.code='portfolio_genres'）で管理する。
//      持ち主は clients.portfolio_genre_code。作品側 creatives.portfolio_genre_code は
//      「その作品だけ例外的に別業種」のときの上書きで、NULL ならクライアントを継承する。
//
//   2) 表現軸（style）… 「縦型ショート動画」「バナー」など、作品の見た目の系統。
//      creative_type と向き（portrait/square/landscape）から機械的に導出できるので、
//      DB には持たず毎回導出する。creatives.portfolio_style_code に値が入っている
//      ときだけ、その値で上書きする（＝自動では判定できない作風を人が付けたケース）。
//
// 表現軸の値が「自動で付くもの」と「人が付けるもの」に分かれているのは、
// 実写／アニメーション／インタビュー／UGC風といった作風が、DB にもファイル名にも
// 手がかりが無く自動判定できないため。自動導出はフォーマット（縦型ショート・バナー等）
// までに留め、作風は上書きで足せるようにしてある。
//
// routes/haruka.js から使う。純関数なのでテスト対象（tests/utils/portfolio-genre.test.js）。
// =====================================================

// 表現軸の値。auto:true は creative_type から自動導出される値、
// auto:false は「人が上書きで付けるだけ」の作風（自動では絶対に付かない）。
const PORTFOLIO_STYLES = [
  { code: 'vertical_short',  name: '縦型ショート動画',  auto: true },
  { code: 'square_video',    name: '正方形動画',        auto: true },
  { code: 'wide_video',      name: '横型動画',          auto: true },
  { code: 'long_video',      name: 'ロング動画',        auto: true },
  { code: 'banner',          name: 'バナー',            auto: true },
  { code: 'sns_post',        name: 'SNS投稿画像',       auto: true },
  { code: 'story',           name: 'ストーリーズ',      auto: true },
  { code: 'thumbnail',       name: 'サムネイル',        auto: true },
  { code: 'web',             name: 'LP・Webサイト',     auto: true },
  { code: 'graphic',         name: 'その他の静止画',    auto: true },
  { code: 'other_style',     name: 'その他',            auto: true },
  // ここから下は自動判定できない作風。作品ごとの上書きでのみ付く。
  { code: 'live_action',     name: '実写',              auto: false },
  { code: 'motion_graphics', name: 'アニメーション・モーショングラフィックス', auto: false },
  { code: 'interview',       name: 'インタビュー',      auto: false },
  { code: 'ugc',             name: 'UGC風',             auto: false },
  { code: 'illustration',    name: 'イラスト・キャラクター', auto: false },
];

const PORTFOLIO_STYLE_MAP = new Map(PORTFOLIO_STYLES.map(s => [s.code, s]));

/**
 * creative_type と向きから表現軸を導出する。
 * @param {string|null} creativeType creatives.creative_type
 * @param {'portrait'|'square'|'landscape'|null} orientation portfolioOrientation() の戻り値
 * @returns {string} PORTFOLIO_STYLES の code（判定不能なら 'other_style'）
 */
function derivePortfolioStyle(creativeType, orientation) {
  const t = String(creativeType || '').toLowerCase();
  if (!t) return 'other_style';

  if (t.startsWith('video')) {
    // ロング動画は向きに関係なく「ロング動画」（尺の系統が見た目より優先）
    if (t === 'video_long') return 'long_video';
    if (orientation === 'portrait') return 'vertical_short';
    if (orientation === 'square')   return 'square_video';
    return 'wide_video';
  }
  // LP / HP は creative_type にプレフィックスが無い（一覧 API と同じ扱い）
  if (t === 'lp' || t === 'hp' || t.startsWith('design_lp') || t.startsWith('design_hp')) return 'web';
  if (t === 'design_banner')    return 'banner';
  if (t === 'design_post')      return 'sns_post';
  if (t === 'design_story')     return 'story';
  if (t === 'design_thumbnail') return 'thumbnail';
  if (t.startsWith('design'))   return 'graphic';
  return 'other_style';
}

/**
 * 作品 1 件の表現軸を解決する。上書きがあればそれを、無ければ自動導出を使う。
 * 上書きの code が未知の値（マスターから消えた等）なら自動導出にフォールバックする。
 * @param {{ style_override?:string|null, creative_type?:string|null, orientation?:string|null }} arg
 * @returns {{ code:string, name:string, overridden:boolean }}
 */
function resolvePortfolioStyle({ style_override, creative_type, orientation } = {}) {
  const ov = String(style_override || '').trim();
  if (ov && PORTFOLIO_STYLE_MAP.has(ov)) {
    return { code: ov, name: PORTFOLIO_STYLE_MAP.get(ov).name, overridden: true };
  }
  const code = derivePortfolioStyle(creative_type, orientation);
  return { code, name: PORTFOLIO_STYLE_MAP.get(code)?.name || 'その他', overridden: false };
}

/**
 * 作品 1 件の業種軸を解決する。作品の上書き → クライアント継承 の順。
 * どちらも無ければ null（＝未設定。画面では「未設定」チップに集まる）。
 * @param {{ creative_genre?:string|null, client_genre?:string|null, genreNameMap?:Map<string,string> }} arg
 * @returns {{ code:string|null, name:string|null, overridden:boolean }}
 */
function resolvePortfolioGenre({ creative_genre, client_genre, genreNameMap } = {}) {
  const own = String(creative_genre || '').trim();
  const inherited = String(client_genre || '').trim();
  const code = own || inherited || null;
  if (!code) return { code: null, name: null, overridden: false };
  return {
    code,
    name: genreNameMap?.get(code) || code,
    overridden: !!own && own !== inherited,
  };
}

module.exports = {
  PORTFOLIO_STYLES,
  PORTFOLIO_STYLE_MAP,
  derivePortfolioStyle,
  resolvePortfolioStyle,
  resolvePortfolioGenre,
};

// utils/portfolio-aspect.js
// =====================================================
// 作品ギャラリー（ポートフォリオ）の縦横比まわりの純関数。
//
// レーン分け（縦 9:16 / 正方 1:1 / 横 16:9）の判定はここに集約する。
// routes/haruka.js から使う。純関数なのでテスト対象（tests/portfolio-aspect.test.js）。
// =====================================================

/**
 * 「1920x1080」「9:16」「縦型」等の表記から縦横比を推定する。
 * サイズ区分マスター（master_categories.code='sizes'）の code / name と
 * creatives.creative_size の生値の両方を受ける想定。
 * @param {string|null} text
 * @returns {{w:number,h:number}|null} 読み取れなければ null
 */
function parsePortfolioAspect(text) {
  if (!text) return null;
  const s = String(text).trim();
  // 1920x1080 / 1080×1350 / 1080＊1920
  let m = s.match(/(\d{2,5})\s*[x×✕*＊]\s*(\d{2,5})/i);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  // 1080_1920 / 1080-1920 — 本番の creatives.creative_size はこの形式（アンダースコア区切り）。
  // 3桁以上に限定しているのは「ap003_1080」のような連番との誤マッチを避けるため。
  m = s.match(/(\d{3,5})\s*[_\-]\s*(\d{3,5})/);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  // 9:16 / 16：9
  m = s.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  // 呼称ベース（マスターに「縦型」「スクエア」等しか入っていないケース）
  if (/(縦|vertical|portrait|story|リール|reel|shorts)/i.test(s)) return { w: 9,  h: 16 };
  if (/(正方|スクエア|square)/i.test(s))                          return { w: 1,  h: 1  };
  if (/(横|landscape|horizontal|wide|ワイド)/i.test(s))           return { w: 16, h: 9  };
  return null;
}

/**
 * 比率 → レーン。判定不能（null / 0）は横レーンに寄せる（既定レーン）。
 * 閾値: r <= 0.9 縦 / r < 1.15 正方 / それ以外 横
 *   4:5 (0.8)=縦、1:1 (1.0)=正方、16:9 (1.78)=横、5:4 (1.25)=横
 * @returns {'portrait'|'square'|'landscape'}
 */
function portfolioOrientation(w, h) {
  if (!w || !h) return 'landscape';
  const r = Number(w) / Number(h);
  if (r <= 0.9)  return 'portrait';
  if (r <  1.15) return 'square';
  return 'landscape';
}

module.exports = { parsePortfolioAspect, portfolioOrientation };

// routes/promo-public.js
// =============================================================
// 🎬 プロモ動画の紹介ページ（ADR 056 §4）— ログイン不要
//
// mount: server.js で app.use('/pv', require('./routes/promo-public')) を
//        セッション・認証ミドルウェアより前に置く（相手はメンバーではないので）。
//
// - URL は /pv/<token>（推測できない token）。HTML はここで組み立てる
// - 動画は YouTube / Vimeo の埋め込み。HFS の回線は使わない
// - 開かれた回数と初回日時を記録する（リンクのプレビューを作るロボットは数えない）
// - 検索エンジンに載せない（noindex）
// =============================================================

const express = require('express');

const supabase = require('../supabase');
const S = require('../utils/sales');

const router = express.Router();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (v) => esc(v).replace(/\n/g, '<br>');

function shell({ title, body, status = 200 }) {
  return { status, html: `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(title)}</title>
<style>
  :root { --bg:#0f1113; --panel:#181b1f; --text:#f2f3f5; --sub:#a4abb5; --line:#2a2f36; --accent:#e9c46a; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f5f2; --panel:#ffffff; --text:#1b1d21; --sub:#5d6570; --line:#e3e1dc; --accent:#9a6b00; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif; line-height:1.8; -webkit-text-size-adjust:100%; }
  .wrap { max-width:960px; margin:0 auto; padding:40px 16px 64px; }
  .brand { letter-spacing:.24em; font-size:12px; color:var(--accent); font-weight:700; }
  h1 { font-size:clamp(22px,4.6vw,32px); line-height:1.4; margin:8px 0 0; text-wrap:balance; }
  .greeting { margin:20px 0 0; color:var(--sub); font-size:15px; max-width:42em; }
  .videos { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr)); gap:28px 24px; margin-top:36px; }
  .video h2 { font-size:16px; margin:12px 0 0; line-height:1.5; }
  .video p { margin:4px 0 0; font-size:14px; color:var(--sub); }
  .frame { position:relative; aspect-ratio:16/9; background:#000; border-radius:10px; overflow:hidden; border:1px solid var(--line); }
  .frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .link { display:flex; align-items:center; justify-content:center; aspect-ratio:16/9; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--text); text-decoration:none; font-weight:700; padding:16px; text-align:center; }
  .link:hover { border-color:var(--accent); }
  footer { margin-top:56px; padding-top:20px; border-top:1px solid var(--line); font-size:13px; color:var(--sub); }
  .empty { padding:64px 0; text-align:center; color:var(--sub); }
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>` };
}

const notFound = () => shell({
  status: 404,
  title: 'ページが見つかりません',
  body: '<div class="brand">HARUKA FILM</div><div class="empty">このページは公開を終了したか、URL が正しくありません。<br>お手数ですが、お送りした担当者までご連絡ください。</div>',
});

function send(res, page) {
  res.status(page.status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.send(page.html);
}

function videoBlock(v) {
  const embed = S.videoEmbedUrl(v);
  const media = embed
    ? `<div class="frame"><iframe src="${esc(embed)}" title="${esc(v.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
    : `<a class="link" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">▶ 動画を開く</a>`;
  return `<section class="video">${media}<h2>${esc(v.title)}</h2>${v.description ? `<p>${nl2br(v.description)}</p>` : ''}</section>`;
}

router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!S.isValidPageToken(token)) return send(res, notFound());
    const { data: page, error } = await supabase.from('sales_promo_pages')
      .select('id, title, greeting, video_ids, view_count, first_viewed_at, revoked_at').eq('token', token).maybeSingle();
    if (error) throw error;
    if (!page || page.revoked_at) return send(res, notFound());

    const ids = Array.isArray(page.video_ids) ? page.video_ids : [];
    const { data: rows, error: vErr } = ids.length
      ? await supabase.from('sales_promo_videos').select('id, title, url, provider, embed_id, description').in('id', ids)
      : { data: [] };
    if (vErr) throw vErr;
    const byId = new Map((rows || []).map((v) => [String(v.id), v]));
    const videos = ids.map((id) => byId.get(String(id))).filter(Boolean);

    // 開封の記録。?preview=1（メンバーが自分で確かめるとき）とロボットは数えない。失敗してもページは出す
    if (req.query.preview !== '1' && !S.isBotUserAgent(req.get('user-agent'))) {
      const now = new Date().toISOString();
      supabase.from('sales_promo_pages').update({
        view_count: (Number(page.view_count) || 0) + 1,
        first_viewed_at: page.first_viewed_at || now,
        last_viewed_at: now,
      }).eq('id', page.id).then(({ error: uErr }) => { if (uErr) console.warn('[promo-public] 開封記録に失敗:', uErr.message); });
    }

    send(res, shell({
      title: page.title || 'HARUKA FILM 作品のご紹介',
      body: `<div class="brand">HARUKA FILM</div>
<h1>${esc(page.title || 'HARUKA FILM 作品のご紹介')}</h1>
${page.greeting ? `<p class="greeting">${nl2br(page.greeting)}</p>` : ''}
${videos.length ? `<div class="videos">${videos.map(videoBlock).join('')}</div>` : '<div class="empty">ご紹介できる動画がありません。</div>'}
<footer>HARUKA FILM ｜ <a href="https://harukafilm.com" style="color:inherit" rel="noopener">harukafilm.com</a></footer>`,
    }));
  } catch (e) {
    console.error('[promo-public] error:', e);
    send(res, shell({ status: 503, title: 'しばらくお待ちください', body: '<div class="brand">HARUKA FILM</div><div class="empty">ただいまページを表示できません。少し時間をおいて、もう一度お試しください。</div>' }));
  }
});

module.exports = router;

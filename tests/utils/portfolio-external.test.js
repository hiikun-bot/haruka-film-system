const ext = require('../../utils/portfolio-external');

describe('detectExternalSource', () => {
  test('YouTube の各形式を youtube と判定し ID を取る', () => {
    const cases = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ];
    for (const url of cases) {
      const r = ext.detectExternalSource(url);
      expect(r.type).toBe('youtube');
      expect(r.youtube_id).toBe('dQw4w9WgXcQ');
    }
  });
  test('Google ドライブのファイル共有 URL を drive と判定し ID を取る', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const cases = [
      `https://drive.google.com/file/d/${id}/view?usp=sharing`,
      `https://drive.google.com/open?id=${id}`,
      `https://drive.google.com/uc?id=${id}&export=download`,
      `https://docs.google.com/file/d/${id}/edit`,
    ];
    for (const url of cases) {
      const r = ext.detectExternalSource(url);
      expect(r.type).toBe('drive');
      expect(r.drive_file_id).toBe(id);
    }
  });
  test('Drive のフォルダ URL は drive_folder（登録不可の案内用）', () => {
    expect(ext.detectExternalSource('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv').type).toBe('drive_folder');
  });
  test('その他の http(s) は link、URL でなければ null', () => {
    expect(ext.detectExternalSource('https://vimeo.com/123456').type).toBe('link');
    expect(ext.detectExternalSource('https://example.com/work/lp').type).toBe('link');
    expect(ext.detectExternalSource('ftp://example.com/x').type).toBe(null);
    expect(ext.detectExternalSource('こんにちは').type).toBe(null);
    expect(ext.detectExternalSource('').type).toBe(null);
  });
  test('YouTube らしいが ID が 11 文字でないものは youtube にしない', () => {
    expect(ext.detectExternalSource('https://www.youtube.com/watch?v=short').type).toBe('link');
    expect(ext.detectExternalSource('https://www.youtube.com/@channel').type).toBe('link');
  });
});

describe('youtubeOrientationHint', () => {
  test('Shorts は縦', () => {
    expect(ext.youtubeOrientationHint('https://www.youtube.com/shorts/dQw4w9WgXcQ', { width: 200, height: 113 })).toBe('portrait');
  });
  test('oEmbed の縦横で判定、無ければ横', () => {
    expect(ext.youtubeOrientationHint('https://youtu.be/dQw4w9WgXcQ', { width: 200, height: 356 })).toBe('portrait');
    expect(ext.youtubeOrientationHint('https://youtu.be/dQw4w9WgXcQ', { width: 200, height: 200 })).toBe('square');
    expect(ext.youtubeOrientationHint('https://youtu.be/dQw4w9WgXcQ', { width: 200, height: 113 })).toBe('landscape');
    expect(ext.youtubeOrientationHint('https://youtu.be/dQw4w9WgXcQ', null)).toBe('landscape');
  });
});

describe('mediaKindFromMime / externalCreativeType / orientationOf', () => {
  test('MIME → media_kind', () => {
    expect(ext.mediaKindFromMime('video/mp4')).toBe('video');
    expect(ext.mediaKindFromMime('image/png')).toBe('image');
    expect(ext.mediaKindFromMime('application/pdf')).toBe(null);
  });
  test('media_kind → 擬似 creative_type（derivePortfolioStyle に流す）', () => {
    const { derivePortfolioStyle } = require('../../utils/portfolio-genre');
    expect(derivePortfolioStyle(ext.externalCreativeType('video'), 'portrait')).toBe('vertical_short');
    expect(derivePortfolioStyle(ext.externalCreativeType('video'), 'landscape')).toBe('wide_video');
    expect(derivePortfolioStyle(ext.externalCreativeType('image'), 'square')).toBe('graphic');
    expect(derivePortfolioStyle(ext.externalCreativeType('web'), null)).toBe('web');
  });
  test('orientationOf は作品ページと同じしきい値', () => {
    expect(ext.orientationOf(1080, 1920)).toBe('portrait');
    expect(ext.orientationOf(1080, 1080)).toBe('square');
    expect(ext.orientationOf(1920, 1080)).toBe('landscape');
    expect(ext.orientationOf(0, 100)).toBe(null);
  });
});

describe('sanitizeAiSuggestion', () => {
  const opts = { genreCodes: ['education', 'ec_d2c'], styleCodes: ['vertical_short', 'interview'] };
  test('許可された code だけ通し、未知は null', () => {
    const r = ext.sanitizeAiSuggestion({
      title: '  1級土木施工 対策動画 ', description: 'x'.repeat(600), client_name: 'ひげごろーさん',
      genre_code: 'education', style_code: 'anime', media_kind: 'VIDEO', tags: ['#土木', '', 5], confidence: 0.8,
    }, opts);
    expect(r.title).toBe('1級土木施工 対策動画');
    expect(r.description.length).toBe(500);
    expect(r.client_name).toBe('ひげごろーさん');
    expect(r.genre_code).toBe('education');
    expect(r.style_code).toBe(null);
    expect(r.media_kind).toBe('video');
    expect(r.tags).toEqual(['#土木', '5']);
    expect(r.confidence).toBe(0.8);
  });
  test('壊れた入力でも落ちない', () => {
    expect(ext.sanitizeAiSuggestion(null, opts).title).toBe(null);
    expect(ext.sanitizeAiSuggestion('x', opts).genre_code).toBe(null);
    expect(ext.sanitizeAiSuggestion({ confidence: 3 }, opts).confidence).toBe(null);
  });
});

describe('normalizeExternalWorkInput', () => {
  test('新規はタイトル必須・既定 media_kind=video', () => {
    expect(ext.normalizeExternalWorkInput({}).ok).toBe(false);
    const r = ext.normalizeExternalWorkInput({ title: 'A', produced_at: '2026-09-01', aspect_w: '1080', aspect_h: 1920 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ title: 'A', media_kind: 'video', produced_at: '2026-09-01', aspect_w: 1080, aspect_h: 1920,
      description: null, client_name: null, portfolio_genre_code: null, portfolio_style_code: null });
  });
  test('部分更新は渡したキーだけ', () => {
    const r = ext.normalizeExternalWorkInput({ description: 'メモ' }, { partial: true });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ description: 'メモ' });
  });
  test('不正な値は弾く', () => {
    expect(ext.normalizeExternalWorkInput({ title: 'A', media_kind: 'audio' }).ok).toBe(false);
    expect(ext.normalizeExternalWorkInput({ title: 'A', produced_at: '2026/09/01' }).ok).toBe(false);
    expect(ext.normalizeExternalWorkInput({ title: 'A', produced_at: '' }).data.produced_at).toBe(null);
  });
});

describe('canEditExternalWork', () => {
  const work = { owner_user_id: 'u1' };
  test('本人は編集可（ロール不問）', () => {
    expect(ext.canEditExternalWork({ roleCodes: ['editor'], userId: 'u1', work })).toBe(true);
  });
  test('admin は編集可、他人は不可', () => {
    expect(ext.canEditExternalWork({ roleCodes: ['admin'], userId: 'u9', work })).toBe(true);
    expect(ext.canEditExternalWork({ roleCodes: ['producer', 'director'], userId: 'u9', work })).toBe(false);
    expect(ext.canEditExternalWork({ roleCodes: ['admin'], userId: 'u9', work: null })).toBe(false);
  });
});

describe('YouTube URL helpers / parseOpenGraph', () => {
  test('embed / thumb / watch', () => {
    expect(ext.youtubeEmbedUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(ext.youtubeThumbUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(ext.youtubeEmbedUrl('<script>')).toBe(null);
    expect(ext.youtubeWatchUrl('dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(ext.youtubeWatchUrl('dQw4w9WgXcQ', null)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
  test('OGP を拾う（属性順が逆でも・entity も）', () => {
    const html = `<html><head><title>Fallback &amp; Title</title>
      <meta property="og:title" content="作品LP &quot;春&quot;">
      <meta content="https://ex.com/og.jpg" property="og:image">
      <meta name="description" content="説明文"></head></html>`;
    const r = ext.parseOpenGraph(html);
    expect(r.title).toBe('作品LP "春"');
    expect(r.image).toBe('https://ex.com/og.jpg');
    expect(r.description).toBe('説明文');
    expect(ext.parseOpenGraph('<title>Only &amp; T</title>').title).toBe('Only & T');
    expect(ext.parseOpenGraph('').title).toBe(null);
  });
});

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
  // ADR 015: 最低 3 ロール（admin・director・editor）× 本人／他人の出し分け
  test.each([
    // [実効ロール, 本人の作品, 期待]
    [['admin'], true, true], [['admin'], false, true],
    [['director'], true, true], [['director'], false, false],
    [['editor'], true, true], [['editor'], false, false],
    [['producer_director'], false, false], [['secretary'], false, false],
  ])('ロール %j・本人の作品=%s → 編集可=%s', (roleCodes, own, expected) => {
    expect(ext.canEditExternalWork({ roleCodes, userId: own ? 'u1' : 'u9', work })).toBe(expected);
  });
  test('VIEW AS: admin が editor として見ている（実効ロール editor）ときは他人の作品を編集できない', () => {
    expect(ext.canEditExternalWork({ roleCodes: ['editor'], userId: 'admin-1', work })).toBe(false);
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
  test('parseOpenGraph はアポストロフィで切れず、16 進の文字参照も戻す', () => {
    expect(ext.parseOpenGraph(`<meta property="og:title" content="Tom's Coffee | LP">`).title).toBe("Tom's Coffee | LP");
    expect(ext.parseOpenGraph(`<meta content='Say "hi"' property='og:title'>`).title).toBe('Say "hi"');
    expect(ext.parseOpenGraph('<meta property="og:title" content="Tom&#x27;s">').title).toBe("Tom's");
  });
});

// ===== ADR 045 追補 2026-11-24（安全ガード・メンバー欄 URL との橋渡し） =====
describe('parseOpenGraph の数値参照', () => {
  test('範囲外のコードポイントでも落ちない', () => {
    const r = ext.parseOpenGraph('<meta property="og:title" content="A&#99999999;B&#65;">');
    expect(r.title).toBe('A&#99999999;BA');
  });
});

describe('isOwnPortfolioUpload（直送ファイルが本人の置き場・本人の印か）', () => {
  const meta = { parents: ['folderA'], appProperties: { hfs_kind: 'portfolio_external', hfs_owner_id: 'u1' } };
  test('置き場と印が本人なら true', () => {
    expect(ext.isOwnPortfolioUpload(meta, { folderId: 'folderA', userId: 'u1' })).toBe(true);
  });
  test('別のフォルダ（HFS の他のファイル）なら false', () => {
    expect(ext.isOwnPortfolioUpload({ ...meta, parents: ['invoices'] }, { folderId: 'folderA', userId: 'u1' })).toBe(false);
  });
  test('同じ置き場でも他人の印なら false（同じニックネームの人のファイル）', () => {
    expect(ext.isOwnPortfolioUpload(meta, { folderId: 'folderA', userId: 'u2' })).toBe(false);
  });
  test('印が無いファイル（手で置かれたもの）は false', () => {
    expect(ext.isOwnPortfolioUpload({ parents: ['folderA'] }, { folderId: 'folderA', userId: 'u1' })).toBe(false);
  });
  test('名前で引いた置き場と違っても、候補の置き場（🌐 直下）に入っていれば true', () => {
    expect(ext.isOwnPortfolioUpload({ ...meta, parents: ['folderB'] }, { folderId: 'folderA', folderIds: ['folderB'], userId: 'u1' })).toBe(true);
    expect(ext.isOwnPortfolioUpload({ ...meta, parents: ['folderB'] }, { folderId: 'folderA', folderIds: [], userId: 'u1' })).toBe(false);
  });
  test('置き場が分からないときは false', () => {
    expect(ext.isOwnPortfolioUpload(meta, { folderId: null, userId: 'u1' })).toBe(false);
    expect(ext.isOwnPortfolioUpload(null, { folderId: 'folderA', userId: 'u1' })).toBe(false);
  });
});

describe('isHfsInternalDriveFile（HFS 自身の Drive のファイルか）', () => {
  test('HFS の共有ドライブに入っていれば true', () => {
    expect(ext.isHfsInternalDriveFile({ driveId: 'D1', ownedByMe: false }, 'D1')).toBe(true);
  });
  test('サービスアカウントが持ち主（マイドライブ運用）なら true', () => {
    expect(ext.isHfsInternalDriveFile({ driveId: null, ownedByMe: true }, null)).toBe(true);
  });
  test('外部の人がマイドライブから共有してくれたファイルは false', () => {
    expect(ext.isHfsInternalDriveFile({ driveId: null, ownedByMe: false }, 'D1')).toBe(false);
  });
  test('ルート以外の共有ドライブ（素材広場など SA が入っている置き場）も true', () => {
    expect(ext.isHfsInternalDriveFile({ driveId: 'OTHER', ownedByMe: false }, 'D1')).toBe(true);
  });
  test('持ち主が申請者以外の HFS メンバーなら true（請求書フォルダなど）', () => {
    expect(ext.isHfsInternalDriveFile({ driveId: null, ownedByMe: false }, 'D1', { ownerIsOtherMember: true })).toBe(true);
  });
});

describe('comparableUrl（同じ作品の URL か）', () => {
  test('YouTube は watch / youtu.be / shorts を同じとみなす', () => {
    const a = ext.comparableUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3');
    expect(a).toBe('yt:dQw4w9WgXcQ');
    expect(ext.comparableUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(a);
    expect(ext.comparableUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(a);
  });
  test('Drive はファイル ID で比べる', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(ext.comparableUrl(`https://drive.google.com/file/d/${id}/view?usp=sharing`)).toBe(`drive:${id}`);
    expect(ext.comparableUrl(`https://drive.google.com/open?id=${id}`)).toBe(`drive:${id}`);
  });
  test('その他は www・末尾スラッシュ・# を無視する', () => {
    expect(ext.comparableUrl('https://www.Example.com/lp/')).toBe(ext.comparableUrl('https://example.com/lp#top'));
    expect(ext.comparableUrl('https://example.com/lp?a=1')).not.toBe(ext.comparableUrl('https://example.com/lp'));
  });
  test('URL でなければ null', () => {
    expect(ext.comparableUrl('javascript:alert(1)')).toBe(null);
    expect(ext.comparableUrl('')).toBe(null);
  });
});

describe('createInspectTokenStore（読み取り結果をサーバーが覚える）', () => {
  const mk = (t0 = 1000) => {
    let now = t0, n = 0;
    const store = ext.createInspectTokenStore({ ttlMs: 100, max: 3, now: () => now, randomToken: () => `tok${++n}` });
    return { store, tick: (ms) => { now += ms; } };
  };
  test('本人なら取り出せる・他人や token 違いは null', () => {
    const { store } = mk();
    const tok = store.put('u1', { source: { source_type: 'youtube' } });
    expect(store.get(tok, 'u1')).toEqual({ source: { source_type: 'youtube' } });
    expect(store.get(tok, 'u2')).toBe(null);
    expect(store.get('nope', 'u1')).toBe(null);
    expect(store.get(tok, null)).toBe(null);
  });
  test('期限が切れたら null', () => {
    const { store, tick } = mk();
    const tok = store.put('u1', { a: 1 });
    tick(101);
    expect(store.get(tok, 'u1')).toBe(null);
  });
  test('remove で消える（二重登録しない）', () => {
    const { store } = mk();
    const tok = store.put('u1', { a: 1 });
    store.remove(tok);
    expect(store.get(tok, 'u1')).toBe(null);
  });
  test('上限を超えたら古いものから捨てる', () => {
    const { store } = mk();
    const t1 = store.put('u1', 1); store.put('u1', 2); store.put('u1', 3); const t4 = store.put('u1', 4);
    expect(store.size()).toBeLessThanOrEqual(3);
    expect(store.get(t1, 'u1')).toBe(null);
    expect(store.get(t4, 'u1')).toBe(4);
  });
  test('既定の token は推測しにくい 32 桁', () => {
    const store = ext.createInspectTokenStore();
    expect(store.put('u1', {})).toMatch(/^[0-9a-f]{32}$/);
  });
});

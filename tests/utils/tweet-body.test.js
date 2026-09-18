const { normalizeTweetBody } = require('../../utils/tweet-body');

describe('normalizeTweetBody（つぶやき本文の改行正規化・バグ報告 7374bea4）', () => {
  test('CRLF を LF に戻す（multipart 送信でブラウザが CRLF 化した本文）', () => {
    expect(normalizeTweetBody('あ\r\nい\r\nう')).toBe('あ\nい\nう');
  });

  test('単独の CR も LF にする', () => {
    expect(normalizeTweetBody('あ\rい')).toBe('あ\nい');
  });

  test('画面で 280 字ちょうど（改行 5 つ）の本文は、CRLF 化されて届いても 280 字と数える', () => {
    // 画面上の本文: 275 文字 + 改行 5 つ = 280（textarea.value.length）
    const screenBody = ['あ'.repeat(55), 'い'.repeat(55), 'う'.repeat(55), 'え'.repeat(55), 'お'.repeat(55)].join('\n') + '\n';
    expect(screenBody.length).toBe(280);
    // ブラウザの FormData 送信で改行が CRLF になった状態（サーバーが受け取る形）
    const wireBody = screenBody.replace(/\n/g, '\r\n');
    expect(wireBody.length).toBe(285);
    // 末尾の改行は trim で落ちるため 279 になる（画面側も trim してから判定している）
    const normalized = normalizeTweetBody(wireBody);
    expect(normalized.length).toBeLessThanOrEqual(280);
    expect(normalized).toBe(screenBody.trim());
  });

  test('前後の空白・改行は落とす／null・undefined は空文字', () => {
    expect(normalizeTweetBody('  こんにちは \r\n')).toBe('こんにちは');
    expect(normalizeTweetBody(null)).toBe('');
    expect(normalizeTweetBody(undefined)).toBe('');
  });
});

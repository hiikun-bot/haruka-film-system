// tests/utils/contract-hash.test.js
// 契約管理（ADR 035）utils/contract-hash.js の純関数テスト（SHA-256・ハッシュチェーン）。

const { sha256Hex, canonicalJson, buildConsentRecordHash, verifyChain } = require('../../utils/contract-hash');

const base = {
  member_contract_id: 'mc-1',
  user_id: 'u-1',
  document_version_id: 'v-1',
  consent_kind: 'agreed',
  signer_name_typed: '髙橋 聖',
  consented_at: '2026-09-07T01:02:03.123Z',
  ip_address: '203.0.113.5',
  user_agent: 'Mozilla/5.0',
  pdf_sha256: 'a'.repeat(64),
  body_sha256: null,
  fill_snapshot: { party_code: 'haruka_film_inc', member_full_name: '髙橋 聖' },
};

describe('sha256Hex', () => {
  test('文字列と Buffer で同じ値、既知ベクトル', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('canonicalJson', () => {
  test('キー順に依存しない', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('buildConsentRecordHash', () => {
  test('同じ入力なら同じハッシュ、prev が変わると変わる', () => {
    const h1 = buildConsentRecordHash(base, null);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(buildConsentRecordHash({ ...base }, null)).toBe(h1);
    expect(buildConsentRecordHash(base, 'x'.repeat(64))).not.toBe(h1);
  });
  test('consented_at は表記（+00:00 / Z）が違っても同じ、fill_snapshot はキー順が違っても同じ', () => {
    const h1 = buildConsentRecordHash(base, null);
    const h2 = buildConsentRecordHash({ ...base, consented_at: '2026-09-07T01:02:03.123+00:00' }, null);
    const h3 = buildConsentRecordHash({ ...base, fill_snapshot: { member_full_name: '髙橋 聖', party_code: 'haruka_film_inc' } }, null);
    expect(h2).toBe(h1);
    expect(h3).toBe(h1);
  });
  test('署名者名や IP が変わればハッシュが変わる（改ざん検知）', () => {
    const h1 = buildConsentRecordHash(base, null);
    expect(buildConsentRecordHash({ ...base, signer_name_typed: '髙橋 聖 ' }, null)).not.toBe(h1);
    expect(buildConsentRecordHash({ ...base, ip_address: '203.0.113.6' }, null)).not.toBe(h1);
  });
});

function makeChain() {
  const c1 = { ...base, id: 1, consent_kind: 'viewed', consented_at: '2026-09-07T01:00:00.000Z', signer_name_typed: null, prev_record_hash: null };
  c1.record_hash = buildConsentRecordHash(c1, null);
  const c2 = { ...base, id: 2, consented_at: '2026-09-07T01:05:00.000Z', prev_record_hash: c1.record_hash };
  c2.record_hash = buildConsentRecordHash(c2, c1.record_hash);
  const c3 = { ...base, id: 3, consented_at: '2026-09-07T01:06:00.000Z', prev_record_hash: c2.record_hash };
  c3.record_hash = buildConsentRecordHash(c3, c2.record_hash);
  return [c1, c2, c3];
}

describe('verifyChain', () => {
  test('正しいチェーンは ok（順序が入れ替わっていても consented_at で並べ直す）', () => {
    const chain = makeChain();
    expect(verifyChain(chain)).toEqual({ ok: true, checked: 3, broken_at: null, reason: null });
    expect(verifyChain([chain[2], chain[0], chain[1]]).ok).toBe(true);
    expect(verifyChain([])).toEqual({ ok: true, checked: 0, broken_at: null, reason: null });
  });
  test('途中のレコードが書き換えられると検出する', () => {
    const chain = makeChain();
    chain[1].signer_name_typed = '別人';
    const r = verifyChain(chain);
    expect(r.ok).toBe(false);
    expect(r.broken_at).toBe(1);
  });
  test('prev_record_hash の付け替えを検出する', () => {
    const chain = makeChain();
    chain[2].prev_record_hash = chain[0].record_hash;
    const r = verifyChain(chain);
    expect(r.ok).toBe(false);
    expect(r.broken_at).toBe(2);
  });
});

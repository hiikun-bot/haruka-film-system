// utils/contract-hash.js
// =============================================================
// 契約管理（ADR 035）の同意証跡ハッシュ。純関数・DB 非依存。
//
//   sha256Hex(bufferOrString)            → 64桁 hex
//   buildConsentRecordHash(fields, prev) → record_hash（主要列 + prev_record_hash の SHA-256）
//   verifyChain(consents)                → { ok, checked, broken_at, reason }
//
// record_hash の入力は ADR 記載の列順の JSON 配列:
//   [member_contract_id, user_id, document_version_id, consent_kind, signer_name_typed,
//    consented_at(ISO), ip_address, user_agent, pdf_sha256, body_sha256,
//    fill_snapshot(正規化JSON文字列), prev_record_hash]
// fill_snapshot は Postgres の jsonb がキー順を並べ替えるため、キーを再帰的にソートした
// 正規化 JSON 文字列（canonicalJson）でハッシュする。DB から読み戻しても同じ値になる。
// =============================================================

const crypto = require('crypto');

function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// キー順を固定した JSON 文字列（jsonb 往復で順序が変わっても同じ結果になる）
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function nz(v) {
  return v === undefined || v === '' ? null : v;
}

/**
 * @param {object} f  { member_contract_id, user_id, document_version_id, consent_kind, signer_name_typed,
 *                      consented_at, ip_address, user_agent, pdf_sha256, body_sha256, fill_snapshot }
 * @param {string|null} prevHash 同一 member_contract の直前レコードの record_hash（無ければ null）
 */
function buildConsentRecordHash(f, prevHash) {
  const payload = [
    nz(f.member_contract_id),
    nz(f.user_id),
    nz(f.document_version_id),
    nz(f.consent_kind),
    nz(f.signer_name_typed),
    toIso(f.consented_at),
    nz(f.ip_address),
    nz(f.user_agent),
    nz(f.pdf_sha256),
    nz(f.body_sha256),
    f.fill_snapshot === undefined || f.fill_snapshot === null ? null : canonicalJson(f.fill_snapshot),
    nz(prevHash) || null,
  ];
  return sha256Hex(JSON.stringify(payload));
}

/**
 * 同一 member_contract の同意レコード列（consented_at 昇順）を再計算して検証する。
 * @returns {{ ok: boolean, checked: number, broken_at: number|null, reason: string|null }}
 */
function verifyChain(consents) {
  const list = Array.isArray(consents) ? consents.slice() : [];
  list.sort((a, b) => {
    const ta = new Date(a.consented_at).getTime();
    const tb = new Date(b.consented_at).getTime();
    if (ta !== tb) return ta - tb;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });
  let prev = null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if ((c.prev_record_hash || null) !== prev) {
      return { ok: false, checked: i, broken_at: i, reason: 'prev_record_hash が直前レコードと一致しません' };
    }
    const expected = buildConsentRecordHash(c, prev);
    if (expected !== c.record_hash) {
      return { ok: false, checked: i, broken_at: i, reason: 'record_hash が再計算値と一致しません' };
    }
    prev = c.record_hash;
  }
  return { ok: true, checked: list.length, broken_at: null, reason: null };
}

module.exports = { sha256Hex, canonicalJson, buildConsentRecordHash, verifyChain };

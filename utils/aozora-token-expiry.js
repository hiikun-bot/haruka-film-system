// utils/aozora-token-expiry.js — 銀行 API トークンの有効期限切れ削除（ADR 054 追補）
// =============================================================
// 有効期限を過ぎたアクセストークン／リフレッシュトークンの暗号文（*_enc / *_iv / *_tag）を
// bank_api_connections から物理的に消す（列を NULL にする）。
//
// 行は消さずに列だけ NULL にする理由:
//   - payout_transfer_batches.connection_id / bank_api_audit_logs.connection_id がこの行を参照しており、
//     行を消すと「どの接続で依頼したか」の履歴が切れる（FK は ON DELETE SET NULL）
//   - 秘密情報はトークン列だけで、残る列（口座ラベル・接続者・日時）は台帳として残す価値がある
//
// 判定:
//   - アクセストークン: access_token_expires_at（ISO / TIMESTAMPTZ）を epoch ms で now と比べる。
//     列が無い（NULL）のに暗号文がある行は「期限不明＝期限切れ」とみなす（tokenNeedsRefresh と同じ扱い）
//   - リフレッシュトークン: 認可仕様（認可編 1.8.0 p.6〜7）では再発行時の応答が新規発行と同一で
//     refresh_token が必ず返る＝更新のたびに新しいリフレッシュトークンへ置き換わる。
//     発行時刻 = updated_at（トークン保存時に必ず更新される列）。無ければ connected_at。
//     有効期間は仕様書に明記が無いため AOZORA_REFRESH_TOKEN_TTL_DAYS（既定 90 日）で持つ。
//     実際の期間が分かったら環境変数で合わせる（短めにしておけば「早めに消えて再接続が要る」側に倒れる）
//   - 銀行のトークンエンドポイントが invalid_grant を返した＝そのリフレッシュトークンは銀行側で無効。
//     その場で期限切れとして消す（aozora-api.js の refreshConnectionTokens から呼ぶ）
//   - アクセストークンだけ切れてリフレッシュトークンが有効なら接続は維持（次の利用時に refresh で取り直す）
//   - 両方とも無くなったら revoked_at を立てて「未接続」に戻す（画面は再接続ボタンを出す・API は 未接続 で止まる）
//   - revoked_at 済みの行にトークンが残っていれば消す
//
// 注意: ここでの更新は updated_at を動かさない（updated_at がリフレッシュトークンの発行時刻の目安なので、
//       アクセストークンだけ消したときに更新すると期限が延びてしまう）。
// 時刻はすべて epoch ms / ISO（UTC）で比較する。JST への変換は表示側の仕事。
// =============================================================

const supabase = require('../supabase');

const DAY_MS = 86_400_000;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 90;
const TOKEN_COLUMNS = {
  access: ['access_token_enc', 'access_token_iv', 'access_token_tag'],
  refresh: ['refresh_token_enc', 'refresh_token_iv', 'refresh_token_tag'],
};
const SWEEP_COLUMNS = 'id, provider, environment, access_token_enc, refresh_token_enc, access_token_expires_at, connected_at, revoked_at, updated_at';

function toMs(v) {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** リフレッシュトークンの有効期間（ms）。AOZORA_REFRESH_TOKEN_TTL_DAYS（正の数）か既定 90 日 */
function refreshTokenTtlMs(env = process.env) {
  const n = Number(String(env.AOZORA_REFRESH_TOKEN_TTL_DAYS ?? '').trim());
  const days = Number.isFinite(n) && n > 0 ? n : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  return days * DAY_MS;
}

/** リフレッシュトークンの発行時刻（epoch ms）。updated_at → connected_at の順。どちらも無ければ null */
function refreshTokenIssuedAtMs(conn) {
  return toMs(conn?.updated_at) ?? toMs(conn?.connected_at);
}

/** リフレッシュトークンの推定期限（epoch ms）。発行時刻が分からなければ null（＝期限切れ扱い） */
function refreshTokenExpiresAtMs(conn, ttlMs = refreshTokenTtlMs()) {
  const issued = refreshTokenIssuedAtMs(conn);
  return issued == null ? null : issued + ttlMs;
}

function isAccessTokenExpired(conn, now = Date.now()) {
  if (!conn?.access_token_enc) return false;
  const exp = toMs(conn.access_token_expires_at);
  return exp == null || exp <= now;
}

function isRefreshTokenExpired(conn, now = Date.now(), ttlMs = refreshTokenTtlMs()) {
  if (!conn?.refresh_token_enc) return false;
  const exp = refreshTokenExpiresAtMs(conn, ttlMs);
  return exp == null || exp <= now;
}

/**
 * 1 行について何を消すかを決める（純関数）。消すものが無ければ null。
 * @param {object} conn bank_api_connections 行
 * @param {{ now?: number, ttlMs?: number, refreshRejected?: boolean }} [opts]
 *   refreshRejected: 銀行が invalid_grant を返した（リフレッシュトークンは期限に関係なく無効）
 * @returns {null | { purgeAccess: boolean, purgeRefresh: boolean, revoke: boolean, reason: string }}
 */
function planTokenPurge(conn, { now = Date.now(), ttlMs = refreshTokenTtlMs(), refreshRejected = false } = {}) {
  if (!conn) return null;
  const hasAccess = !!conn.access_token_enc;
  const hasRefresh = !!conn.refresh_token_enc;
  if (conn.revoked_at) {
    if (!hasAccess && !hasRefresh) return null;
    return { purgeAccess: hasAccess, purgeRefresh: hasRefresh, revoke: false, reason: 'revoked' };
  }
  const purgeAccess = isAccessTokenExpired(conn, now);
  const purgeRefresh = hasRefresh && (refreshRejected || isRefreshTokenExpired(conn, now, ttlMs));
  const accessLeft = hasAccess && !purgeAccess;
  const refreshLeft = hasRefresh && !purgeRefresh;
  const revoke = !accessLeft && !refreshLeft;
  if (!purgeAccess && !purgeRefresh && !revoke) return null;
  let reason;
  if (refreshRejected && purgeRefresh) reason = 'refresh_rejected';
  else if (purgeRefresh) reason = 'refresh_token_expired';
  else if (purgeAccess) reason = 'access_token_expired';
  else reason = 'no_tokens';
  return { purgeAccess, purgeRefresh, revoke, reason };
}

/** planTokenPurge の結果から UPDATE の patch を作る（純関数） */
function buildPurgePatch(plan, nowIso = new Date().toISOString()) {
  const patch = {};
  if (plan.purgeAccess) for (const c of TOKEN_COLUMNS.access) patch[c] = null;
  if (plan.purgeRefresh) for (const c of TOKEN_COLUMNS.refresh) patch[c] = null;
  if (plan.revoke) {
    // 未接続に戻す。両方のトークン列を確実に空にする
    for (const c of [...TOKEN_COLUMNS.access, ...TOKEN_COLUMNS.refresh]) patch[c] = null;
    patch.revoked_at = nowIso;
    patch.updated_at = nowIso;
  }
  return patch;
}

/** 監査ログの action（既存の CHECK 制約の範囲で選ぶ）と detail（秘密情報なし） */
function buildAuditEntry(conn, plan, { source, now = Date.now(), ttlMs = refreshTokenTtlMs() } = {}) {
  const purged = [];
  if (plan.purgeAccess || (plan.revoke && conn.access_token_enc)) purged.push('access_token');
  if (plan.purgeRefresh || (plan.revoke && conn.refresh_token_enc)) purged.push('refresh_token');
  const refreshExp = conn.refresh_token_enc ? refreshTokenExpiresAtMs(conn, ttlMs) : null;
  return {
    // 接続が使えなくなる（revoke）／切断済み行の掃除 → disconnect、接続を維持したままの削除 → token_refresh
    action: plan.revoke || plan.reason === 'revoked' ? 'disconnect' : 'token_refresh',
    detail: {
      event: 'expired_token_purged',
      reason: plan.reason,
      purged,
      revoked: !!plan.revoke,
      source: source || null,
      access_token_expires_at: conn.access_token_expires_at || null,
      refresh_token_expires_at_estimated: refreshExp != null ? new Date(refreshExp).toISOString() : null,
      checked_at: new Date(now).toISOString(),
    },
  };
}

async function writeAudit(connId, entry) {
  try {
    const { error } = await supabase.from('bank_api_audit_logs').insert({
      actor_user_id: null,
      action: entry.action,
      connection_id: connId,
      batch_id: null,
      detail: entry.detail,
    });
    if (error) console.warn(`[aozora-token-expiry] 監査ログの保存に失敗 connection=${connId}: ${error.message}`);
  } catch (e) {
    console.warn(`[aozora-token-expiry] 監査ログの保存に失敗 connection=${connId}: ${e.message}`);
  }
}

/**
 * 1 行に削除を適用する。読んだ時点から別プロセスがトークンを更新していたら何もしない
 * （access_token_expires_at と refresh_token_enc の compare-and-set）。
 * @returns {Promise<{ applied: boolean, plan: object|null }>}
 */
async function applyTokenPurge(conn, { now = Date.now(), ttlMs = refreshTokenTtlMs(), refreshRejected = false, source } = {}) {
  const plan = planTokenPurge(conn, { now, ttlMs, refreshRejected });
  if (!plan) return { applied: false, plan: null };
  const patch = buildPurgePatch(plan, new Date(now).toISOString());
  let q = supabase.from('bank_api_connections').update(patch).eq('id', conn.id);
  q = conn.revoked_at ? q.not('revoked_at', 'is', null) : q.is('revoked_at', null);
  q = conn.access_token_expires_at ? q.eq('access_token_expires_at', conn.access_token_expires_at) : q.is('access_token_expires_at', null);
  q = conn.refresh_token_enc ? q.eq('refresh_token_enc', conn.refresh_token_enc) : q.is('refresh_token_enc', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw new Error(`bank_api_connections 期限切れトークンの削除に失敗: ${error.message}`);
  if (!data) return { applied: false, plan }; // 競合（別プロセスが更新・削除済み）
  console.log(`[aozora-token-expiry] 期限切れトークンを削除しました connection=${conn.id} reason=${plan.reason} revoked=${plan.revoke}`);
  await writeAudit(conn.id, buildAuditEntry(conn, plan, { source, now, ttlMs }));
  return { applied: true, plan };
}

/**
 * トークンが残っている全行を見て、期限切れを削除する（定期処理）。
 * @returns {Promise<{ checked: number, purged: number, revoked: number }>}
 */
async function purgeExpiredTokens({ now = Date.now(), ttlMs = refreshTokenTtlMs(), source = 'sweeper' } = {}) {
  const { data, error } = await supabase
    .from('bank_api_connections')
    .select(SWEEP_COLUMNS)
    .or('access_token_enc.not.is.null,refresh_token_enc.not.is.null');
  if (error) throw new Error(`bank_api_connections 取得失敗: ${error.message}`);
  const rows = data || [];
  let purged = 0;
  let revoked = 0;
  for (const row of rows) {
    try {
      const r = await applyTokenPurge(row, { now, ttlMs, source });
      if (r.applied) {
        purged++;
        if (r.plan.revoke) revoked++;
      }
    } catch (e) {
      console.warn(`[aozora-token-expiry] connection=${row.id} の削除に失敗: ${e.message}`);
    }
  }
  return { checked: rows.length, purged, revoked };
}

module.exports = {
  DEFAULT_REFRESH_TOKEN_TTL_DAYS,
  refreshTokenTtlMs,
  refreshTokenIssuedAtMs,
  refreshTokenExpiresAtMs,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  planTokenPurge,
  buildPurgePatch,
  buildAuditEntry,
  applyTokenPurge,
  purgeExpiredTokens,
};

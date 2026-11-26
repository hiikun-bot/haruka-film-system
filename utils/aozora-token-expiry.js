// utils/aozora-token-expiry.js — 銀行 API トークンの有効期限切れ削除（ADR 054 §3-3）
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
//     refresh_token が返る＝更新のたびに新しいリフレッシュトークンへ置き換わる。
//     発行時刻 = updated_at（リフレッシュトークンを保存したときだけ動かす列）。無ければ connected_at。
//     有効期間は仕様書に明記が無いため AOZORA_REFRESH_TOKEN_TTL_DAYS（既定 90 日）で「推定」する。
//     推定期限を過ぎても即は消さず、一度だけリフレッシュを試す（tryRefresh）:
//       受け付けられた → 新しいトークンで継続 / invalid_grant → 消す / 通信失敗など → 次の回にもう一度。
//     銀行で確かめられないまま推定期限から REFRESH_GRACE_MS（7 日）たったら、確かめられなくても消す
//   - 銀行のトークンエンドポイントが invalid_grant を返した＝そのリフレッシュトークンは銀行側で無効。
//     行を読み直し、refresh_token_enc が「送ったトークン」のままのときだけ消す（aozora-api.js の refreshConnectionTokens）。
//     この経路では revoked_at を立てない（未接続化は通常の判定＝enforceRow に任せる）
//   - アクセストークンだけ切れてリフレッシュトークンが有効なら接続は維持（次の利用時に refresh で取り直す）
//   - 両方とも無くなったら revoked_at を立てて「未接続」に戻す（画面は再接続ボタンを出す・API は 未接続 で止まる）。
//     自動で未接続にしたら管理者マイチャットへ一報（トークン値は出さない）
//   - revoked_at 済みの行にトークンが残っていれば消す
//
// 注意: アクセストークンだけ消すときは updated_at を動かさない（updated_at がリフレッシュトークンの発行時刻の目安なので、
//       動かすと推定期限が延びてしまう）。
// 時刻はすべて epoch ms / ISO（UTC）で比較する。JST への変換は表示側の仕事。
// =============================================================

const supabase = require('../supabase');

const DAY_MS = 86_400_000;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 90;
const REFRESH_GRACE_MS = 7 * DAY_MS; // 推定期限後、銀行で確かめられないまま待つ上限
const AUDIT_ACTION = 'disconnect';   // 既存 CHECK 制約の範囲で「トークン破棄」を表す。区別は detail.event / detail.revoked
const PURGE_EVENT = 'expired_token_purged';
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

/** 推定期限を過ぎたか（＝消す前に一度リフレッシュを試す段階） */
function isRefreshTokenStale(conn, now = Date.now(), ttlMs = refreshTokenTtlMs()) {
  if (!conn?.refresh_token_enc) return false;
  const exp = refreshTokenExpiresAtMs(conn, ttlMs);
  return exp == null || exp <= now;
}

/** 推定期限＋猶予も過ぎたか（銀行で確かめられなくても消す） */
function isRefreshTokenHardExpired(conn, now = Date.now(), ttlMs = refreshTokenTtlMs(), graceMs = REFRESH_GRACE_MS) {
  if (!conn?.refresh_token_enc) return false;
  const exp = refreshTokenExpiresAtMs(conn, ttlMs);
  return exp == null || exp + graceMs <= now;
}

/**
 * 1 行について何を消すかを決める（純関数）。何もしなくてよければ null。
 * @param {object} conn bank_api_connections 行
 * @param {{ now?: number, ttlMs?: number, graceMs?: number, refreshRejected?: boolean, noRevoke?: boolean }} [opts]
 *   refreshRejected: 銀行が invalid_grant を返した（リフレッシュトークンは期限に関係なく無効）
 *   noRevoke: 未接続化（revoked_at）はしない（invalid_grant 経路用）
 * @returns {null | { purgeAccess: boolean, purgeRefresh: boolean, revoke: boolean, checkRefresh: boolean, reason: string }}
 *   checkRefresh: リフレッシュトークンが推定期限切れ → 消す前に一度リフレッシュを試す（これだけなら書き込まない）
 */
function planTokenPurge(conn, { now = Date.now(), ttlMs = refreshTokenTtlMs(), graceMs = REFRESH_GRACE_MS, refreshRejected = false, noRevoke = false } = {}) {
  if (!conn) return null;
  const hasAccess = !!conn.access_token_enc;
  const hasRefresh = !!conn.refresh_token_enc;
  if (conn.revoked_at) {
    if (!hasAccess && !hasRefresh) return null;
    return { purgeAccess: hasAccess, purgeRefresh: hasRefresh, revoke: false, checkRefresh: false, reason: 'revoked' };
  }
  const purgeAccess = isAccessTokenExpired(conn, now);
  const purgeRefresh = hasRefresh && (refreshRejected || isRefreshTokenHardExpired(conn, now, ttlMs, graceMs));
  const checkRefresh = hasRefresh && !purgeRefresh && isRefreshTokenStale(conn, now, ttlMs);
  const accessLeft = hasAccess && !purgeAccess;
  const refreshLeft = hasRefresh && !purgeRefresh;
  const revoke = !noRevoke && !accessLeft && !refreshLeft;
  if (!purgeAccess && !purgeRefresh && !revoke && !checkRefresh) return null;
  let reason;
  if (refreshRejected && purgeRefresh) reason = 'refresh_rejected';
  else if (purgeRefresh) reason = 'refresh_token_expired';
  else if (purgeAccess) reason = 'access_token_expired';
  else if (revoke) reason = 'no_tokens';
  else reason = 'refresh_token_stale';
  return { purgeAccess, purgeRefresh, revoke, checkRefresh, reason };
}

/** 列を書き換える計画か（checkRefresh だけなら書き込まない） */
function planWrites(plan) {
  return !!plan && (plan.purgeAccess || plan.purgeRefresh || plan.revoke);
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

/**
 * 監査ログの action と detail（秘密情報なし）。
 * action は既存 CHECK 制約の 'disconnect'（トークン破棄）に揃え、detail.event='expired_token_purged' と
 * detail.revoked（接続が使えなくなったか）で区別する（migration を増やさないため・ADR 054 §3-3）。
 */
function buildAuditEntry(conn, plan, { source, now = Date.now(), ttlMs = refreshTokenTtlMs() } = {}) {
  const purged = [];
  if (plan.purgeAccess || (plan.revoke && conn.access_token_enc)) purged.push('access_token');
  if (plan.purgeRefresh || (plan.revoke && conn.refresh_token_enc)) purged.push('refresh_token');
  const refreshExp = conn.refresh_token_enc ? refreshTokenExpiresAtMs(conn, ttlMs) : null;
  return {
    action: AUDIT_ACTION,
    detail: {
      event: PURGE_EVENT,
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

/** bank_api_audit_logs へ 1 行（失敗してもログだけ・actor なし＝自動処理） */
async function audit({ connectionId, action, detail }) {
  try {
    const { error } = await supabase.from('bank_api_audit_logs').insert({
      actor_user_id: null,
      action,
      connection_id: connectionId,
      batch_id: null,
      detail: detail || null,
    });
    if (error) console.warn(`[aozora-token-expiry] 監査ログの保存に失敗 connection=${connectionId}: ${error.message}`);
  } catch (e) {
    console.warn(`[aozora-token-expiry] 監査ログの保存に失敗 connection=${connectionId}: ${e.message}`);
  }
}

/** 自動で未接続にしたときの管理者マイチャット文面（トークン値・口座番号は出さない） */
function buildRevokedNotice(conn, plan) {
  const env = conn.environment === 'production' ? '本番' : '開発';
  const why = plan.reason === 'refresh_rejected' ? '銀行側でトークンが無効になった' : 'トークンの有効期限が切れた';
  return `[info][title]🏦 銀行API接続が期限切れで切れました[/title]${why}ため、あおぞら銀行 API（${env}）の接続を自動で解除しました。\n振込管理の画面から再接続してください。[/info]`;
}

/** 既定の通知先: 管理者マイチャット（utils/bank-transfer.js#sendAdminMyChat・循環 require を避けて遅延読み込み） */
async function defaultNotifyRevoked(conn, plan) {
  try {
    const bt = require('./bank-transfer');
    await bt.sendAdminMyChat(buildRevokedNotice(conn, plan));
  } catch (e) {
    console.warn(`[aozora-token-expiry] 未接続化の通知に失敗 connection=${conn.id}: ${e.message}`);
  }
}

/**
 * 1 行に削除を適用する。読んだ時点から別プロセスがトークンを更新していたら何もしない
 * （access_token_expires_at と refresh_token_enc の compare-and-set。リフレッシュの HTTP 中の行も、
 *  終わってトークンが置き換われば refresh_token_enc が変わるので上書きしない）。
 * checkRefresh だけの計画（推定期限切れ）は書き込まない＝呼び出し側（enforceRow）が先にリフレッシュを試す。
 * @returns {Promise<{ applied: boolean, plan: object|null }>}
 */
async function applyTokenPurge(conn, { now = Date.now(), ttlMs = refreshTokenTtlMs(), graceMs = REFRESH_GRACE_MS, refreshRejected = false, noRevoke = false, source, notifyRevoked = defaultNotifyRevoked } = {}) {
  const plan = planTokenPurge(conn, { now, ttlMs, graceMs, refreshRejected, noRevoke });
  if (!planWrites(plan)) return { applied: false, plan };
  const patch = buildPurgePatch(plan, new Date(now).toISOString());
  let q = supabase.from('bank_api_connections').update(patch).eq('id', conn.id);
  q = conn.revoked_at ? q.not('revoked_at', 'is', null) : q.is('revoked_at', null);
  q = conn.access_token_expires_at ? q.eq('access_token_expires_at', conn.access_token_expires_at) : q.is('access_token_expires_at', null);
  q = conn.refresh_token_enc ? q.eq('refresh_token_enc', conn.refresh_token_enc) : q.is('refresh_token_enc', null);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw new Error(`bank_api_connections 期限切れトークンの削除に失敗: ${error.message}`);
  if (!data) return { applied: false, plan }; // 競合（別プロセスが更新・削除済み）
  console.log(`[aozora-token-expiry] 期限切れトークンを削除しました connection=${conn.id} reason=${plan.reason} revoked=${plan.revoke}`);
  await audit({ connectionId: conn.id, ...buildAuditEntry(conn, plan, { source, now, ttlMs }) });
  if (plan.revoke && typeof notifyRevoked === 'function') await notifyRevoked(conn, plan);
  return { applied: true, plan };
}

async function reloadRow(id) {
  const { data, error } = await supabase.from('bank_api_connections').select(SWEEP_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`bank_api_connections 再読込に失敗: ${error.message}`);
  return data || null;
}

/**
 * 1 行の期限を通常の判定で処理する（定期処理・接続取得時の共通入口）。
 *   1) リフレッシュトークンが推定期限切れなら、消す前に tryRefresh で一度だけ試す
 *      （'refreshed' → 新トークンで継続 / 'rejected' → invalid_grant 経路で消えている / 'error' → 今回は消さない）
 *   2) 読み直して、期限切れの削除・両方なければ未接続化
 * @param {object} conn
 * @param {{ tryRefresh?: (conn:object)=>Promise<'refreshed'|'rejected'|'error'>, notifyRevoked?: Function, source?: string, now?: number, ttlMs?: number, graceMs?: number }} [opts]
 * @returns {Promise<{ row: object|null, applied: boolean, revoked: boolean, refreshed: boolean }>}
 */
async function enforceRow(conn, opts = {}) {
  const { tryRefresh, now = Date.now(), ttlMs = refreshTokenTtlMs(), graceMs = REFRESH_GRACE_MS } = opts;
  let row = conn;
  let refreshed = false;
  const first = planTokenPurge(row, { now, ttlMs, graceMs });
  if (!first) return { row, applied: false, revoked: false, refreshed };
  if (first.checkRefresh && typeof tryRefresh === 'function') {
    const outcome = await tryRefresh(row);
    refreshed = outcome === 'refreshed';
    row = await reloadRow(row.id);
    if (!row) return { row: null, applied: false, revoked: false, refreshed };
  }
  const r = await applyTokenPurge(row, { ...opts, now, ttlMs, graceMs });
  if (r.applied) row = await reloadRow(row.id);
  return { row, applied: r.applied, revoked: !!(r.applied && r.plan?.revoke), refreshed };
}

/**
 * トークンが残っている全行を見て、期限切れを削除する（定期処理）。
 * @param {object} [opts] enforceRow と同じ（tryRefresh / notifyRevoked / source / now / ttlMs）
 * @returns {Promise<{ checked: number, purged: number, revoked: number, refreshed: number }>}
 */
async function purgeExpiredTokens(opts = {}) {
  const { now = Date.now(), ttlMs = refreshTokenTtlMs(), source = 'sweeper' } = opts;
  const { data, error } = await supabase
    .from('bank_api_connections')
    .select(SWEEP_COLUMNS)
    .or('access_token_enc.not.is.null,refresh_token_enc.not.is.null');
  if (error) throw new Error(`bank_api_connections 取得失敗: ${error.message}`);
  const rows = data || [];
  let purged = 0;
  let revoked = 0;
  let refreshed = 0;
  for (const row of rows) {
    try {
      const r = await enforceRow(row, { ...opts, now, ttlMs, source });
      if (r.applied) purged++;
      if (r.revoked) revoked++;
      if (r.refreshed) refreshed++;
    } catch (e) {
      console.warn(`[aozora-token-expiry] connection=${row.id} の削除に失敗: ${e.message}`);
    }
  }
  return { checked: rows.length, purged, revoked, refreshed };
}

module.exports = {
  DEFAULT_REFRESH_TOKEN_TTL_DAYS,
  REFRESH_GRACE_MS,
  AUDIT_ACTION,
  PURGE_EVENT,
  refreshTokenTtlMs,
  refreshTokenIssuedAtMs,
  refreshTokenExpiresAtMs,
  isAccessTokenExpired,
  isRefreshTokenStale,
  isRefreshTokenHardExpired,
  planTokenPurge,
  buildPurgePatch,
  buildAuditEntry,
  buildRevokedNotice,
  audit,
  applyTokenPurge,
  enforceRow,
  purgeExpiredTokens,
};

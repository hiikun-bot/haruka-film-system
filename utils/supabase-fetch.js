// Supabase HTTP リクエストにタイムアウトとサーキットブレーカーを足す共通 fetch。
// Supabase が Cloudflare 522 などで応答しなくなると、PostgREST クライアントは
// デフォルトでは無制限に待ち続け、Railway 側のワーカーがハングする。これを防ぐ。

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_MS = 30000;

function readPositiveInt(envName, fallback) {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TIMEOUT_MS = readPositiveInt('SUPABASE_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
const FAILURE_THRESHOLD = readPositiveInt('SUPABASE_CB_FAILURE_THRESHOLD', DEFAULT_FAILURE_THRESHOLD);
const OPEN_MS = readPositiveInt('SUPABASE_CB_OPEN_MS', DEFAULT_OPEN_MS);

// closed: 通常運行 / open: 即時 reject / half-open: 1 回だけ通す
const state = {
  status: 'closed',
  failureCount: 0,
  openedAt: 0,
  halfOpenInflight: false,
};

// 状態遷移を購読するためのコールバック。
// 例: 工事中モード切替 / Slack 通知 / メトリクス送出など
const stateListeners = [];

function emitStateChange(prev, next, reason) {
  for (const cb of stateListeners) {
    try { cb({ prev, next, reason, openedAt: state.openedAt }); }
    catch (e) { console.error('[supabase-cb] listener error:', e && e.message); }
  }
}

function logStateChange(next, reason) {
  console.warn(`[supabase-cb] ${state.status} → ${next}${reason ? ` (${reason})` : ''}`);
}

function toOpen(reason) {
  const prev = state.status;
  if (prev !== 'open') logStateChange('open', reason);
  state.status = 'open';
  state.openedAt = Date.now();
  state.halfOpenInflight = false;
  if (prev !== 'open') emitStateChange(prev, 'open', reason);
}

function toClosed() {
  const prev = state.status;
  if (prev !== 'closed') logStateChange('closed', 'recovered');
  state.status = 'closed';
  state.failureCount = 0;
  state.openedAt = 0;
  state.halfOpenInflight = false;
  if (prev !== 'closed') emitStateChange(prev, 'closed', 'recovered');
}

function tryHalfOpen() {
  if (state.halfOpenInflight) return false;
  const prev = state.status;
  logStateChange('half-open', 'probe');
  state.status = 'half-open';
  state.halfOpenInflight = true;
  emitStateChange(prev, 'half-open', 'probe');
  return true;
}

function recordSuccess() {
  if (state.status === 'half-open') {
    toClosed();
  } else if (state.status === 'closed' && state.failureCount > 0) {
    state.failureCount = 0;
  }
}

function recordFailure(reason) {
  if (state.status === 'half-open') {
    toOpen(`half-open failed: ${reason}`);
    return;
  }
  state.failureCount += 1;
  if (state.failureCount >= FAILURE_THRESHOLD) {
    toOpen(`${state.failureCount} consecutive failures: ${reason}`);
  }
}

function checkCircuit() {
  if (state.status === 'closed') return null;
  if (state.status === 'open') {
    if (Date.now() - state.openedAt >= OPEN_MS) {
      if (tryHalfOpen()) return null;
    }
    const err = new Error('supabase circuit breaker open');
    err.code = 'SUPABASE_CB_OPEN';
    return err;
  }
  // half-open: 同時に複数通すと意味が無いので probe 中は弾く
  if (state.halfOpenInflight) {
    const err = new Error('supabase circuit breaker half-open probe in-flight');
    err.code = 'SUPABASE_CB_PROBE';
    return err;
  }
  return null;
}

// 外部から渡された AbortSignal と内部の timeout 用 AbortController を合成する。
function combineSignals(externalSignal, controller) {
  if (!externalSignal) return;
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return;
  }
  externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
}

async function supabaseFetch(input, init = {}) {
  const cbErr = checkCircuit();
  if (cbErr) throw cbErr;

  const controller = new AbortController();
  combineSignals(init.signal, controller);
  const timer = setTimeout(() => {
    controller.abort(new Error(`supabase request timeout after ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS);

  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    // 5xx は Supabase / Cloudflare 側の障害として扱う（4xx は業務エラーなので素通し）
    if (res.status >= 500) {
      recordFailure(`HTTP ${res.status}`);
    } else {
      recordSuccess();
    }
    return res;
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout/abort' : err && err.message || 'unknown';
    recordFailure(reason);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = supabaseFetch;
module.exports.onStateChange = (cb) => { if (typeof cb === 'function') stateListeners.push(cb); };
module.exports.getStatus = () => state.status;
module.exports.getStateSnapshot = () => ({ ...state });
module.exports.__internal = { state, TIMEOUT_MS, FAILURE_THRESHOLD, OPEN_MS };

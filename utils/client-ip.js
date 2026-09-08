// utils/client-ip.js
// =============================================================
// クライアント IP の取り出し・正規化（server.js の getClientIP / normalizeIP と同じ挙動）。
// server.js は export していないため、契約管理（ADR 035）の同意証跡用に純関数として切り出した。
// =============================================================

function normalizeIP(ip) {
  if (!ip) return '';
  // IPv6 でラップされた IPv4（::ffff:1.2.3.4）を IPv4 に正規化
  const m = String(ip).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : String(ip).trim();
}

function getClientIP(req) {
  if (!req) return '';
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return normalizeIP(String(fwd).split(',')[0]);
  return normalizeIP(req.ip || (req.connection && req.connection.remoteAddress) || '');
}

function getUserAgent(req) {
  const ua = req && req.headers && req.headers['user-agent'];
  return ua ? String(ua).slice(0, 1000) : '';
}

module.exports = { normalizeIP, getClientIP, getUserAgent };

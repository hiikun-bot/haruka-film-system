// utils/safe-outbound-url.js
// =====================================================
// メンバーが貼った URL をサーバーから取りに行くときの安全装置（SSRF 対策・ADR 045 追補 2026-11-24）。
//
// 🌐 みんなのポートフォリオの「その他リンク」は、サーバーが貼られた URL の HTML（OGP）や
// サムネ画像を取りに行く。何もしないと、社内ネットワーク（Railway の private network）・
// ループバック・クラウドのメタデータ（169.254.169.254）などへサーバー経由で届いてしまう。
//
// ここでは次を断る:
//   - http / https 以外のスキーム、ユーザー名・パスワード付きの URL
//   - localhost / *.local / *.internal / *.localhost などの社内向けホスト名
//   - 名前解決した結果のどれか 1 つでもプライベート・ループバック・リンクローカル等のアドレス
// リダイレクトは自動で追わず（redirect: 'manual'）、毎回この判定を通してから追う（最大 3 回）。
//
// 限界: 判定と接続の間に DNS の答えを変えられる（DNS rebinding）と防げない。
// 取りに行くのは OGP とサムネ画像だけで、レスポンスの中身は画面に出す前に値を絞っている。
//
// 純関数（isPrivateAddress / isBlockedHostname）は jest で確かめる（tests/utils/safe-outbound-url.test.js）。
// =====================================================

const net = require('net');

function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

// [ネットワーク, プレフィックス長]
const V4_BLOCKED = [
  ['0.0.0.0', 8],        // 「このネットワーク」
  ['10.0.0.0', 8],       // プライベート
  ['100.64.0.0', 10],    // CGNAT（Railway などの内部でも使われる）
  ['127.0.0.0', 8],      // ループバック
  ['169.254.0.0', 16],   // リンクローカル（クラウドのメタデータ）
  ['172.16.0.0', 12],    // プライベート
  ['192.0.0.0', 24],     // IETF 予約
  ['192.0.2.0', 24],     // ドキュメント用
  ['192.168.0.0', 16],   // プライベート
  ['198.18.0.0', 15],    // ベンチマーク用
  ['198.51.100.0', 24],  // ドキュメント用
  ['203.0.113.0', 24],   // ドキュメント用
  ['224.0.0.0', 4],      // マルチキャスト
  ['240.0.0.0', 4],      // 予約・ブロードキャスト
];

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;   // 読めないものは危ない側に倒す
  return V4_BLOCKED.some(([base, bits]) => {
    const b = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

function isPrivateV6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (s === '::' || s === '::1') return true;
  // IPv4 射影（::ffff:10.0.0.1 / ::ffff:a00:1）は IPv4 として判定する
  const mapped = s.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const mappedHex = s.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return true;
  // 上位が 0 のもの（IPv4 互換 ::a.b.c.d・::ffff:0:a.b.c.d など IPv4 を埋め込んだ形）は公開アドレスに無いので一律で弾く
  if (first === 0) return true;
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 ユニークローカル
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 リンクローカル
  if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 マルチキャスト
  if (s.startsWith('64:ff9b:')) return true;      // NAT64（中身が内部 IPv4 のことがある）
  if (s.startsWith('2001:db8:')) return true;     // ドキュメント用
  return false;
}

/** プライベート・ループバック・リンクローカル等の「外に出ない」アドレスか */
function isPrivateAddress(ip) {
  const v = net.isIP(String(ip || '').replace(/^\[|\]$/g, '').split('%')[0]);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

/** 名前だけで社内向けとわかるホスト名か */
function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  // 1 語だけのホスト名（社内 DNS の短縮名）は外部の Web ページではない
  if (!h.includes('.') && !net.isIP(h.replace(/^\[|\]$/g, ''))) return true;
  return false;
}

/**
 * URL を外へ取りに行ってよいか確かめる。だめなら Error（code = 'blocked_url'）を投げる。
 * @param {string} rawUrl
 * @param {{ lookup?: (host:string) => Promise<Array<{address:string}>> }} [opts]
 * @returns {Promise<URL>}
 */
async function assertPublicUrl(rawUrl, { lookup } = {}) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { throw blocked('URL の形式が正しくありません'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blocked('http / https 以外の URL は読めません');
  if (u.username || u.password) throw blocked('ユーザー名・パスワード付きの URL は読めません');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw blocked('この番号（ポート）の URL は読めません');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked('社内向けのアドレスは読めません');
    return u;
  }
  if (isBlockedHostname(host)) throw blocked('社内向けのアドレスは読めません');
  const resolve = lookup || (async (h) => require('dns').promises.lookup(h, { all: true, verbatim: true }));
  let addrs;
  try { addrs = await resolve(host); } catch (_) { throw blocked('この URL のサーバーが見つかりません'); }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map(a => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) throw blocked('この URL のサーバーが見つかりません');
  if (list.some(isPrivateAddress)) throw blocked('社内向けのアドレスは読めません');
  return u;
}

function blocked(message) {
  const e = new Error(message);
  e.code = 'blocked_url';
  return e;
}

/**
 * assertPublicUrl を通してから fetch する。リダイレクトは手で追い、行き先も毎回確かめる。
 * @param {string} url
 * @param {object} [init] fetch のオプション（redirect は無視して manual にする）
 * @param {{ maxRedirects?: number, lookup?: Function, fetchImpl?: Function }} [opts]
 * @returns {Promise<Response>}
 */
async function safeFetch(url, init = {}, { maxRedirects = 3, lookup, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let current = String(url);
  for (let i = 0; i <= maxRedirects; i += 1) {
    const u = await assertPublicUrl(current, { lookup });
    const res = await doFetch(u.toString(), { ...init, redirect: 'manual' });
    const status = Number(res.status);
    if (status >= 300 && status < 400) {
      const loc = res.headers?.get?.('location');
      if (!loc) return res;
      try { res.body?.cancel?.(); } catch (_) {}
      current = new URL(loc, u).toString();
      continue;
    }
    return res;
  }
  throw blocked('リダイレクトが多すぎます');
}

module.exports = {
  isPrivateAddress,
  isBlockedHostname,
  assertPublicUrl,
  safeFetch,
};

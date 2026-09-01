// utils/google-email.js
// =====================================================
// 「Google アカウントとして使えるメールアドレスか」を判定する共通バリデータ。
//
// 背景（2026-09-01）:
//   メンバーの users.email に Yahoo!メール（非 Google アカウント）が登録されていたため、
//   請求書フォルダ生成時の Drive permissions.create が通らず、本人がフォルダを開けなかった。
//   付与失敗は console.warn で握り潰される仕様なので UI 上は正常に見え、発覚が遅れた。
//   → 入口（メンバー新規登録・招待発行）で非 Google アドレスを弾いて再発を防ぐ。
//
// 判定順:
//   1. メール形式チェック
//   2. gmail.com / googlemail.com  → 常に許可
//   3. system_settings.google_email_allow_domains の allowlist に一致 → 許可
//      （独自ドメインのメールで Google アカウントを作っているケースの救済。
//        MX は Google でなくても Google アカウント自体は作れるため、
//        管理者が明示的に許可できる逃げ道を必ず用意しておく）
//   4. MX レコードが Google（*.google.com / *.googlemail.com）→ Google Workspace とみなし許可
//   5. それ以外・DNS 解決不能 → 拒否
//
// 公開API:
//   validateGoogleAccountEmail(email) -> Promise<{ ok:true } | { ok:false, error:string }>
//   isGmailDomain(email)              -> boolean（同期。gmail 系かどうかだけ見たいとき用）
// =====================================================

const dns = require('dns').promises;
const supabase = require('../supabase');
const { ttlCache } = require('./ttl-cache');

// Google が提供する無料メールのドメイン。MX を引くまでもなく確定で許可する。
const GOOGLE_FREE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// MX ホスト名が Google のものか（aspmx.l.google.com / smtp.google.com 等）
const GOOGLE_MX_RE = /(^|\.)(google\.com|googlemail\.com)\.?$/i;

// DNS が応答しないときに登録操作を丸ごと止めないための上限。
const MX_LOOKUP_TIMEOUT_MS = 3000;

const ALLOW_DOMAINS_TTL_MS = 5 * 60 * 1000;  // 管理者が許可ドメインを足したら5分以内に反映
const MX_CACHE_TTL_MS      = 60 * 60 * 1000; // MX は滅多に変わらないので1時間

function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function domainOf(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

// 厳密な RFC 準拠は狙わない（フロントの type="email" と同程度の素朴チェック）
function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function isGmailDomain(email) {
  return GOOGLE_FREE_DOMAINS.has(domainOf(email));
}

// system_settings.google_email_allow_domains (JSON 配列文字列) を読む。
// 失敗しても例外は投げず [] を返す（設定不備で登録が全部止まるのを避ける）。
async function getAllowedDomains() {
  return ttlCache('google-email:allow-domains', ALLOW_DOMAINS_TTL_MS, async () => {
    try {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'google_email_allow_domains')
        .maybeSingle();
      if (!data || !data.value) return [];
      const parsed = JSON.parse(data.value);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(d => typeof d === 'string')
        .map(d => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean);
    } catch (e) {
      console.warn('[google-email] allow domains の取得に失敗:', e.message);
      return [];
    }
  });
}

// ドメインの MX が Google かどうか。DNS エラー・タイムアウトは false を返す
// （呼び出し側で「確認できなかった」として拒否＋allowlist で救済する）。
async function hasGoogleMx(domain) {
  if (!domain) return false;
  return ttlCache(`google-email:mx:${domain}`, MX_CACHE_TTL_MS, async () => {
    try {
      const records = await Promise.race([
        dns.resolveMx(domain),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('MX lookup timeout')), MX_LOOKUP_TIMEOUT_MS)),
      ]);
      return (records || []).some(r => GOOGLE_MX_RE.test(String(r.exchange || '')));
    } catch (e) {
      console.warn(`[google-email] MX 解決に失敗 (${domain}):`, e.message);
      return false;
    }
  });
}

/**
 * Google アカウントとして使えるメールアドレスかを判定する。
 * @param {string} email
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function validateGoogleAccountEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, error: 'メールアドレスを入力してください' };
  if (!isValidEmailFormat(normalized)) {
    return { ok: false, error: 'メールアドレスの形式が正しくありません' };
  }

  const domain = domainOf(normalized);
  if (GOOGLE_FREE_DOMAINS.has(domain)) return { ok: true };

  const allowed = await getAllowedDomains();
  if (allowed.includes(domain)) return { ok: true };

  if (await hasGoogleMx(domain)) return { ok: true };

  return {
    ok: false,
    error: `Googleアカウントで使えるメールアドレスを指定してください（Gmail または Google Workspace のアドレス）。`
         + `${domain} は Google アカウントとして確認できないため、請求書フォルダなど Google ドライブの共有ができません。`
         + `どうしてもこのアドレスで登録する場合は、system_settings の google_email_allow_domains に ${domain} を追加してください。`,
  };
}

module.exports = {
  validateGoogleAccountEmail,
  isGmailDomain,
  // テスト・デバッグ用
  normalizeEmail,
  domainOf,
  isValidEmailFormat,
};

// utils/prod-db-guard.js — 「手元（開発）から本番DBにつながっていないか」を見分ける
// =============================================================
// 背景（docs/dev-db-setup.md）:
//   開発者の Mac の .env が本番 Supabase に service_role キーで直結していた。
//   開発用 DB（別の Supabase プロジェクト・ダミーデータ）に切り替えたうえで、
//   うっかり本番を向いたときに気づけるようにする。
//
// 本番の判定:
//   - 本番の Supabase プロジェクトID（ref）は環境変数 PROD_SUPABASE_PROJECT_REF で受ける
//     （公開リポジトリなのでコードに直書きしない）。カンマ区切りで複数可。
//   - PROD_SUPABASE_URL（https://<ref>.supabase.co）を入れた場合も ref を取り出して使う。
//
// 使い道:
//   - server.js 起動時: warnIfLocalPointsToProd() … NODE_ENV!=='production' なのに本番を向いていたら大きな警告。
//     止めない（請求突合などの調査で本番を読むことがあるため）。ALLOW_PROD_DB_FROM_LOCAL=1 のときだけ黙る。
//   - scripts/dev-db/*: assertNotProdTarget() … 本番なら即中止（こちらは止める）。
//     PROD_SUPABASE_PROJECT_REF が無いときも「判定できない」ので中止する（安全側に倒す）。
//
// テスト: tests/prod-db-guard.test.js
// =============================================================

const SUPABASE_REF_RE = /^[a-z0-9]{6,40}$/;

/**
 * Supabase の URL / Postgres 接続文字列から プロジェクトID（ref）を取り出す。
 *   https://<ref>.supabase.co
 *   postgres://postgres:pw@db.<ref>.supabase.co:5432/postgres          … 直結
 *   postgres://postgres.<ref>:pw@aws-0-xx.pooler.supabase.com:6543/postgres … プーラー（ユーザー名に ref）
 * 取り出せない（localhost など Supabase 以外）ときは null。
 */
function extractSupabaseProjectRef(value) {
  if (!value || typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // ref だけが渡された場合
  if (SUPABASE_REF_RE.test(s.toLowerCase()) && !s.includes('.') && !s.includes('/')) return s.toLowerCase();

  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  const host = (u.hostname || '').toLowerCase();
  // プーラー: ユーザー名が postgres.<ref>
  if (host.endsWith('.pooler.supabase.com')) {
    const user = decodeURIComponent(u.username || '').toLowerCase();
    const m = user.match(/^[^.]+\.([a-z0-9]+)$/);
    return m ? m[1] : null;
  }
  // 直結: db.<ref>.supabase.co
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.(co|in)$/);
  if (m) return m[1];
  // API: <ref>.supabase.co
  m = host.match(/^([a-z0-9]+)\.supabase\.(co|in)$/);
  if (m) return m[1];
  return null;
}

/** 本番の ref の集合（PROD_SUPABASE_PROJECT_REF ＋ PROD_SUPABASE_URL から） */
function getProdProjectRefs(env = process.env) {
  const refs = new Set();
  String(env.PROD_SUPABASE_PROJECT_REF || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean)
    .forEach(x => { const r = extractSupabaseProjectRef(x) || x; refs.add(r); });
  const fromUrl = extractSupabaseProjectRef(env.PROD_SUPABASE_URL || '');
  if (fromUrl) refs.add(fromUrl);
  return refs;
}

/** その URL が本番を向いているか（本番 ref 未設定なら常に false） */
function isProdTarget(url, env = process.env) {
  const ref = extractSupabaseProjectRef(url);
  if (!ref) return false;
  return getProdProjectRefs(env).has(ref);
}

// 接続先として見る環境変数（server.js / db/migrate.js が読むもの）
const DB_URL_KEYS = ['SUPABASE_URL', 'DATABASE_URL', 'SUPABASE_DB_URL'];

/**
 * 手元の起動が本番DBを向いているかを判定する（副作用なし）。
 * @returns {{ checked: boolean, pointsToProd: boolean, matchedKeys: string[], suppressed: boolean, reason: string }}
 */
function describeLocalProdDbRisk(env = process.env) {
  const base = { checked: false, pointsToProd: false, matchedKeys: [], suppressed: false, reason: '' };
  if (env.NODE_ENV === 'production') return { ...base, reason: 'NODE_ENV=production（本番サーバー）' };
  const prodRefs = getProdProjectRefs(env);
  if (prodRefs.size === 0) return { ...base, reason: 'PROD_SUPABASE_PROJECT_REF 未設定のため判定しない' };
  const matchedKeys = DB_URL_KEYS.filter(k => env[k] && isProdTarget(env[k], env));
  const pointsToProd = matchedKeys.length > 0;
  const suppressed = pointsToProd && String(env.ALLOW_PROD_DB_FROM_LOCAL || '') === '1';
  return {
    checked: true,
    pointsToProd,
    matchedKeys,
    suppressed,
    reason: pointsToProd ? (suppressed ? 'ALLOW_PROD_DB_FROM_LOCAL=1 により警告を抑止' : '本番DBを向いている') : '開発DB（本番ではない）',
  };
}

/** 警告文（行の配列）。schema-sync / ワーカーが本番に向けて動くことも書く */
function buildProdDbWarningLines(matchedKeys) {
  return [
    '',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '!!  ⚠️  警告: ローカル（NODE_ENV≠production）なのに「本番DB」に接続しています',
    `!!  本番を向いている変数: ${matchedKeys.join(', ')}`,
    '!!  この状態で画面操作・スクリプトを動かすと本番データが書き換わります。',
    ...(matchedKeys.some(k => k !== 'SUPABASE_URL')
      ? ['!!  - 起動時の schema-sync（DATABASE_URL）も本番に流れます（止めるなら SCHEMA_AUTO_SYNC=false）']
      : []),
    '!!  - 通知・振込ポーリングなどのワーカーも本番データで動きます',
    '!!  開発なら .env を開発用プロジェクトへ切り替えてください（docs/dev-db-setup.md）。',
    '!!  調査で本番を読むと分かっている場合だけ ALLOW_PROD_DB_FROM_LOCAL=1 で黙ります。',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '',
  ];
}

/** サーバー起動時に呼ぶ。止めずに警告だけ出す */
function warnIfLocalPointsToProd(env = process.env, logger = console) {
  const risk = describeLocalProdDbRisk(env);
  if (risk.pointsToProd && !risk.suppressed) {
    for (const line of buildProdDbWarningLines(risk.matchedKeys)) logger.error(line);
  } else if (risk.pointsToProd && risk.suppressed) {
    logger.warn(`[prod-db-guard] 本番DBに接続中（${risk.matchedKeys.join(', ')}）。ALLOW_PROD_DB_FROM_LOCAL=1 のため警告は省略`);
  }
  return risk;
}

/**
 * 開発DB向けスクリプトの入口で呼ぶ。本番なら throw（呼び出し側で exit）。
 * 本番 ref が未設定なら判定できないので throw（安全側）。
 */
function assertNotProdTarget(url, { label = '接続先', env = process.env } = {}) {
  if (!url) throw new Error(`${label} が未設定です`);
  const prodRefs = getProdProjectRefs(env);
  if (prodRefs.size === 0) {
    throw new Error('PROD_SUPABASE_PROJECT_REF（本番の Supabase プロジェクトID）が未設定です。本番かどうか判定できないので中止します');
  }
  const ref = extractSupabaseProjectRef(url);
  if (ref && prodRefs.has(ref)) {
    throw new Error(`${label} が本番の Supabase プロジェクト（${ref}）を向いています。開発用プロジェクトの値にしてください。中止します`);
  }
  return { ref };
}

module.exports = {
  extractSupabaseProjectRef,
  getProdProjectRefs,
  isProdTarget,
  describeLocalProdDbRisk,
  buildProdDbWarningLines,
  warnIfLocalPointsToProd,
  assertNotProdTarget,
  DB_URL_KEYS,
};

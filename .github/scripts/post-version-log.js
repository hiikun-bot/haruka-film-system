#!/usr/bin/env node
// =============================================================================
// PRマージ時に PR 本文から Verup情報セクションを抽出し、
// Supabase の version_logs テーブルに INSERT するスクリプト。
//
// 必要な env:
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//   - PR_TITLE / PR_BODY / PR_NUMBER / PR_URL / PR_AUTHOR
//   - PR_LABELS (カンマ区切り)
//
// PR本文に "## 🆙 Verup情報" セクションが無い PR はスキップ（refactor / chore など）。
// セクションがあっても "なし" / "skip" のみであればスキップ。
// =============================================================================

const SECTION_HEADER_RE = /##\s*🆙?\s*Verup情報\s*$/m;
const VALID_CATEGORIES = ['feature', 'improvement', 'bugfix', 'spec_change'];
const VALID_IMPORTANCES = ['high', 'normal', 'low'];
const VALID_ROLES = ['all', 'admin', 'secretary', 'producer', 'director', 'editor', 'designer'];

function extractSection(body) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  let inSection = false;
  const out = [];
  for (const line of lines) {
    if (!inSection) {
      if (SECTION_HEADER_RE.test(line)) { inSection = true; continue; }
    } else {
      if (/^##\s+/.test(line)) break; // 次のH2でセクション終了
      out.push(line);
    }
  }
  return inSection ? out.join('\n').trim() : null;
}

// "- key: value" 形式の bullet を緩めにパース
function parseBullets(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let lastKey = null;
  for (const raw of lines) {
    const line = raw.replace(/^\s*[-*]\s*/, '');
    const m = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (m) {
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      out[key] = val;
      lastKey = key;
    } else if (lastKey && raw.trim()) {
      // 継続行（インデントされた追加テキスト）
      out[lastKey] = (out[lastKey] ? out[lastKey] + '\n' : '') + raw.trim();
    }
  }
  return out;
}

function pickKey(obj, ...candidates) {
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return null;
}

function isPlaceholder(v) {
  if (!v) return true;
  const t = v.trim().toLowerCase();
  return t === '' || t === 'なし' || t === '-' || t === '—' || t === 'skip' || t === '（任意）' || t === '(任意)' || t.startsWith('例)') || t.startsWith('例：');
}

// 報告者名から users.id を解決する。
// 完全一致のみ（部分一致は誤マッチの元なので一切しない）。
//   - nickname と完全一致（1人だけ）
//   - full_name と完全一致（1人だけ）
//   - full_name のスペース除去版と完全一致（1人だけ）
// いずれにも該当しない / 複数マッチ する場合は null を返す。
async function resolveReporterUserId(rawName, supabaseUrl, headers) {
  if (!rawName) return null;
  const name = rawName.trim();
  if (!name || isPlaceholder(name)) return null;

  // users 全件取得（数十〜数百行想定なので全件 fetch で十分）。
  // is_active 条件は付けない（過去の報告者も解決できるよう保持）。
  const res = await fetch(
    `${supabaseUrl}/rest/v1/users?select=id,full_name,nickname`,
    { headers }
  );
  if (!res.ok) {
    console.warn('[verup] failed to fetch users for reporter resolve:', res.status);
    return null;
  }
  const users = await res.json();
  if (!Array.isArray(users) || users.length === 0) return null;

  const stripSpaces = (s) => String(s || '').replace(/[\s　]+/g, '');
  const nameNoSpace = stripSpaces(name);

  // 1) nickname 完全一致
  let hits = users.filter(u => (u.nickname || '').trim() === name);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    console.warn(`[verup] reporter "${name}" matched ${hits.length} users by nickname — ambiguous, skip`);
    return null;
  }

  // 2) full_name 完全一致
  hits = users.filter(u => (u.full_name || '').trim() === name);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    console.warn(`[verup] reporter "${name}" matched ${hits.length} users by full_name — ambiguous, skip`);
    return null;
  }

  // 3) full_name のスペース除去版と完全一致
  hits = users.filter(u => stripSpaces(u.full_name) === nameNoSpace);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    console.warn(`[verup] reporter "${name}" matched ${hits.length} users by full_name (no-space) — ambiguous, skip`);
    return null;
  }

  console.log(`[verup] reporter "${name}" not matched to any user — leaving null`);
  return null;
}

function detectCategory(value, prTitle, prLabels) {
  if (value && VALID_CATEGORIES.includes(value)) return value;
  // ラベルから推定
  const labels = prLabels.map(l => l.toLowerCase());
  if (labels.includes('type:bug')) return 'bugfix';
  if (labels.includes('type:feature')) return 'feature';
  if (labels.includes('type:improvement')) return 'improvement';
  if (labels.includes('type:refactor')) return 'improvement';
  // タイトル prefix から推定
  const t = (prTitle || '').toLowerCase();
  if (/^#?\d*\s*fix(\(|:|\s)/.test(t)) return 'bugfix';
  if (/^#?\d*\s*feat(\(|:|\s)/.test(t)) return 'feature';
  return 'improvement';
}

function parseRoles(value) {
  if (!value) return ['all'];
  const arr = value.split(/[,、]/).map(s => s.trim()).filter(Boolean).filter(r => VALID_ROLES.includes(r));
  return arr.length ? arr : ['all'];
}

function parseTags(value) {
  if (!value) return [];
  return value.split(/[,、#]/).map(s => s.trim()).filter(Boolean);
}

async function main() {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    PR_TITLE, PR_BODY, PR_NUMBER, PR_URL, PR_AUTHOR, PR_LABELS,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[verup] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — skip');
    return process.exit(0); // secret 未設定時は失敗させずスキップ
  }

  const prLabels = (PR_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);

  // skip-verup ラベルがあれば登録しない
  if (prLabels.map(l => l.toLowerCase()).includes('skip-verup')) {
    console.log('[verup] skip-verup label found — skipping');
    return;
  }

  const section = extractSection(PR_BODY || '');
  if (!section) {
    console.log('[verup] no Verup section found in PR body — skipping');
    return;
  }
  if (isPlaceholder(section.replace(/<!--[\s\S]*?-->/g, ''))) {
    console.log('[verup] section is placeholder/empty — skipping');
    return;
  }

  const fields = parseBullets(section.replace(/<!--[\s\S]*?-->/g, ''));

  // 必須フィールド: 画面 / 機能 / 修正
  const screen = pickKey(fields, '画面', 'screen');
  const feature = pickKey(fields, '機能', 'feature');
  const description = pickKey(fields, '修正', 'description', '要約');
  if (!screen || !feature || !description) {
    console.log('[verup] required fields missing (画面/機能/修正) — skipping');
    return;
  }

  const category = detectCategory(pickKey(fields, '種別', 'category'), PR_TITLE, prLabels);
  const impRaw = pickKey(fields, '重要度', 'importance');
  const importance = VALID_IMPORTANCES.includes(impRaw) ? impRaw : 'normal';

  const targetRoles = parseRoles(pickKey(fields, '対象ロール', 'target_roles'));
  const tags = parseTags(pickKey(fields, 'タグ', 'tags'));
  const beforeText = pickKey(fields, '変更前', 'before') || null;
  const afterText = pickKey(fields, '変更後', 'after') || null;
  const useCase = pickKey(fields, '便利なシーン', 'use_case', 'シーン') || null;
  const versionLabel = pickKey(fields, 'バージョン', 'version_label', 'version') || null;
  const relatedUrl = pickKey(fields, '関連リンク', 'related_url') || PR_URL || null;
  const reporterRaw = pickKey(fields, '報告者', 'reporter');

  // revision_no は GitHub の PR 番号と一致させる（Slack 通知や PR タイトルと突合できるように）
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 報告者を nickname / full_name 完全一致で解決（マッチしなければ null）
  const reporterUserId = await resolveReporterUserId(reporterRaw, SUPABASE_URL, headers);
  const prNo = parseInt(PR_NUMBER, 10);
  if (!Number.isFinite(prNo) || prNo <= 0) {
    console.error('[verup] PR_NUMBER missing or invalid — cannot derive revision_no:', PR_NUMBER);
    process.exit(1);
  }
  const nextNo = prNo;

  const row = {
    revision_no: nextNo,
    version_label: versionLabel,
    released_at: new Date().toISOString(),
    screen: screen.replace(/[「」"']/g, '').slice(0, 200),
    feature: feature.replace(/[「」"']/g, '').slice(0, 200),
    description,
    before_text: beforeText && !isPlaceholder(beforeText) ? beforeText : null,
    after_text: afterText && !isPlaceholder(afterText) ? afterText : null,
    use_case: useCase && !isPlaceholder(useCase) ? useCase : null,
    category,
    importance,
    target_roles: targetRoles,
    tags,
    related_url: relatedUrl,
    is_hidden: false,
    reporter_user_id: reporterUserId,
  };

  let insRes = await fetch(`${SUPABASE_URL}/rest/v1/version_logs`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });

  // revision_no が既に使われている（手動エントリ等と衝突）場合は max+1 にフォールバック
  if (insRes.status === 409) {
    console.warn(`[verup] revision_no=${nextNo} already exists — falling back to max+1`);
    const maxRes = await fetch(
      `${SUPABASE_URL}/rest/v1/version_logs?select=revision_no&order=revision_no.desc&limit=1`,
      { headers }
    );
    if (!maxRes.ok) {
      console.error('[verup] failed to fetch max revision_no for fallback:', maxRes.status, await maxRes.text());
      process.exit(1);
    }
    const maxRows = await maxRes.json();
    row.revision_no = (maxRows[0]?.revision_no || 0) + 1;
    insRes = await fetch(`${SUPABASE_URL}/rest/v1/version_logs`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
  }

  if (!insRes.ok) {
    console.error('[verup] insert failed:', insRes.status, await insRes.text());
    process.exit(1);
  }
  const inserted = await insRes.json();
  console.log(`[verup] inserted version_log #${row.revision_no} for PR #${PR_NUMBER}`);
  console.log(JSON.stringify(inserted[0] || inserted, null, 2));
}

main().catch(err => {
  console.error('[verup] unhandled error:', err);
  process.exit(1);
});

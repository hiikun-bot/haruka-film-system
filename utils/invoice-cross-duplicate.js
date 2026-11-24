// utils/invoice-cross-duplicate.js
// 💸 人をまたいだ二重請求の疑いを見つける純関数（振込管理で管理者に知らせるだけ。提出は止めない）。
//
// 背景（2026-11）: 外注先の作業を「元請けメンバー経由で払う」約束だったのに、外注先が HF に直接請求し、
//   元請けメンバーも同じ作業を自分の請求書に入れていた → 同じ作業を 2 回払った。
//   請求書エディタの二重請求チェック（utils/invoice-editor.js）は「本人の他の請求書」しか見ないため、
//   別の人どうしの重複は素通りしていた。
//
// 判定（強い順）:
//   high   … 同じ CR・同じ役割（cost_type）を別の 2 人が請求（1 つの CR の 1 つの役割は普通 1 人）
//   medium … 同じ CR を別の 2 人が同じ金額で請求
//            HFS外の行の品目名・理由に、相手の名前か相手の CR 名があり、金額も同じ
//   low    … HFS外の行の品目名・理由に、相手の CR 名がある（金額は違う）
//            HFS外の行の品目名・理由に、相手の名前がある（金額が合う行は無い）
//   少なくとも片方が対象月の請求書であるペアだけを返す（相手は前の月の請求書でもよい）。
//
// 対象外: 立替経費・作業時間報告・一式（分割支払）の行（人ごとに決まる金額で、同額でも二重ではない）。
// DB 非依存。jest: tests/utils/invoice-cross-duplicate.test.js
'use strict';

const EXCLUDED_COST_TYPES = ['expense', 'hourly_expense', 'hourly_fee', 'installment_fee'];
const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };
const MIN_CR_LABEL_LEN = 4;   // これより短い CR 名は品目名の部分一致に使わない（誤検知が多い）
const MIN_NAME_LEN = 2;

const COST_TYPE_LABELS = {
  base_fee: '編集', script_fee: '台本作成', ai_fee: 'AI生成', other_fee: 'その他',
  director_fee: 'ディレクション費', producer_fee: 'プロデュース費', manual: 'HFS外',
};

/** 比較用の正規化（全角半角・大文字小文字・空白や区切り記号の違いを無視） */
function norm(v) {
  return String(v ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .replace(/[\s_\-‐－—―・.,、。/\\|()（）\[\]［］「」【】:：]/g, '');
}

/** 行の金額（total_amount があればそれ、無ければ 単価×数量） */
function itemAmount(it) {
  const t = Math.trunc(Number(it && it.total_amount));
  if (Number.isFinite(t) && t > 0) return t;
  const up = Math.trunc(Number(it && it.unit_price)) || 0;
  const q = Number(it && it.quantity);
  return up * (Number.isFinite(q) && q > 0 ? q : 1);
}

function isCrLine(it) { return !!(it && it.creative_id); }
function isTargetLine(it) { return !!it && !EXCLUDED_COST_TYPES.includes(it.cost_type); }

/** 名前の照合語（ニックネーム・氏名・氏名の姓）。短すぎる語は使わない */
function nameTokens(user) {
  if (!user) return [];
  const out = new Set();
  const add = (s) => { const n = norm(s); if (n.length >= MIN_NAME_LEN) out.add(n); };
  add(user.nickname);
  add(user.full_name);
  const parts = String(user.full_name || '').trim().split(/[\s　]+/).filter(Boolean);
  if (parts.length >= 2) add(parts[0]);
  return Array.from(out);
}

/**
 * 品目名・理由（norm 済み）に、その人を指す書き方があるか。
 * 短い名前（姓・ニックネーム）は「〇〇さん」「〇〇分」「〇〇様」の形のときだけ（「ナナメ構図」が「なな」さんに当たらないように）。
 * 3 文字以上の氏名（姓名つなぎ）はそのまま含まれていればよい。norm でひらがなはカタカナになるので「さん」は「サン」で見る。
 */
function mentionsUser(text, user) {
  if (!text || !user) return false;
  const full = norm(user.full_name);
  if (full.length >= 3 && String(user.full_name || '').trim().split(/[\s　]+/).filter(Boolean).length >= 2 && text.includes(full)) return true;
  return nameTokens(user).some(t => ['サン', '分', '様'].some(suf => text.includes(t + suf)));
}

function ymKey(it) { return `${it.year}-${String(it.month).padStart(2, '0')}`; }

/**
 * @param {object} p
 * @param {object[]} p.items  請求書の行（invoice の issuer_id / year / month / invoice_number をくっつけたもの）
 *   { id, invoice_id, invoice_number, issuer_id, year, month, creative_id, creative_name, cost_type,
 *     label, creative_label, manual_reason, unit_price, quantity, total_amount }
 * @param {number} p.year   対象月
 * @param {number} p.month
 * @param {Map<string, {full_name?, nickname?}>} [p.usersById]
 * @returns {Array<{level, reason, a, b, b_issuer_id}>}
 */
function findCrossMemberDuplicates(p) {
  const items = (p.items || []).filter(isTargetLine);
  const target = `${p.year}-${String(p.month).padStart(2, '0')}`;
  const usersById = p.usersById || new Map();
  const findings = [];
  const seen = new Set();
  const push = (level, reason, a, b, bIssuer) => {
    const key = [a.id, b ? b.id : `user:${bIssuer}`].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ level, reason, a, b, b_issuer_id: b ? b.issuer_id : bIssuer });
  };
  const involvesTarget = (a, b) => ymKey(a) === target || (b && ymKey(b) === target);

  // 1) 同じ CR を別の人が請求
  const byCreative = new Map();
  for (const it of items) {
    if (!isCrLine(it)) continue;
    if (!byCreative.has(it.creative_id)) byCreative.set(it.creative_id, []);
    byCreative.get(it.creative_id).push(it);
  }
  for (const list of byCreative.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.issuer_id === b.issuer_id || !involvesTarget(a, b)) continue;
        if (a.cost_type && b.cost_type && a.cost_type === b.cost_type) {
          push('high', '同じクリエイティブ・同じ役割を2人が請求しています', a, b);
        } else if (itemAmount(a) > 0 && itemAmount(a) === itemAmount(b)) {
          push('medium', '同じクリエイティブを2人が同じ金額で請求しています', a, b);
        }
      }
    }
  }

  // 2) HFS外の行（CR に紐づかない）の品目名・理由に、相手の名前・相手の CR 名がある
  const byIssuer = new Map();
  for (const it of items) {
    if (!byIssuer.has(it.issuer_id)) byIssuer.set(it.issuer_id, []);
    byIssuer.get(it.issuer_id).push(it);
  }
  for (const m of items) {
    if (isCrLine(m)) continue;
    const text = norm(`${m.label || ''} ${m.creative_label || ''} ${m.manual_reason || ''}`);
    if (!text) continue;
    const mAmount = itemAmount(m);
    for (const [otherId, otherItems] of byIssuer) {
      if (otherId === m.issuer_id) continue;
      const nameHit = mentionsUser(text, usersById.get(otherId));
      let matched = false;
      let nameAmountHit = null; // 名前だけで当たった同額の行は、1 人につき 1 件にまとめる（同じ単価の行が並ぶ人で増えないように）
      for (const b of otherItems) {
        if (!involvesTarget(m, b)) continue;
        const crName = norm(b.creative_name || b.creative_label || '');
        const crHit = isCrLine(b) && crName.length >= MIN_CR_LABEL_LEN && text.includes(crName);
        const amountEq = mAmount > 0 && mAmount === itemAmount(b);
        if (crHit && amountEq) {
          matched = true;
          push('medium', 'HFS外の行に相手のクリエイティブ名があり、金額も同じです', m, b);
        } else if (nameHit && amountEq) {
          matched = true;
          if (!nameAmountHit) nameAmountHit = b;
        } else if (crHit) {
          matched = true;
          push('low', 'HFS外の行に相手のクリエイティブ名があります（金額は違います）', m, b);
        }
      }
      if (nameAmountHit) {
        push('medium', 'HFS外の行に相手の名前があり、相手の請求に同じ金額の行があります', m, nameAmountHit);
      }
      if (nameHit && !matched && ymKey(m) === target) {
        push('low', 'HFS外の行に別のメンバーの名前があります（その人の分を代わりに請求していないか）', m, null, otherId);
      }
    }
  }

  findings.sort((x, y) => (LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level])
    || (itemAmount(y.a) - itemAmount(x.a)));
  return findings;
}

/** 対象月を含む直近 n か月の (year, month) 一覧（古い順）。相手の請求書を探す範囲 */
function lookbackMonths(year, month, n) {
  const out = [];
  for (let k = n; k >= 0; k--) {
    const d = new Date(Date.UTC(year, month - 1 - k, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

module.exports = {
  findCrossMemberDuplicates, lookbackMonths, itemAmount, nameTokens, norm,
  EXCLUDED_COST_TYPES, COST_TYPE_LABELS,
};

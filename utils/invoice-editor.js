// utils/invoice-editor.js
// 🧾 請求書エディタ（ADR 046・税抜＋源泉）の純関数群。
//
// 役割:
//   - 計算（サーバーが正）: 小計 S → 消費税 T=floor(S*10/100) → 税込 G=S+T → 源泉 W=floor(S*1021/10000) → 差引 P=G+E-W
//     すべて整数演算（浮動小数の 1 円ずれ対策・ADR 047 と同じ考え方）
//     E＝立替経費（実費）。領収書どおりの金額をそのまま足すだけで、S にも T にも W にも入れない（追補 2026-11-05）
//   - 新方式の適用月（system_settings.invoice_exclusive_from・既定 2026-10）
//   - 候補 CR の判定（請求できるか＝納品済み / 初稿請求案件は初稿提出済み・ADR 034、計上月、前月以前の遡り 3 か月）
//   - 本人のその CR での役割（1 CR × 役割 = 1 行）
//   - 提出時の過剰請求チェック（本人の分 / 納品済み / 二重請求 / 単価未入力 / 参考単価超の理由 / HFS外の理由 / 合計一致）
//   - 立替経費の日付・支払先・領収書（写真の添付 or 「領収書なし」の理由）の提出前チェック（追補 2026-11-23）
//
// ⚠️ 時刻ルール: 月・日付の判定はすべて JST 固定。TIMESTAMPTZ は
//   toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) で JST の 'YYYY-MM-DD' にしてから扱う。
//   DATE 列（'YYYY-MM-DD'）は TZ 変換をしない。年月の加減算は Date.UTC ベース。
//   `TZ=UTC` と `TZ=Asia/Tokyo` の両方で同じ結果になること（tests/utils/invoice-editor.test.js）。
//
// DB 非依存。UMD 形式（Node: require('../utils/invoice-editor') / ブラウザ: window.InvoiceEditorCalc）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./my-stats'));
  } else {
    root.InvoiceEditorCalc = factory(root.MyStatsUtils || null);
  }
})(typeof self !== 'undefined' ? self : this, function (myStats) {
  'use strict';

  // ---------- 定数 ----------
  const TAX_NUM = 10, TAX_DEN = 100;              // 消費税 10%
  const WH_NUM = 1021, WH_DEN = 10000;            // 源泉徴収 10.21%（一律・§7-4）
  const WITHHOLDING_WARN_THRESHOLD = 1000000;     // 1 回の支払（税抜小計）が 100 万円超なら警告だけ（§7-4）
  const LOOKBACK_MONTHS = 3;                      // 前月以前の未請求を遡る範囲（§7-3）
  const DEFAULT_EXCLUSIVE_FROM = '2026-10';       // 新方式の開始月（§7-2）
  const REASON_MAX = 500;
  const LABEL_MAX = 200;
  const MAX_PRICE = 100000000;                    // 1 行 1 億円未満（入力ミス防止）
  const MAX_QUANTITY = 10000;
  const MAX_ITEMS = 500;

  const COST_TYPE_LABELS = {
    base_fee: '編集',
    script_fee: '台本作成',
    ai_fee: 'AI生成（ナレーション含む）',
    other_fee: 'その他',
    director_fee: 'ディレクション費',
    producer_fee: 'プロデュース費',
    hourly_fee: '時間報酬',
    hourly_expense: '立替経費',
    adjustment: '過払いの調整',
    expense: '立替経費',
    installment_fee: '一式（分割支払）',
    manual: 'HFS外',
  };
  // 金額をサーバーが決める行（作業時間報告・一式分割）。エディタでは単価を変えられない（§7-5: 税抜として扱う）
  const FIXED_COST_TYPES = ['hourly_fee', 'hourly_expense', 'installment_fee'];
  // 立替経費（実費）の行。領収書どおりの金額をそのまま払う＝消費税を上乗せせず、源泉徴収の対象にも入れない（追補 2026-11-05）
  //   expense        : エディタの「＋ 立替経費」で足す行（金額は本人が入れる）
  //   hourly_expense : 作業時間報告の立替経費（金額はサーバー計算の固定額）
  const MANUAL_EXPENSE_COST_TYPE = 'expense';
  const EXPENSE_COST_TYPES = [MANUAL_EXPENSE_COST_TYPE, 'hourly_expense'];
  // 過払いの調整（マイナス）の行（追補 2026-11-24）。前の月に多く払った分を、この請求書で差し引く。
  //   単価は正の数で持ち、行の金額はマイナス（lineAmount が −単価 を返す）。数量は 1 固定・品目と理由が必須。
  //   報酬（税抜小計）から引くので、消費税・源泉はマイナスを引いたあとの小計で計算される。
  const ADJUSTMENT_COST_TYPE = 'adjustment';
  const CR_COST_TYPES = ['base_fee', 'script_fee', 'ai_fee', 'other_fee', 'director_fee', 'producer_fee'];
  // 二重請求の対象になる請求書の状態（差し戻し・下書き・削除は数えない）
  const BILLED_STATUSES = ['submitted', 'approved'];
  // 請求の役割にならない担当（Wチェックは報酬の単価が無い確認役。制作担当の一覧に混ぜない）
  const NON_BILLABLE_ASSIGNMENT_ROLES = ['wcheck'];
  // 立替経費の領収書（追補 2026-11-23）。attached=写真/PDF を添付 / missing=領収書なし（理由必須）
  const RECEIPT_ATTACHED = 'attached';
  const RECEIPT_MISSING = 'missing';
  const RECEIPT_STATUSES = [RECEIPT_ATTACHED, RECEIPT_MISSING];
  const PAYEE_MAX = 200;

  // ---------- 年月ヘルパー（JST・TZ 非依存） ----------

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** (2026, 10) → '2026-10'。不正値は null */
  function ymOf(year, month) {
    const y = parseInt(year, 10), m = parseInt(month, 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    return `${y}-${pad2(m)}`;
  }

  /** 'YYYY-MM' に n か月足す（負も可） */
  function addMonthsYm(ym, n) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1 + n, 1));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
  }

  /** TIMESTAMPTZ（ISO）→ JST 'YYYY-MM-DD'。不正値は null */
  function jstDateOfIso(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** DATE 列（'YYYY-MM-DD…'）→ 'YYYY-MM-DD'（TZ 変換しない） */
  function dateOnly(v) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
    return m ? m[1] : null;
  }

  /** JST 範囲 [start, 翌月 start) を timestamptz 比較用 ISO で返す（routes の jstMonthRangeIso と同じ） */
  function jstMonthRangeIso(year, month) {
    const JST = 9 * 60 * 60 * 1000;
    return {
      startIso: new Date(Date.UTC(year, month - 1, 1) - JST).toISOString(),
      endIso: new Date(Date.UTC(year, month, 1) - JST).toISOString(),
    };
  }

  /** 支払期限＝翌月末（§7-6）。(2026,10) → '2026-11-30' */
  function paymentDueDate(year, month) {
    const y = parseInt(year, 10), m = parseInt(month, 10);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    const d = new Date(Date.UTC(y, m + 1, 0)); // 翌月の 0 日 = 翌月末
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  /** 請求日＝対象月の月末（ADR 046 §1(b) の見本どおり）。(2026,10) → '2026-10-31' */
  function invoiceDate(year, month) {
    const y = parseInt(year, 10), m = parseInt(month, 10);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    const d = new Date(Date.UTC(y, m, 0));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  // ---------- 新方式の適用月（§7-2） ----------

  /**
   * system_settings.invoice_exclusive_from の値 → 'YYYY-MM'。
   * '2026-10' / '2026-10-01' / '"2026-10"'（JSON 文字列）/ 202610 を受け付け、読めなければ既定 2026-10。
   */
  function parseExclusiveFrom(value) {
    if (value === null || value === undefined) return DEFAULT_EXCLUSIVE_FROM;
    let s = String(value).trim().replace(/^"+|"+$/g, '');
    let m = /^(\d{4})-(\d{1,2})/.exec(s);
    if (!m) m = /^(\d{4})(\d{2})$/.exec(s);
    if (!m) return DEFAULT_EXCLUSIVE_FROM;
    const mm = parseInt(m[2], 10);
    if (mm < 1 || mm > 12) return DEFAULT_EXCLUSIVE_FROM;
    return `${m[1]}-${pad2(mm)}`;
  }

  /** 対象月が新方式（税抜＋源泉）か */
  function isExclusiveYm(ym, fromYm) {
    if (!ym) return false;
    return String(ym) >= String(fromYm || DEFAULT_EXCLUSIVE_FROM);
  }

  // ---------- 候補 CR の判定（ADR 026 / 034・§7-1・§7-3） ----------

  function billingTimingOf(project) {
    return (project && project.billing_timing === 'on_first_draft') ? 'on_first_draft' : 'on_delivery';
  }

  /**
   * 請求できる状態か。
   *   on_delivery（既定）: status='納品'
   *   on_first_draft     : 初稿提出済み（first_draft_submitted_at あり）または納品済み（§7-1）
   */
  function isBillableCreative(creative, project) {
    if (!creative) return false;
    if (creative.status === '納品') return true;
    if (billingTimingOf(project) === 'on_first_draft') return !!creative.first_draft_submitted_at;
    return false;
  }

  /**
   * 計上日（JST 'YYYY-MM-DD'）。請求できない CR は null（画面では「―」）。
   *   on_first_draft: 初稿提出日 → （無ければ）納品日
   *   on_delivery   : 納品完了日（delivered_at）→ 旧データで delivered_at が無い納品済みは final_deadline → draft_deadline
   */
  function billingDateOf(creative, project) {
    if (!isBillableCreative(creative, project)) return null;
    if (billingTimingOf(project) === 'on_first_draft' && creative.first_draft_submitted_at) {
      return jstDateOfIso(creative.first_draft_submitted_at);
    }
    return jstDateOfIso(creative.delivered_at)
      || dateOnly(creative.final_deadline)
      || dateOnly(creative.draft_deadline);
  }

  /** 遡りの起点月（対象月の LOOKBACK_MONTHS か月前） */
  function lookbackStartYm(targetYm, months) {
    return addMonthsYm(targetYm, -(Number.isFinite(months) ? months : LOOKBACK_MONTHS));
  }

  /** 「前月・未請求」を遡る起点月。遡り範囲と新方式の開始月の遅い方 */
  function previousStartYm(targetYm, notBeforeYm, months) {
    const start = lookbackStartYm(targetYm, months);
    return (/^\d{4}-\d{2}$/.test(String(notBeforeYm || '')) && notBeforeYm > start) ? notBeforeYm : start;
  }

  /**
   * モーダルでの CR の扱いを決める。
   * @returns {'billable'|'previous'|'undelivered'|null}
   *   billable    : 当月に計上（請求できる）
   *   previous    : 前月以前（遡り範囲内）に計上・まだ未請求 →「前月・未請求」バッジ
   *   undelivered : 当月が締切で未納品（グレー・選択不可）
   *   null        : 一覧に出さない（範囲外・未来・他月の未納品）
   * opts.notBeforeYm（新方式の開始月）より前の月は遡らない。旧方式の月は HFS 外（PDF・手入力）で請求済みのものが
   * 多く、invoice_items では見分けられないため（「請求済みが一覧に混ざる」の対策）
   */
  function classifyCandidate(creative, project, targetYm, opts) {
    const months = opts && Number.isFinite(opts.lookbackMonths) ? opts.lookbackMonths : LOOKBACK_MONTHS;
    if (!creative || !targetYm) return null;
    if (isBillableCreative(creative, project)) {
      const d = billingDateOf(creative, project);
      const ym = d ? d.slice(0, 7) : null;
      if (!ym) return null;
      if (ym === targetYm) return 'billable';
      if (ym < targetYm && ym >= previousStartYm(targetYm, opts && opts.notBeforeYm, months)) return 'previous';
      return null;
    }
    // 未納品: 従来の締切月（final_deadline → draft_deadline。初稿請求案件は draft_deadline）が当月なら「請求できません」で見せる
    const deadline = billingTimingOf(project) === 'on_first_draft'
      ? dateOnly(creative.draft_deadline)
      : (dateOnly(creative.final_deadline) || dateOnly(creative.draft_deadline));
    if (deadline && deadline.slice(0, 7) === targetYm) return 'undelivered';
    return null;
  }

  // ---------- 本人の役割（1 CR × 役割 = 1 行） ----------

  function snapshotDirectorId(c) { return myStats ? myStats.snapshotDirectorId(c) : null; }
  function snapshotProducerId(c) { return myStats ? myStats.snapshotProducerId(c) : null; }
  function isCreativeOfUser(c, uid) { return myStats ? myStats.isCreativeOfUser(c, uid) : false; }

  /**
   * この CR で uid が請求できる役割（cost_type）の一覧。/invoices/preview-items と同じ解決:
   *   - 担当（creative_assignments）の role が D/P 以外 → base_fee（参考単価は roleCode=その role）
   *   - 納品時スナップショット D（無ければ projects.director_id）or 担当 role='director' → director_fee
   *   - 同 P → producer_fee
   *   - Wチェック担当（role='wcheck'）は請求の役割にしない（NON_BILLABLE_ASSIGNMENT_ROLES）
   *   - 受取人指定（opts = utils/pricing.js payeeDesignations の結果）: 成果物グループの D費 / P費 の単価行に
   *     受取人が指定されているとき
   *       designatedRoles … uid が受取人。案件のディレクターや CR のディレクター担当でなくても、その役割で
   *                         請求できる（呼び出し側で「自分の CR か」は別に確かめる）
   *       blockedRoles    … ほかの人だけが受取人。案件のディレクター等でも、その役割では請求できない
   * @param {{ designatedRoles?: string[], blockedRoles?: string[] }} [opts]
   * @returns {Array<{cost_type, role_code, rank_applied}>}
   */
  function issuerCostRoles(creative, uid, opts) {
    if (!creative || !uid) return [];
    const designated = (opts && Array.isArray(opts.designatedRoles)) ? opts.designatedRoles : [];
    const blocked = (opts && Array.isArray(opts.blockedRoles)) ? opts.blockedRoles : [];
    const assignment = (creative.creative_assignments || []).find(a => a && (a.user_id === uid || (a.users && a.users.id === uid))
      && !NON_BILLABLE_ASSIGNMENT_ROLES.includes(a.role));
    const isDirector = snapshotDirectorId(creative) === uid;
    const isProducer = snapshotProducerId(creative) === uid;
    const primaryRole = (assignment && assignment.role) || (isDirector ? 'director' : (isProducer ? 'producer' : null));
    const rank = assignment ? (assignment.rank_applied ?? null) : null;
    const out = [];
    if (assignment && primaryRole && primaryRole !== 'director' && primaryRole !== 'producer') {
      out.push({ cost_type: 'base_fee', role_code: primaryRole, rank_applied: rank });
    }
    if (!blocked.includes('director')
      && (isDirector || (assignment && assignment.role === 'director') || designated.includes('director'))) {
      out.push({ cost_type: 'director_fee', role_code: 'director', rank_applied: rank });
    }
    if (!blocked.includes('producer')
      && (isProducer || (assignment && assignment.role === 'producer') || designated.includes('producer'))) {
      out.push({ cost_type: 'producer_fee', role_code: 'producer', rank_applied: rank });
    }
    return out;
  }

  /**
   * uid の請求の役割になる担当（Wチェック以外の最初の担当）のランク。無ければ null。
   * 参考単価の解決と受取人指定の判定で、同じランク（＝同じ成果物グループ）を見るために使う。
   */
  function issuerRankApplied(creative, uid) {
    const a = ((creative && creative.creative_assignments) || []).find(x => x && (x.user_id === uid || (x.users && x.users.id === uid))
      && !NON_BILLABLE_ASSIGNMENT_ROLES.includes(x.role));
    return a ? (a.rank_applied ?? null) : null;
  }

  /** 二重請求判定のキー */
  function billedKey(creativeId, costType) { return `${creativeId}::${costType}`; }

  // ---------- 金額 ----------

  /**
   * 単価・数量の入力値を整数に正規化する。
   * '' / null / undefined → { value: null }（未入力）
   * '12,000' / '¥12000' / '１２０００' → 12000
   * 小数・負数・巨大値 → { error }
   */
  function parseMoney(v, { max = MAX_PRICE } = {}) {
    if (v === null || v === undefined) return { value: null };
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v >= max) return { error: '0以上の整数で入力してください' };
      return { value: v };
    }
    let s = String(v).trim();
    if (!s) return { value: null };
    s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[，,¥￥円\s]/g, '');
    if (!/^\d+$/.test(s)) return { error: '0以上の整数で入力してください' };
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n >= max) return { error: '金額が大きすぎます' };
    return { value: n };
  }

  function isCrLine(item) { return !!(item && item.creative_id); }
  function isFixedLine(item) { return !!(item && !item.creative_id && FIXED_COST_TYPES.includes(item.cost_type)); }
  /** エディタの「＋ 立替経費」で足した行か（品目と金額を本人が入れる・数量は 1 固定・理由は不要） */
  function isManualExpenseLine(item) { return !!(item && !item.creative_id && item.cost_type === MANUAL_EXPENSE_COST_TYPE); }
  /** 過払いの調整（マイナス）の行か */
  function isAdjustmentLine(item) { return !!(item && !item.creative_id && item.cost_type === ADJUSTMENT_COST_TYPE); }
  /** HFS外の行か（品目・単価・数量・理由を本人が入れる）。立替経費・過払いの調整の行は含めない */
  function isManualLine(item) { return !!(item && !item.creative_id && !FIXED_COST_TYPES.includes(item.cost_type) && !isManualExpenseLine(item) && !isAdjustmentLine(item)); }
  /** 立替経費（実費）の行か（手で足した行・作業時間報告の行の両方） */
  function isExpenseLine(item) { return !!(item && !item.creative_id && EXPENSE_COST_TYPES.includes(item.cost_type)); }
  /** エディタでの行の種類。cr / fixed（金額固定）/ expense（手で足した立替経費）/ manual（HFS外） */
  function lineKind(item) {
    if (isCrLine(item)) return 'cr';
    if (isFixedLine(item)) return 'fixed';
    if (isAdjustmentLine(item)) return 'adjustment';
    return isManualExpenseLine(item) ? 'expense' : 'manual';
  }

  /** 行の金額（立替経費は実費、それ以外は税抜）。CR 行・固定行・立替経費は 単価×1、HFS外の行は 単価×数量。単価未入力は 0 */
  function lineAmount(item) {
    if (!item) return 0;
    const up = (item.unit_price === null || item.unit_price === undefined || item.unit_price === '') ? 0 : Math.trunc(Number(item.unit_price) || 0);
    if (isManualLine(item)) {
      const q = Math.trunc(Number(item.quantity));
      return up * (Number.isFinite(q) ? q : 0);
    }
    if (isAdjustmentLine(item)) return up === 0 ? 0 : -Math.abs(up); // 過払いの調整はマイナス
    return up;
  }

  /**
   * 合計（サーバーが正）。
   *   subtotal    … 税抜小計 S（立替経費を含まない）
   *   total       … 報酬の税込 S+T（invoices.total_amount。分析・源泉台帳はこの値を使う）
   *   expense     … 立替経費（実費）E。消費税も源泉もかけない
   *   grand_total … ご請求金額 S+T+E（請求書に出す額）
   *   payout      … 差引お振込額 S+T+E−W（invoices.payout_amount）
   * @returns {{ subtotal, tax, total, expense, grand_total, withholding, payout, withholding_over_limit }}
   */
  function computeTotals(items, { withholding_enabled = true } = {}) {
    let subtotal = 0, expense = 0;
    for (const it of (items || [])) {
      if (isExpenseLine(it)) expense += lineAmount(it);
      else subtotal += lineAmount(it);
    }
    // 過払いの調整で小計がマイナスになった下書き（提出は NEGATIVE_SUBTOTAL で止める）でも、消費税・源泉をマイナスにしない
    const taxBase = Math.max(subtotal, 0);
    const tax = Math.floor((taxBase * TAX_NUM) / TAX_DEN);
    const total = subtotal + tax;
    const withholding = withholding_enabled ? Math.floor((taxBase * WH_NUM) / WH_DEN) : 0;
    const grandTotal = total + expense;
    const payout = grandTotal - withholding;
    return {
      subtotal, tax, total, expense, grand_total: grandTotal, withholding, payout,
      withholding_over_limit: !!withholding_enabled && subtotal > WITHHOLDING_WARN_THRESHOLD,
    };
  }

  /**
   * 保存済みの請求書（invoices 行）に含まれる立替経費の額。専用の列は持たず、
   *   差引お振込額 −（報酬の税込 − 源泉）＝ payout_amount −（total_amount − withholding_amount）
   * で求める（新方式のみ。値が欠けている・旧方式・負になる場合は 0）。
   */
  function expenseOfInvoice(inv) {
    if (!inv || inv.tax_mode !== 'exclusive') return 0;
    const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
    const total = n(inv.total_amount), payout = n(inv.payout_amount);
    if (total === null || payout === null) return 0;
    const diff = payout - (total - (n(inv.withholding_amount) || 0));
    return diff > 0 ? diff : 0;
  }

  /** 源泉の既定値: 法人（users.business_type='corporation'）は「なし」、それ以外は「あり」（§7-4） */
  function defaultWithholding(businessType) {
    return businessType !== 'corporation';
  }

  // ---------- 立替経費の日付・支払先・領収書（追補 2026-11-23） ----------

  /**
   * 立替経費の日付の入力値 → 'YYYY-MM-DD'。'2026/10/25' / '2026-10-25' / '２０２６年１０月２５日' を受け付ける。
   * '' / null → { value: null }（未入力）。存在しない日付・形式違いは { error }。TZ 変換はしない（DATE 列）。
   */
  function parseExpenseDate(v) {
    if (v === null || v === undefined) return { value: null };
    const s = String(v).trim().replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    if (!s) return { value: null };
    const m = /^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?$/.exec(s);
    if (!m) return { error: '日付は 2026/10/25 の形で入力してください' };
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) {
      return { error: '存在しない日付です' };
    }
    return { value: `${y}-${pad2(mo)}-${pad2(d)}` };
  }

  /** 領収書の状態の入力値 → 'attached' / 'missing' / null（それ以外は null） */
  function normalizeReceiptStatus(v) {
    return RECEIPT_STATUSES.includes(v) ? v : null;
  }

  /**
   * 「＋ 立替経費」の行の提出前チェック（日付・支払先・領収書）。下書き保存は止めず、提出時だけ止める。
   *   日付（必須）/ 支払先（必須）/ 領収書: 写真を添付（ファイル必須）か「領収書なし」（理由必須）のどちらか
   * 作業時間報告の立替経費（hourly_expense）は対象外。
   */
  function expenseReceiptIssues(item) {
    const out = [];
    if (!isManualExpenseLine(item)) return out;
    if (!dateOnly(item.expense_date) || parseExpenseDate(dateOnly(item.expense_date)).error) {
      out.push({ code: 'EXPENSE_DATE_MISSING', message: '立替経費の日付を入力してください' });
    }
    if (!String(item.expense_payee || '').trim()) {
      out.push({ code: 'EXPENSE_PAYEE_MISSING', message: '支払先を入力してください（例: ENEOS ○○店）' });
    }
    const st = normalizeReceiptStatus(item.receipt_status);
    if (!st) {
      out.push({ code: 'RECEIPT_STATUS_MISSING', message: '領収書の写真を添付するか、「領収書なし」を選んで理由を書いてください' });
    } else if (st === RECEIPT_ATTACHED && !String(item.receipt_file_id || '').trim()) {
      out.push({ code: 'RECEIPT_FILE_MISSING', message: '領収書の写真（または PDF）を添付してください' });
    } else if (st === RECEIPT_MISSING && !String(item.receipt_missing_reason || '').trim()) {
      out.push({ code: 'RECEIPT_REASON_MISSING', message: '領収書がない理由を書いてください（例: レシートを紛失したため）' });
    }
    return out;
  }

  /** 請求書（PDF・プレビュー）で立替経費の行に小さく添える領収書の有無。「＋ 立替経費」の行で状態があるときだけ */
  function receiptNoteOf(item) {
    if (!isManualExpenseLine(item)) return '';
    const st = normalizeReceiptStatus(item && item.receipt_status);
    if (st === RECEIPT_ATTACHED && item.receipt_file_id) return '（領収書あり）';
    if (st === RECEIPT_MISSING) return '（領収書なし）';
    return '';
  }

  // ---------- 行のチェック ----------

  /**
   * 1 行の注意（保存時は警告、提出時はエラー）。
   * refPrice: 参考単価（0 / null なら参考単価超の判定はしない）
   * opts.requireReceipt: false なら立替経費の日付・支払先・領収書を見ない（列がまだ無い環境）。既定は見る
   * @returns {Array<{code, message}>}
   */
  function lineIssues(item, refPrice, opts) {
    const out = [];
    if (!item) return out;
    if (item.unit_price === null || item.unit_price === undefined || item.unit_price === '') {
      out.push({ code: 'PRICE_MISSING', message: isAdjustmentLine(item)
        ? '差し引く金額が未入力です（正の数で入れてください。例: 4000）'
        : '単価が未入力です（0円で出す場合は 0 を入れてください）' });
    }
    if (isCrLine(item)) {
      const ref = Number(refPrice) || 0;
      const up = Number(item.unit_price);
      if (ref > 0 && Number.isFinite(up) && up > ref && !String(item.price_change_reason || '').trim()) {
        out.push({ code: 'OVER_REFERENCE_NO_REASON', message: `参考単価（${ref.toLocaleString('ja-JP')}円）より高い単価には理由が必要です` });
      }
    } else if (isManualExpenseLine(item)) {
      if (!String(item.label || '').trim()) out.push({ code: 'LABEL_MISSING', message: '立替経費の内容を入力してください（例: 10/25 撮影 タクシー代）' });
      // 日付・支払先・領収書（追補 2026-11-23）。列がまだ無い環境（opts.requireReceipt=false）では見ない
      if (!(opts && opts.requireReceipt === false)) out.push(...expenseReceiptIssues(item));
    } else if (isAdjustmentLine(item)) {
      if (!String(item.label || '').trim()) out.push({ code: 'LABEL_MISSING', message: '調整の内容を入力してください（例: 10月分 過払い調整（カット稿））' });
      if (!String(item.manual_reason || '').trim()) out.push({ code: 'ADJUSTMENT_NO_REASON', message: '過払いの調整は理由が必要です（例: 10月分で同じ作業を二重に受け取ったため）' });
      const entered = !(item.unit_price === null || item.unit_price === undefined || item.unit_price === '');
      if (entered && Number(item.unit_price) === 0) out.push({ code: 'ADJUSTMENT_ZERO', message: '差し引く金額を入れてください（0円の調整は出せません）' });
    } else if (isManualLine(item)) {
      if (!String(item.manual_reason || '').trim()) out.push({ code: 'MANUAL_NO_REASON', message: 'HFS外の行は理由が必要です' });
      if (!String(item.label || '').trim()) out.push({ code: 'LABEL_MISSING', message: '品目を入力してください' });
      const q = Number(item.quantity);
      if (!Number.isInteger(q) || q < 1) out.push({ code: 'QUANTITY_INVALID', message: '数量は1以上の整数で入力してください' });
    }
    return out;
  }

  /**
   * 提出時のサーバー再チェック（ADR 046 §3）。1 つでも problems があれば 409 で止める。
   * @param {object} p
   * @param {object[]} p.items              invoice_items（DB の値）
   * @param {string}   p.issuerId           発行者（本人）
   * @param {Map<string, object>} p.creativesById  CR（projects / creative_assignments 込み）
   * @param {Set<string>} p.billedKeys      本人の他の提出済み・承認済み請求書にある billedKey 集合
   * @param {Map<string, number>} p.refPriceByKey  billedKey → 参考単価（提出時点で再計算したもの）
   * @param {Map<string, object>} [p.designationsByCreative]  CR id → 受取人指定（payeeDesignations の結果。issuerCostRoles の opts）
   * @param {boolean}  p.withholdingEnabled
   * @param {number}   p.expectedTotal      画面に出ていたご請求金額（税込）
   * @param {number}   p.expectedPayout     画面に出ていた差引お振込額
   * @param {boolean}  [p.requireReceipt]   false なら立替経費の日付・支払先・領収書を見ない（列が無い環境）。既定は見る
   * @returns {{ problems: Array<{item_id, index, code, message}>, totals }}
   */
  function checkInvoiceForSubmit(p) {
    const items = p.items || [];
    const problems = [];
    const push = (it, idx, code, message) => problems.push({ item_id: it ? (it.id || null) : null, index: idx, code, message });
    if (!items.length) push(null, -1, 'EMPTY', '明細がありません');

    const seen = new Set();
    items.forEach((it, idx) => {
      if (isCrLine(it)) {
        const c = p.creativesById && p.creativesById.get(it.creative_id);
        const key = billedKey(it.creative_id, it.cost_type);
        if (!c) { push(it, idx, 'CREATIVE_NOT_FOUND', 'クリエイティブが見つかりません（削除された可能性があります）'); return; }
        if (!isCreativeOfUser(c, p.issuerId)) { push(it, idx, 'NOT_OWN', '自分が担当していないクリエイティブです'); return; }
        const roles = issuerCostRoles(c, p.issuerId,
          p.designationsByCreative ? p.designationsByCreative.get(c.id) : null).map(r => r.cost_type);
        if (!roles.includes(it.cost_type)) push(it, idx, 'NOT_OWN_ROLE', 'この役割では請求できません');
        if (!isBillableCreative(c, c.projects)) push(it, idx, 'NOT_DELIVERED', '納品済みではありません（未納品は請求できません）');
        if (p.billedKeys && p.billedKeys.has(key)) push(it, idx, 'DUPLICATE', '同じクリエイティブ・役割がすでに別の請求書で提出されています');
        if (seen.has(key)) push(it, idx, 'DUPLICATE_IN_INVOICE', 'この請求書の中で同じクリエイティブ・役割が重複しています');
        seen.add(key);
      }
      const ref = isCrLine(it) && p.refPriceByKey ? p.refPriceByKey.get(billedKey(it.creative_id, it.cost_type)) : null;
      for (const iss of lineIssues(it, ref, { requireReceipt: p.requireReceipt !== false })) push(it, idx, iss.code, iss.message);
    });

    const totals = computeTotals(items, { withholding_enabled: !!p.withholdingEnabled });
    // 過払いの調整を引いた結果、報酬がマイナスになる請求書は出せない（残りは翌月以降の請求で差し引く）
    if (totals.subtotal < 0) {
      push(null, -1, 'NEGATIVE_SUBTOTAL', `過払いの調整を引くと報酬（税抜）がマイナスになります（${totals.subtotal.toLocaleString('ja-JP')}円）。引ききれない分は翌月以降の請求で差し引いてください`);
    }
    const et = Number(p.expectedTotal), ep = Number(p.expectedPayout);
    // 画面の「ご請求金額」は立替経費込み（grand_total）
    if (!Number.isFinite(et) || !Number.isFinite(ep) || et !== totals.grand_total || ep !== totals.payout) {
      push(null, -1, 'TOTAL_MISMATCH', `画面の合計とサーバーの再計算が一致しません（ご請求金額 ${totals.grand_total.toLocaleString('ja-JP')}円 / 差引お振込額 ${totals.payout.toLocaleString('ja-JP')}円）。再読み込みしてください`);
    }
    return { problems, totals };
  }

  // 明細の品目名（クライアント｜CR名（役割））。編集（base_fee）は役割を付けない（請求書に「（編集）」と出ると不自然なため）
  function crItemLabel(clientName, creativeLabel, costType, roleLabel) {
    const role = costType === 'base_fee' ? '' : (roleLabel || '');
    return `${clientName || ''}${clientName ? '｜' : ''}${creativeLabel || ''}${role ? `（${role}）` : ''}`;
  }

  /** 過払いの調整の行の品目名（提出時の PDF と エディタの「PDFを見る」で同じ表記）。「【過払いの調整】品目（理由）」 */
  function adjustmentItemLabel(item) {
    const name = String((item && item.label) || '').trim();
    const why = String((item && item.manual_reason) || '').trim();
    return `【過払いの調整】${name}${why ? `（${why}）` : ''}`;
  }

  /**
   * 立替経費の行の品目名（提出時の PDF と エディタの「PDFを見る」で同じ表記にする）。
   *   手で足した行        … 「立替経費（実費）｜10/25 撮影 タクシー代」
   *   作業時間報告の行    … 「立替経費（作業時間報告）（実費）」（名前に「立替経費」が入っていれば後ろに付けるだけ）
   */
  function expenseItemLabel(item) {
    const raw = isManualExpenseLine(item) ? item.label : (item.creative_label || item.label);
    const name = String(raw || '').trim();
    return /立替経費/.test(name) ? `${name}（実費）` : `立替経費（実費）｜${name || '明細'}`;
  }

  // ---------- 検索・並び替え（作成モーダル・エディタ共通） ----------

  /**
   * 検索用の正規化。全角/半角・大文字/小文字・ひらがな/カタカナ・空白や区切り記号（_ - . / ・ 括弧 など）の違いを無視する。
   * 例: 'ﾊﾞﾙｾﾛﾅ_15s' / 'ばるせろな 15S' → 'バルセロナ15s'
   */
  function searchNorm(v) {
    return String(v ?? '').normalize('NFKC').toLowerCase()
      .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
      .replace(/[\s_\-‐－—―・.,、。/\\|()（）\[\]［］「」【】]/g, '');
  }

  /** 空白区切りの語がすべて text に含まれるか（AND）。語が無ければ true */
  function matchesSearch(text, query) {
    const words = String(query ?? '').normalize('NFKC').split(/\s+/).map(searchNorm).filter(Boolean);
    if (!words.length) return true;
    const t = searchNorm(text);
    return words.every(w => t.includes(w));
  }

  const SORT_MODES = ['date_desc', 'date_asc', 'client'];

  /**
   * 並び替え（元の配列は変えない）。CR 行だけ並べ替え、作業時間・一式・HFS外の行は元の順で後ろに置く。
   *   date_desc: 納品日が新しい順 / date_asc: 納品日が古い順 / client: クライアント名順（同じクライアントは納品日が古い順）
   * 行は { creative_id, billing_date, client_name, creative_label|file_name } を持つ（エディタの行・モーダルの候補どちらでも可）
   */
  function sortRows(rows, mode) {
    const list = (rows || []).map((r, i) => ({ r, i }));
    const isCr = (x) => !!(x.r && x.r.creative_id);
    const date = (x) => String(x.r.billing_date || '');
    const name = (x) => String(x.r.creative_label || x.r.file_name || '');
    const client = (x) => String(x.r.client_name || '');
    const cmpDate = (a, b) => date(a).localeCompare(date(b));
    const cmp = {
      date_desc: (a, b) => -cmpDate(a, b) || name(a).localeCompare(name(b), 'ja'),
      date_asc: (a, b) => cmpDate(a, b) || name(a).localeCompare(name(b), 'ja'),
      client: (a, b) => (!client(a) - !client(b)) || client(a).localeCompare(client(b), 'ja') || cmpDate(a, b) || name(a).localeCompare(name(b), 'ja'),
    }[mode];
    if (!cmp) return list.map(x => x.r);
    const cr = list.filter(isCr).sort((a, b) => cmp(a, b) || (a.i - b.i));
    return cr.concat(list.filter(x => !isCr(x))).map(x => x.r);
  }

  return {
    TAX_NUM, TAX_DEN, WH_NUM, WH_DEN, WITHHOLDING_WARN_THRESHOLD, LOOKBACK_MONTHS, DEFAULT_EXCLUSIVE_FROM,
    REASON_MAX, LABEL_MAX, MAX_PRICE, MAX_QUANTITY, MAX_ITEMS,
    COST_TYPE_LABELS, FIXED_COST_TYPES, CR_COST_TYPES, EXPENSE_COST_TYPES, MANUAL_EXPENSE_COST_TYPE, ADJUSTMENT_COST_TYPE, BILLED_STATUSES, NON_BILLABLE_ASSIGNMENT_ROLES,
    RECEIPT_ATTACHED, RECEIPT_MISSING, RECEIPT_STATUSES, PAYEE_MAX,
    parseExpenseDate, normalizeReceiptStatus, expenseReceiptIssues, receiptNoteOf,
    ymOf, addMonthsYm, jstDateOfIso, dateOnly, jstMonthRangeIso, paymentDueDate, invoiceDate,
    parseExclusiveFrom, isExclusiveYm,
    billingTimingOf, isBillableCreative, billingDateOf, lookbackStartYm, previousStartYm, classifyCandidate,
    issuerCostRoles, issuerRankApplied, billedKey,
    parseMoney, isCrLine, isFixedLine, isManualLine, isExpenseLine, isManualExpenseLine, isAdjustmentLine, lineKind,
    lineAmount, computeTotals, expenseOfInvoice, defaultWithholding,
    lineIssues, checkInvoiceForSubmit, crItemLabel, expenseItemLabel, adjustmentItemLabel,
    searchNorm, matchesSearch, SORT_MODES, sortRows,
  };
});

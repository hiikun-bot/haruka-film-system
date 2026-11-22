// utils/invoice-unlock.js
// メンバー請求書の「提出後に直すためのロック解除」（ADR 046 追補 2026-11-22）の純関数。
//
//   ・管理者が提出済みの請求書を本人が直せる状態（status='rejected'）へ戻すとき、
//     「修正のためロックを外す（unlock）」と「不備で差し戻す（reject）」を区別する。
//     DB 列は足さず、invoices.rejection_reason の先頭の固定文言（UNLOCK_PREFIX）で見分ける。
//   ・本人・管理者へ送る通知文面、理由の検証、「提出後に直したい」申請の可否と連打防止。
//
// 金額・明細・PDF・源泉の計算には関わらない。
//
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/invoice-unlock')
//   - ブラウザ: server.js が /js/invoice-unlock.js で配信 → window.InvoiceUnlockUtils
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.InvoiceUnlockUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND_UNLOCK = 'unlock';
  const KIND_REJECT = 'reject';

  // rejection_reason の先頭に付ける固定文言。一度使い始めたら変えない（DB に文字列で残るため）。
  const UNLOCK_PREFIX = '修正のためロック解除: ';
  // 末尾の空白の有無・コロンの全角/半角が違っても unlock と読めるようにする
  const UNLOCK_PREFIX_RE = /^修正のためロック解除\s*[:：]\s*/;

  const REASON_MAX = 500;
  // 同じ請求書への「提出後に直したい」申請を受け付ける間隔
  const UNLOCK_REQUEST_INTERVAL_MS = 10 * 60 * 1000;

  function normalizeKind(kind) {
    return String(kind || '').trim() === KIND_UNLOCK ? KIND_UNLOCK : KIND_REJECT;
  }

  // 理由（必須）。改行コードをそろえ、前後の空白を落とす。
  function validateReason(raw, opts) {
    const max = (opts && opts.max) || REASON_MAX;
    const label = (opts && opts.label) || '理由';
    const value = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
    if (!value) return { error: `${label}を入力してください` };
    if (value.length > max) return { error: `${label}は${max}文字以内で入力してください` };
    return { value };
  }

  // DB（invoices.rejection_reason）へ入れる文字列。unlock は先頭に固定文言を付ける。
  function buildRejectionReason(kind, reason) {
    const body = String(reason == null ? '' : reason).replace(UNLOCK_PREFIX_RE, '').trim();
    return normalizeKind(kind) === KIND_UNLOCK ? `${UNLOCK_PREFIX}${body}` : body;
  }

  // rejection_reason から種別と本文を取り出す。
  function parseRejectionReason(stored) {
    const s = String(stored == null ? '' : stored);
    if (UNLOCK_PREFIX_RE.test(s)) return { kind: KIND_UNLOCK, reason: s.replace(UNLOCK_PREFIX_RE, '').trim() };
    return { kind: KIND_REJECT, reason: s.trim() };
  }

  function isUnlockReason(stored) {
    return parseRejectionReason(stored).kind === KIND_UNLOCK;
  }

  // メンバー請求書（invoice_type が 'member' または未設定）だけが対象。クライアント宛ての請求書は対象外。
  function isMemberInvoice(inv) {
    if (!inv) return false;
    const t = inv.invoice_type;
    return t == null || t === '' || t === 'member';
  }

  // 「2026年10月分」。年月が無い請求書は空文字。
  function invoiceMonthLabel(inv) {
    const y = Number(inv && inv.year);
    const m = Number(inv && inv.month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || y <= 0 || m < 1 || m > 12) return '';
    return `${y}年${m}月分`;
  }

  // 画面に出す状態の見え方。unlock で戻した請求書は「差し戻し」の赤ではなく落ち着いた色にする。
  function returnedDisplay(inv) {
    if (!inv || inv.status !== 'rejected') return null;
    const p = parseRejectionReason(inv.rejection_reason);
    if (p.kind === KIND_UNLOCK) {
      return {
        kind: KIND_UNLOCK,
        statusLabel: '修正できます',
        heading: '修正できる状態です',
        note: '直したら、もう一度提出してください。',
        reason: p.reason,
        color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4',
      };
    }
    return {
      kind: KIND_REJECT,
      statusLabel: '差し戻し',
      heading: '差し戻し理由',
      note: '',
      reason: p.reason,
      color: '#A32D2D', bg: '#FFEBEE', border: '#F09595',
    };
  }

  // 本人が「提出後に直したい」を申請できるか。
  // 提出済み（submitted）の自分のメンバー請求書だけ。承認済み（approved）は不可。
  function unlockRequestError(inv, userId) {
    if (!inv) return { status: 404, error: '請求書が見つかりません' };
    if (!userId || String(inv.issuer_id || '') !== String(userId)) {
      return { status: 403, error: '自分の請求書だけ申請できます' };
    }
    if (!isMemberInvoice(inv)) return { status: 400, error: 'この請求書は対象外です' };
    if (inv.status === 'approved') {
      return { status: 400, error: '承認済みの請求書は申請できません。管理者に直接相談してください' };
    }
    if (inv.status === 'draft' || inv.status === 'rejected') {
      return { status: 400, error: 'この請求書はすでに修正できる状態です。請求書を開いて直してください' };
    }
    if (inv.status !== 'submitted') return { status: 400, error: '提出済みの請求書だけ申請できます' };
    return null;
  }

  // 管理者が戻せる（差し戻し／ロック解除できる）状態か。提出済みだけ。
  function canReturnToMember(inv) {
    return !!inv && inv.status === 'submitted';
  }

  // ---- 文面 ----

  // 本人へ: 管理者が請求書を修正できる状態に戻した
  function buildReturnedMessage(params) {
    const p = params || {};
    const kind = normalizeKind(p.kind);
    const month = invoiceMonthLabel(p.invoice);
    const what = `${month ? month + 'の' : ''}請求書`;
    const number = p.invoice && p.invoice.invoice_number ? `（${p.invoice.invoice_number}）` : '';
    const reason = String(p.reason || '').trim();
    const title = kind === KIND_UNLOCK
      ? `🔓 ${what}を修正できるようにしました`
      : `↩︎ ${what}が差し戻されました`;
    const lead = kind === KIND_UNLOCK
      ? `${what}${number}のロックを外しました。いまは修正できる状態です。`
      : `${what}${number}に確認してほしい点があり、差し戻しました。`;
    const reasonLine = `${kind === KIND_UNLOCK ? 'メモ' : '理由'}: ${reason || '（記載なし）'}`;
    const howTo = '請求書（マイページ）から開いて直し、もう一度提出してください。';
    const caution = '※ もう一度提出するまで、この請求書は提出済みの扱いになりません。';
    const lines = [lead, reasonLine, howTo, caution];
    const urlLine = p.url ? `開く: ${p.url}` : '';
    return {
      title,
      body: [reasonLine, howTo].join('\n'),
      chatwork: `[info][title]${title}[/title]${lines.concat(urlLine ? [urlLine] : []).join('\n')}[/info]`,
      slack: [`*${title}*`].concat(lines, p.url ? [`<${p.url}|請求書を開く>`] : []).join('\n'),
    };
  }

  // 管理者へ: メンバーから「提出後に直したい」申請が届いた
  function buildUnlockRequestMessage(params) {
    const p = params || {};
    const month = invoiceMonthLabel(p.invoice);
    const number = p.invoice && p.invoice.invoice_number ? `（${p.invoice.invoice_number}）` : '';
    const title = '✏️ 請求書を提出後に直したい、と申請が届きました';
    const lines = [
      `申請した人: ${String(p.requesterName || '').trim() || '不明'}さん`,
      `請求書: ${month || '（年月不明）'}${number}`,
      `理由: ${String(p.reason || '').trim() || '（記載なし）'}`,
      '請求書を開いて「🔓 修正のためロックを外す」を押すと、本人が直せるようになります（本人へ自動で通知されます）。',
    ];
    if (p.url) lines.push(`開く: ${p.url}`);
    return { title, chatwork: `[info][title]${title}[/title]${lines.join('\n')}[/info]` };
  }

  // ---- 連打防止（同じ請求書への申請は一定時間に 1 回）----
  // プロセス内の Map で持つ（DB に申請の状態を持たない方針）。再起動で消えるが、目的は連打の抑止なので足りる。
  function createRequestThrottle(intervalMs) {
    const interval = Number(intervalMs) > 0 ? Number(intervalMs) : UNLOCK_REQUEST_INTERVAL_MS;
    const last = new Map();
    return {
      // 受け付けられるなら { ok:true }、まだなら { ok:false, retryAfterMs, retryAfterMinutes }
      check(key, now) {
        const t = Number.isFinite(now) ? now : Date.now();
        const prev = last.get(String(key));
        if (prev != null && t - prev < interval) {
          const retryAfterMs = interval - (t - prev);
          return { ok: false, retryAfterMs, retryAfterMinutes: Math.max(1, Math.ceil(retryAfterMs / 60000)) };
        }
        return { ok: true };
      },
      mark(key, now) {
        const t = Number.isFinite(now) ? now : Date.now();
        // 古い記録を掃除（Map が増え続けないように）
        for (const [k, v] of last) { if (t - v >= interval) last.delete(k); }
        last.set(String(key), t);
      },
      clear(key) { last.delete(String(key)); },
      size() { return last.size; },
    };
  }

  return {
    KIND_UNLOCK, KIND_REJECT, UNLOCK_PREFIX, REASON_MAX, UNLOCK_REQUEST_INTERVAL_MS,
    normalizeKind, validateReason, buildRejectionReason, parseRejectionReason, isUnlockReason,
    isMemberInvoice, invoiceMonthLabel, returnedDisplay,
    unlockRequestError, canReturnToMember,
    buildReturnedMessage, buildUnlockRequestMessage,
    createRequestThrottle,
  };
});

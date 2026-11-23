// utils/invoice-type.js — 「メンバー請求書」かどうかの判定を 1 か所にまとめる（ADR 054 追補 2026-11-22）
// =============================================================
// invoices.invoice_type の実データ:
//   'client' … クライアント宛ての請求書（INV タブ）
//   'member' … メンバー（スタッフ）が出す請求書。本番はこちらが全件
//   NULL     … 古い行・列を指定せずに作った行。メンバー請求書として扱う
//
// メンバー請求書 ＝ invoice_type が NULL、または 'client' 以外。
//
// 注意:
//   - `.is('invoice_type', null)` だけだと 'member' の行を 1 件も拾えない（源泉徴収台帳・総合振込が請求書を見失った原因）。
//   - `.neq('invoice_type', 'client')` だけだと SQL の三値論理で NULL の行が落ちる。
//   どちらも単独では使わず、必ずこのファイルのヘルパーを通す。
// テスト: tests/invoice-type.test.js
// =============================================================

const CLIENT_INVOICE_TYPE = 'client';

/** PostgREST の or フィルタ（NULL も 'client' 以外も拾う） */
const MEMBER_INVOICE_OR_FILTER = `invoice_type.is.null,invoice_type.neq.${CLIENT_INVOICE_TYPE}`;

/** 請求書の行がメンバー請求書か（invoice_type が NULL / 未設定 / 'client' 以外） */
function isMemberInvoice(inv) {
  return !!inv && inv.invoice_type !== CLIENT_INVOICE_TYPE;
}

/** invoices への問い合わせをメンバー請求書だけに絞る（他の条件とは AND でつながる） */
function onlyMemberInvoices(query) {
  return query.or(MEMBER_INVOICE_OR_FILTER);
}

module.exports = { CLIENT_INVOICE_TYPE, MEMBER_INVOICE_OR_FILTER, isMemberInvoice, onlyMemberInvoices };

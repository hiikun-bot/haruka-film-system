// utils/invoice-unlock.js（請求書の「提出後に直すためのロック解除」・ADR 046 追補 2026-11-22）の純関数テスト
const U = require('../../utils/invoice-unlock');

describe('normalizeKind', () => {
  test('unlock だけ unlock、それ以外・未指定は reject', () => {
    expect(U.normalizeKind('unlock')).toBe('unlock');
    expect(U.normalizeKind(' unlock ')).toBe('unlock');
    expect(U.normalizeKind('reject')).toBe('reject');
    expect(U.normalizeKind(undefined)).toBe('reject');
    expect(U.normalizeKind('UNLOCK')).toBe('reject');
    expect(U.normalizeKind({})).toBe('reject');
  });
});

describe('validateReason', () => {
  test('空・空白だけはエラー（理由は必須）', () => {
    expect(U.validateReason('').error).toMatch(/入力してください/);
    expect(U.validateReason('  \n ').error).toMatch(/入力してください/);
    expect(U.validateReason(null).error).toBeTruthy();
    expect(U.validateReason(undefined).error).toBeTruthy();
  });
  test('前後の空白を落とし、CRLF を LF にそろえる', () => {
    expect(U.validateReason('  1件足したい\r\nです  ')).toEqual({ value: '1件足したい\nです' });
  });
  test('長すぎるとエラー（上限ちょうどは通る）', () => {
    expect(U.validateReason('あ'.repeat(U.REASON_MAX)).value).toHaveLength(U.REASON_MAX);
    expect(U.validateReason('あ'.repeat(U.REASON_MAX + 1)).error).toMatch(/500文字以内/);
  });
  test('ラベルを文言に入れられる', () => {
    expect(U.validateReason('', { label: '差し戻し理由' }).error).toBe('差し戻し理由を入力してください');
  });
});

describe('buildRejectionReason / parseRejectionReason', () => {
  test('unlock は先頭に固定文言が付き、読み戻すと unlock と本文に分かれる', () => {
    const stored = U.buildRejectionReason('unlock', '入れ忘れを足す');
    expect(stored).toBe('修正のためロック解除: 入れ忘れを足す');
    expect(U.parseRejectionReason(stored)).toEqual({ kind: 'unlock', reason: '入れ忘れを足す' });
    expect(U.isUnlockReason(stored)).toBe(true);
  });
  test('reject は理由そのまま', () => {
    const stored = U.buildRejectionReason('reject', '単価が違います');
    expect(stored).toBe('単価が違います');
    expect(U.parseRejectionReason(stored)).toEqual({ kind: 'reject', reason: '単価が違います' });
    expect(U.isUnlockReason(stored)).toBe(false);
  });
  test('固定文言を二重に付けない', () => {
    const once = U.buildRejectionReason('unlock', 'メモ');
    expect(U.buildRejectionReason('unlock', once)).toBe(once);
  });
  test('reject で保存するときは、理由の先頭に固定文言を書かれても unlock に化けない', () => {
    const stored = U.buildRejectionReason('reject', '修正のためロック解除: と書いてある');
    expect(U.parseRejectionReason(stored).kind).toBe('reject');
  });
  test('全角コロン・空白ゆれでも unlock と読める', () => {
    expect(U.parseRejectionReason('修正のためロック解除：メモ')).toEqual({ kind: 'unlock', reason: 'メモ' });
    expect(U.parseRejectionReason('修正のためロック解除:メモ')).toEqual({ kind: 'unlock', reason: 'メモ' });
  });
  test('過去の差し戻し（固定文言なし・空・null）は reject', () => {
    expect(U.parseRejectionReason('金額の確認をお願いします').kind).toBe('reject');
    expect(U.parseRejectionReason('')).toEqual({ kind: 'reject', reason: '' });
    expect(U.parseRejectionReason(null)).toEqual({ kind: 'reject', reason: '' });
    // 文中に出てくるだけでは unlock にしない
    expect(U.parseRejectionReason('先日の修正のためロック解除: の件').kind).toBe('reject');
  });
});

describe('isMemberInvoice', () => {
  test("invoice_type が 'member' か未設定だけ対象", () => {
    expect(U.isMemberInvoice({ invoice_type: 'member' })).toBe(true);
    expect(U.isMemberInvoice({ invoice_type: null })).toBe(true);
    expect(U.isMemberInvoice({})).toBe(true);
    expect(U.isMemberInvoice({ invoice_type: 'client' })).toBe(false);
    expect(U.isMemberInvoice(null)).toBe(false);
  });
});

describe('invoiceMonthLabel', () => {
  test('年月から「YYYY年M月分」', () => {
    expect(U.invoiceMonthLabel({ year: 2026, month: 10 })).toBe('2026年10月分');
    expect(U.invoiceMonthLabel({ year: '2027', month: '1' })).toBe('2027年1月分');
  });
  test('年月が欠けている・範囲外は空文字', () => {
    expect(U.invoiceMonthLabel({ year: 2026 })).toBe('');
    expect(U.invoiceMonthLabel({ year: 2026, month: 13 })).toBe('');
    expect(U.invoiceMonthLabel(null)).toBe('');
  });
});

describe('returnedDisplay', () => {
  test('rejected 以外は null（再提出後に古い理由を出さない）', () => {
    expect(U.returnedDisplay({ status: 'submitted', rejection_reason: '修正のためロック解除: x' })).toBeNull();
    expect(U.returnedDisplay({ status: 'draft' })).toBeNull();
    expect(U.returnedDisplay(null)).toBeNull();
  });
  test('ロック解除は「修正できる状態です」で、差し戻しの赤を使わない', () => {
    const d = U.returnedDisplay({ status: 'rejected', rejection_reason: '修正のためロック解除: 1件足す' });
    expect(d.kind).toBe('unlock');
    expect(d.heading).toBe('修正できる状態です');
    expect(d.statusLabel).toBe('修正できます');
    expect(d.reason).toBe('1件足す');
    expect(d.color).not.toBe('#A32D2D');
  });
  test('差し戻しは「差し戻し理由」', () => {
    const d = U.returnedDisplay({ status: 'rejected', rejection_reason: '単価が違います' });
    expect(d).toMatchObject({ kind: 'reject', heading: '差し戻し理由', statusLabel: '差し戻し', reason: '単価が違います', color: '#A32D2D' });
  });
});

describe('unlockRequestError（本人の「提出後に直したい」申請の可否）', () => {
  const base = { id: 'inv1', issuer_id: 'u1', status: 'submitted', invoice_type: 'member' };
  test('提出済みの自分のメンバー請求書は申請できる', () => {
    expect(U.unlockRequestError(base, 'u1')).toBeNull();
    expect(U.unlockRequestError({ ...base, invoice_type: null }, 'u1')).toBeNull();
  });
  test('請求書が無ければ 404', () => {
    expect(U.unlockRequestError(null, 'u1').status).toBe(404);
  });
  test('他人の請求書は 403（ユーザー不明も 403）', () => {
    expect(U.unlockRequestError(base, 'u2').status).toBe(403);
    expect(U.unlockRequestError(base, null).status).toBe(403);
    expect(U.unlockRequestError({ ...base, issuer_id: null }, undefined).status).toBe(403);
  });
  test('承認済みは申請できない', () => {
    const r = U.unlockRequestError({ ...base, status: 'approved' }, 'u1');
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/承認済み/);
  });
  test('下書き・差し戻し中はすでに直せるので申請不要', () => {
    expect(U.unlockRequestError({ ...base, status: 'draft' }, 'u1').error).toMatch(/すでに修正できる/);
    expect(U.unlockRequestError({ ...base, status: 'rejected' }, 'u1').error).toMatch(/すでに修正できる/);
  });
  test('クライアント宛ての請求書は対象外', () => {
    expect(U.unlockRequestError({ ...base, invoice_type: 'client' }, 'u1').status).toBe(400);
  });
  test('その他の状態（issued 等）は不可', () => {
    expect(U.unlockRequestError({ ...base, status: 'issued' }, 'u1').status).toBe(400);
  });
});

describe('canReturnToMember', () => {
  test('提出済みだけ戻せる', () => {
    expect(U.canReturnToMember({ status: 'submitted' })).toBe(true);
    for (const status of ['draft', 'rejected', 'approved', 'issued']) {
      expect(U.canReturnToMember({ status })).toBe(false);
    }
    expect(U.canReturnToMember(null)).toBe(false);
  });
});

describe('buildReturnedMessage（本人への通知）', () => {
  const invoice = { id: 'inv1', invoice_number: 'INV-2026-10-001', year: 2026, month: 10 };
  const url = 'https://example.test/haruka.html?page=invoices&invoice=inv1';

  test('ロック解除: 何月分か・メモ・直して再提出の案内・リンクが入る', () => {
    const m = U.buildReturnedMessage({ kind: 'unlock', invoice, reason: '1件足してください', url });
    expect(m.title).toBe('🔓 2026年10月分の請求書を修正できるようにしました');
    expect(m.chatwork).toContain('[info][title]🔓 2026年10月分の請求書を修正できるようにしました[/title]');
    expect(m.chatwork).toContain('INV-2026-10-001');
    expect(m.chatwork).toContain('メモ: 1件足してください');
    expect(m.chatwork).toContain('請求書（マイページ）から開いて直し、もう一度提出してください。');
    expect(m.chatwork).toContain(`開く: ${url}`);
    expect(m.chatwork).not.toContain('差し戻');
    expect(m.slack).toContain(`<${url}|請求書を開く>`);
    expect(m.body).toContain('メモ: 1件足してください');
  });
  test('差し戻し: 題と「理由:」が差し戻し用になる', () => {
    const m = U.buildReturnedMessage({ kind: 'reject', invoice, reason: '単価が違います', url });
    expect(m.title).toBe('↩︎ 2026年10月分の請求書が差し戻されました');
    expect(m.chatwork).toContain('理由: 単価が違います');
    expect(m.chatwork).toContain('請求書（マイページ）から開いて直し、もう一度提出してください。');
    expect(m.chatwork).not.toContain('ロックを外しました');
  });
  test('kind 未指定は差し戻し扱い・URL が無ければリンク行を出さない・年月が無くても崩れない', () => {
    const m = U.buildReturnedMessage({ invoice: { id: 'x' }, reason: 'r', url: null });
    expect(m.title).toBe('↩︎ 請求書が差し戻されました');
    expect(m.chatwork).not.toContain('開く:');
    expect(m.slack).not.toContain('請求書を開く');
  });
  test('文面に金額を含めない', () => {
    const m = U.buildReturnedMessage({ kind: 'unlock', invoice: { ...invoice, total_amount: 123456, payout_amount: 111111 }, reason: 'r', url });
    expect(m.chatwork).not.toMatch(/123456|123,456|111111|¥/);
  });
});

describe('buildUnlockRequestMessage（管理者のマイチャットへの一報）', () => {
  test('誰の・何月分・理由・リンクが入る', () => {
    const m = U.buildUnlockRequestMessage({
      requesterName: 'たろ（山田太郎）',
      invoice: { invoice_number: 'INV-1', year: 2026, month: 11 },
      reason: '1件入れ忘れました',
      url: 'https://example.test/haruka.html?page=invoices&invoice_unlock=inv1',
    });
    expect(m.chatwork).toContain('[info][title]✏️ 請求書を提出後に直したい、と申請が届きました[/title]');
    expect(m.chatwork).toContain('申請した人: たろ（山田太郎）さん');
    expect(m.chatwork).toContain('請求書: 2026年11月分（INV-1）');
    expect(m.chatwork).toContain('理由: 1件入れ忘れました');
    expect(m.chatwork).toContain('🔓 修正のためロックを外す');
    expect(m.chatwork).toContain('開く: https://example.test/haruka.html?page=invoices&invoice_unlock=inv1');
  });
  test('名前・年月・URL が無くても崩れない', () => {
    const m = U.buildUnlockRequestMessage({ invoice: {}, reason: 'r' });
    expect(m.chatwork).toContain('申請した人: 不明さん');
    expect(m.chatwork).toContain('請求書: （年月不明）');
    expect(m.chatwork).not.toContain('開く:');
  });
});

describe('createRequestThrottle（同じ請求書への申請は 10 分に 1 回）', () => {
  const T0 = Date.UTC(2026, 10, 22, 1, 0, 0);
  test('初回は通り、10 分以内の 2 回目は止まり、10 分たてば通る', () => {
    const th = U.createRequestThrottle();
    expect(th.check('inv1', T0)).toEqual({ ok: true });
    th.mark('inv1', T0);
    const again = th.check('inv1', T0 + 3 * 60 * 1000);
    expect(again.ok).toBe(false);
    expect(again.retryAfterMinutes).toBe(7);
    expect(th.check('inv1', T0 + U.UNLOCK_REQUEST_INTERVAL_MS - 1).ok).toBe(false);
    expect(th.check('inv1', T0 + U.UNLOCK_REQUEST_INTERVAL_MS).ok).toBe(true);
  });
  test('別の請求書は巻き込まない', () => {
    const th = U.createRequestThrottle();
    th.mark('inv1', T0);
    expect(th.check('inv2', T0 + 1000).ok).toBe(true);
  });
  test('check だけでは記録しない（送信に失敗したら送り直せる）・clear で解除', () => {
    const th = U.createRequestThrottle();
    th.check('inv1', T0);
    expect(th.check('inv1', T0 + 1).ok).toBe(true);
    th.mark('inv1', T0);
    th.clear('inv1');
    expect(th.check('inv1', T0 + 1).ok).toBe(true);
  });
  test('期限切れの記録は mark のときに掃除される', () => {
    const th = U.createRequestThrottle(1000);
    th.mark('a', T0);
    th.mark('b', T0 + 500);
    expect(th.size()).toBe(2);
    th.mark('c', T0 + 1200); // a は期限切れ
    expect(th.size()).toBe(2);
    expect(th.check('a', T0 + 1200).ok).toBe(true);
    expect(th.check('b', T0 + 1200).ok).toBe(false);
  });
  test('残り時間の分表示は切り上げ・最低 1 分', () => {
    const th = U.createRequestThrottle();
    th.mark('inv1', T0);
    expect(th.check('inv1', T0 + U.UNLOCK_REQUEST_INTERVAL_MS - 10).retryAfterMinutes).toBe(1);
    expect(th.check('inv1', T0 + 1).retryAfterMinutes).toBe(10);
  });
});

describe('ブラウザ（UMD）でも同じ API が window に出る', () => {
  test('module が無い環境では root.InvoiceUnlockUtils に入る', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../utils/invoice-unlock.js'), 'utf8');
    const self = {};
    // eslint-disable-next-line no-new-func
    new Function('self', 'module', src)(self, undefined);
    expect(typeof self.InvoiceUnlockUtils.returnedDisplay).toBe('function');
    expect(self.InvoiceUnlockUtils.UNLOCK_PREFIX).toBe(U.UNLOCK_PREFIX);
  });
});

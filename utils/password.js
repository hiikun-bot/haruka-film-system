/**
 * パスワードポリシー（サーバー側の唯一の正）
 *
 * 画面表記（パスワード変更モーダル / 招待登録 / 管理者リセットの prompt）は
 * 以前から「半角英字・数字・記号（8文字以上 / 全角・スペース不可）」と案内していたが、
 * 実際には長さしか検証しておらず、全角・スペースのみのパスワードが登録できていた。
 * 表記どおりに弾くため、判定をここへ集約する。
 *
 * 許可: ASCII 0x21-0x7E（半角の英字・数字・記号）
 * 不許可: 全角、半角/全角スペース、タブ・制御文字、絵文字
 *
 * 注意: 既存パスワードのログイン（bcrypt.compare）には一切適用しない。
 *       ポリシー導入前に全角で登録済みの人がログインできなくなるのを避けるため、
 *       検証するのは「新しく設定するパスワード」だけ。
 */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_ALLOWED_RE = /^[\x21-\x7E]+$/;

/**
 * @param {unknown} password
 * @returns {string|null} 問題なければ null、あればユーザー向けエラーメッセージ
 */
function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'パスワードを入力してください';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `パスワードは${PASSWORD_MIN_LENGTH}文字以上必要です`;
  }
  if (!PASSWORD_ALLOWED_RE.test(password)) {
    return 'パスワードは半角の英字・数字・記号のみ使用できます（全角・スペースは使えません）';
  }
  return null;
}

module.exports = { validateNewPassword, PASSWORD_MIN_LENGTH, PASSWORD_ALLOWED_RE };

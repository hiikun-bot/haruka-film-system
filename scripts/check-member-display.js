#!/usr/bin/env node
/**
 * メンバー名表示の標準逸脱を検出する CI ガード（PR #952/#954 の再発防止）
 *
 * 背景: users テーブルに `name` 列は無い（正: full_name / nickname）。
 * `m.name || m.email` のようなコードは email フォールバックで「壊れずに動く」ため
 * 人間のレビューをすり抜け、メンバー選択 UI がメールアドレスの羅列になる事故が
 * 2 度発生した（ADR 014 の棚卸し漏れ）。以下のルールで機械的に検出する。
 *
 *   ルール1: `.name || X.email` — 存在しない users.name 参照＋email フォールバック
 *   ルール2: `<option>` の表示テキストにメンバーの email を使っている
 *            （NameDisplay / memberLabel 経由の最終フォールバックは許容）
 *   ルール3: `<option>` でメンバー名（full_name / nickname）を直書きしている
 *            （NameDisplay / memberLabel を通すこと — PR #502 の全画面標準）
 *
 * 対象: public/**&#47;*.html, public/js/**&#47;*.js
 * 使い方: node scripts/check-member-display.js  （違反があれば exit 1）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET_DIRS = ['public'];
const TARGET_EXT = new Set(['.html', '.js']);

// この標準を定義している側のファイルは対象外
const EXCLUDE_FILES = new Set([
  path.join('public', 'js', 'name-display.js'),
  path.join('public', 'js', 'member-picker.js'),
]);

function listFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p));
    else if (TARGET_EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

// 許容ヘルパー: この行に居れば「標準経由」とみなす
const ALLOWED_HELPERS = /NameDisplay|memberLabel/;

const RULES = [
  {
    id: 'no-users-name-column',
    // users に .name 列は無い。email フォールバック付きの .name 参照は事故の温床。
    // 例外: currentUser は /auth/me 由来で、server.js safeUser() が name を補完している
    test: (line) => {
      const m = line.match(/([\w$]+)\.name\s*\|\|\s*[\w$.]*\.?email\b/);
      return !!m && m[1] !== 'currentUser';
    },
    message: 'users に `name` 列はありません（email に落ちて表示されます）。NameDisplay.full(m) を使ってください',
  },
  {
    id: 'no-email-as-member-label',
    // <option> の表示にメンバー email を使わない（NameDisplay 経由の最終フォールバックは許容）
    test: (line) => /<option[^\n]*\$\{[^}\n]*\.email/.test(line) && !ALLOWED_HELPERS.test(line),
    message: 'メンバーの表示ラベルに email を使わないでください。MemberPicker（ADR 014）か NameDisplay.full(m) を使ってください',
  },
  {
    id: 'no-raw-member-name-in-option',
    // <option> でメンバー名を直書きしない（全画面「ニックネーム（名前）」統一 = PR #502）
    test: (line) => /<option[^\n]*\$\{[^}\n]*\.(full_name|nickname)\b/.test(line) && !ALLOWED_HELPERS.test(line),
    message: 'メンバー名の直書きは禁止です（PR #502 全画面標準）。NameDisplay.full(m) か MemberPicker を使ってください',
  },
];

let violations = 0;
for (const dir of TARGET_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of listFiles(abs)) {
    const rel = path.relative(ROOT, file);
    if (EXCLUDE_FILES.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.test(line)) {
          violations++;
          console.log(`✖ ${rel}:${i + 1} [${rule.id}]`);
          console.log(`   ${line.trim().slice(0, 160)}`);
          console.log(`   → ${rule.message}\n`);
        }
      }
    });
  }
}

if (violations > 0) {
  console.error(`NG: メンバー名表示の標準逸脱が ${violations} 件見つかりました。`);
  process.exit(1);
}
console.log('OK: メンバー名表示の標準逸脱はありません。');

#!/usr/bin/env bash
# scripts/dev-db/dump-prod-schema.sh — 本番DBの「表の形」だけを書き出す（データは一切含めない）
#
# 何をするか:
#   pg_dump --schema-only で public スキーマの定義（テーブル・列・制約・インデックス・関数・
#   トリガー・RLS・ポリシー）を scripts/dev-db/.out/prod-schema.sql に書き出す。
#   本番に対しては「読むだけ」。行データ（COPY / INSERT）は含まれない。
#   書き出し後、データ文が混ざっていないかを自動で検査し、混ざっていたらファイルを消して中止する。
#
# 使い方（docs/dev-db-setup.md 手順 3）:
#   PROD_DATABASE_URL='postgresql://postgres.<本番ref>:<パスワード>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres' \
#     bash scripts/dev-db/dump-prod-schema.sh
#   もしくは .env.production-readonly に PROD_DATABASE_URL を書いておけば自動で読む（git 管理外）。
#
# 前提:
#   - pg_dump（本番の Postgres と同じか新しいメジャー版）: brew install libpq && brew link --force libpq
#   - 接続はセッションプーラー(5432) か直結。トランザクションプーラー(6543)は pg_dump 不可。
#
# 出力先 scripts/dev-db/.out/ は .gitignore 済み（コミットしない）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/.out"
OUT_FILE="${1:-$OUT_DIR/prod-schema.sql}"
READONLY_ENV="$ROOT_DIR/.env.production-readonly"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "❌ pg_dump が見つかりません。brew install libpq && brew link --force libpq で入れてください" >&2
  exit 1
fi

# PROD_DATABASE_URL が無ければ .env.production-readonly から読む（値は表示しない）
if [ -z "${PROD_DATABASE_URL:-}" ] && [ -f "$READONLY_ENV" ]; then
  PROD_DATABASE_URL="$(cd "$ROOT_DIR" && node -e "const d=require('dotenv').parse(require('fs').readFileSync(process.argv[1]));process.stdout.write(d.PROD_DATABASE_URL||'')" "$READONLY_ENV")"
fi
if [ -z "${PROD_DATABASE_URL:-}" ]; then
  echo "❌ PROD_DATABASE_URL（本番の Postgres 接続文字列）が未設定です" >&2
  exit 1
fi

echo "pg_dump: $(pg_dump --version)"
echo "本番から public スキーマの定義だけを書き出します（データは含めません）"
mkdir -p "$(dirname "$OUT_FILE")"

# --schema-only : 行データを含めない
# --schema=public: アプリの表だけ（auth / storage / realtime など Supabase 管理のスキーマは除外）
# --no-owner / --no-privileges: 所有者・GRANT は開発プロジェクト側の既定（Supabase の既定権限）に任せる
PGCONNECT_TIMEOUT=30 pg_dump "$PROD_DATABASE_URL" \
  --schema-only \
  --schema=public \
  --no-owner \
  --no-privileges \
  --file="$OUT_FILE"

# データ文が混ざっていないか検査（混ざっていたら消して中止）
if ! (cd "$ROOT_DIR" && node -e "
const fs = require('fs');
const lib = require('./scripts/dev-db/lib');
const sql = lib.stripPsqlMetaCommands(fs.readFileSync(process.argv[1], 'utf8'));
const hits = lib.findDataStatements(lib.splitSqlStatements(sql));
if (hits.length) { console.error('❌ データを含む文が ' + hits.length + ' 件あります（スキーマのみのはず）'); process.exit(1); }
" "$OUT_FILE"); then
  rm -f "$OUT_FILE"
  echo "❌ 出力にデータが含まれていたため削除しました" >&2
  exit 1
fi

echo "✅ 書き出し完了: $OUT_FILE（$(wc -l < "$OUT_FILE" | tr -d ' ') 行）"
echo "   次: node scripts/dev-db/apply-schema.js --yes   （開発DBへ当てる）"

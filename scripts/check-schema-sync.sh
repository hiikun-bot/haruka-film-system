#!/usr/bin/env bash
# migrations/*.sql に出てくる識別子（テーブル名・列名）が
# supabase_schema.sql 側にも書かれているかを軽く確認する整合チェック。
#
# 厳密な型チェック等はせず、grep ベースで「定義漏れの兆候」を出すだけ。
# fail はしない（exit 0 固定）。CI から呼ばれてもブロックしない。
#
# 使い方:
#   bash scripts/check-schema-sync.sh

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="${ROOT_DIR}/migrations"
SCHEMA_FILE="${ROOT_DIR}/supabase_schema.sql"

if [ ! -d "$MIG_DIR" ]; then
  echo "[check-schema-sync] migrations/ が無いのでスキップ"
  exit 0
fi
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "[check-schema-sync] supabase_schema.sql が無いのでスキップ"
  exit 0
fi

WARNINGS=0

echo "[check-schema-sync] migrations/ を走査中..."

# CREATE TABLE foo (
# CREATE TABLE IF NOT EXISTS foo (
# ALTER TABLE foo ADD COLUMN bar
# を抽出する。
for f in "$MIG_DIR"/*.sql; do
  [ -f "$f" ] || continue
  base=$(basename "$f")

  # CREATE TABLE
  while IFS= read -r tbl; do
    [ -z "$tbl" ] && continue
    if ! grep -qiE "create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?(public\.)?${tbl}\b" "$SCHEMA_FILE"; then
      echo "  ⚠️  ${base}: テーブル '${tbl}' が supabase_schema.sql に見当たりません"
      WARNINGS=$((WARNINGS + 1))
    fi
  done < <(grep -iEho "create[[:space:]]+table[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?(public\.)?[a-z_][a-z0-9_]*" "$f" \
            | sed -E 's/.*[[:space:]]+(public\.)?([a-z_][a-z0-9_]*)$/\2/I' \
            | sort -u)

  # ALTER TABLE foo ADD COLUMN bar
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    tbl=$(echo "$line" | awk '{print $1}')
    col=$(echo "$line" | awk '{print $2}')
    [ -z "$tbl" ] || [ -z "$col" ] && continue
    # supabase_schema.sql に該当列名が一切登場しなければ警告
    if ! grep -qiE "\b${col}\b" "$SCHEMA_FILE"; then
      echo "  ⚠️  ${base}: 列 '${tbl}.${col}' が supabase_schema.sql に見当たりません"
      WARNINGS=$((WARNINGS + 1))
    fi
  done < <(grep -iEho "alter[[:space:]]+table[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?(public\.)?[a-z_][a-z0-9_]*[[:space:]]+add[[:space:]]+column[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?[a-z_][a-z0-9_]*" "$f" \
            | sed -E 's/^alter[[:space:]]+table[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?(public\.)?([a-z_][a-z0-9_]*)[[:space:]]+add[[:space:]]+column[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?([a-z_][a-z0-9_]*).*/\3 \5/I' \
            | sort -u)
done

echo ""
if [ "$WARNINGS" -gt 0 ]; then
  echo "[check-schema-sync] 警告 ${WARNINGS} 件: supabase_schema.sql への追記漏れの可能性があります"
  echo "（migration はあくまで差分。schema.sql は完成形を維持してください）"
else
  echo "[check-schema-sync] OK: 不整合の兆候は見つかりませんでした"
fi

# 警告は出すが exit 0（fail させない）
exit 0

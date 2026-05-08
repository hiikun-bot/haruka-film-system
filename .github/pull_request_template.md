# Pull Request

## 概要
<!-- 何を変更したか・なぜ変更したかを1〜3行で -->

## 影響範囲（必ず記載）
- [ ] スマホのみ（`@media` CSS / スマホ専用ドロワー等）
- [ ] PC のみ（共有JS/HTML/サーバー/DB）
- [ ] 両方（共有ロジック変更）

## 関連 Issue
<!-- 例: closes #12 -->

## 他チャットへの影響
- mobile: 影響なし / あり（理由: ）
- PC: 影響なし / あり（理由: ）

## テスト項目
- [ ] スマホ実機（Railway PR Preview URL）で確認
- [ ] PC ブラウザ（幅 1280px+）で表示・動作が変わっていないこと
- [ ] 既存機能の回帰がないこと

## 🗄 DB変更（migration を含む場合）
- [ ] `migrations/` に新規SQLを追加した場合、本番Supabaseに適用済み（または計画あり）
- [ ] `supabase_schema.sql` に同じ定義を追記した
- [ ] 適用後、PR に `db-migration-applied` ラベルを付与した
> ※ `migrations/**` 変更を含む PR には CI が自動で `needs-db-migration` ラベルを付与し、`db-migration-applied` が付くまで `migration-applied` チェックが fail します。詳細: [docs/db-migration-workflow.md](../blob/main/docs/db-migration-workflow.md)

## スクリーンショット / 動画（UI変更の場合）
<!-- Before / After を貼る -->

## レビュー観点
<!-- どこを重点的に見てほしいか -->

## 🆙 Verup情報
<!--
このセクションを記入すると、main にマージされた瞬間に自動で「Verup情報」一覧に掲載されます。
不要な PR（refactor / chore / 内部整理 など）は **このセクションごと丸ごと削除** するか
`skip-verup` ラベルを付けてください。
画面 / 機能 / 修正 が空欄の場合は登録されません。
-->
- 種別: improvement   <!-- feature / improvement / bugfix / spec_change -->
- 重要度: normal       <!-- high / normal / low -->
- 画面:                <!-- 例) 案件 / クリエイティブ / 請求 / クライアント / メンバー / 全体 -->
- 機能:                <!-- 例) ファイル名テンプレ -->
- 修正:                <!-- 何がどう変わったか1-2行（必須） -->
- 変更前:              <!-- 任意。Before/After で対比したい時に -->
- 変更後:              <!-- 任意。Before/After で対比したい時に -->
- 便利なシーン:        <!-- 任意。「こういう時に役立つ」を1行 -->
- 対象ロール: all      <!-- all / admin / secretary / producer / director / editor / designer のカンマ区切り -->
- タグ:                <!-- 任意。例) ファイル名,動画 -->
- バージョン:          <!-- 任意。例) v1.4.2 -->

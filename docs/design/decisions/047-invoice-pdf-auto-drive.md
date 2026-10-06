# ADR 047: システムで作った請求書は PDF をその月の Drive 請求書フォルダへ自動保存する

- Status: Accepted
- Date: 2026-10-06
- Related: メンバー請求書フォルダ（`migrations/2026-05-17_member_invoice_folders.sql` / `POST /members/:id/invoice-folders/generate`）, 振込管理（`utils/payout.js` の `extractInvoiceAmount`・Drive スキャン）, ADR 046（請求書テンプレの下書き・PR #1202）, ADR 015（VIEW AS）

## Context

メンバーの請求フローは「請求書タブで作成 → 提出 → 管理者承認」と「PDF を Drive の `請求書/YYYY年/MM月/氏名 YYYY年MM月` フォルダへ入れる（振込管理が月次でスキャン）」の二本立てになっている。システムで請求書を作っても、PDF は各自が 🖨 PDF出力（`window.print`）で保存して Drive に手で上げる必要があり、

1. フォルダへの格納忘れ・別月フォルダへの誤格納が起きる
2. 印刷ダイアログの出力結果（ヘッダー/フッターの有無・用紙）が人によって違う
3. 下書きのまま提出した PDF と、提出後に修正された内容がずれる

という手間と事故があった。さとるさんから「請求書システムでつくった場合、PDF が自動的にその月の Google ドライブフォルダに入るように連携してほしい」と依頼。

制約:
- 本番は Railway の `node:22-slim`。headless Chrome を足すとイメージとメモリが大きく増える
- 外部の有料 API は使わない（コスト承諾ルール）
- Drive の請求書フォルダは SA（`GOOGLE_SERVICE_ACCOUNT_KEY`）で既に作成・権限付与しており、同じ経路で書ける
- 振込管理は「フォルダ内の PDF 全部」を請求書とみなして金額を抽出・合算する。PDF が増殖すると二重計上になる

## Decision

1. **サーバー側で pdfkit を使って PDF を描く**（`utils/invoice-pdf.js`）。見た目は画面の `printInvoice()` と同じ構成（請求先/請求者・ご請求金額・クリエイティブ単位の明細・税抜小計/消費税/合計・振込先・備考）。日本語フォントは `assets/fonts/NotoSansJP-{Regular,Bold}.otf`（OFL、日本語サブセット約 4.5MB×2）をリポジトリに同梱し、PDF には使った文字だけ埋め込む。
2. **保存タイミングは「作成時」と「提出時」**。`POST /invoices/generate` と `POST /invoices/:id/submit` の成功後に自動で保存し、提出時は下書き中の修正を反映して**同名で上書き**する。失敗しても作成・提出は成功扱い（レスポンスの `drive_pdf_error` とトーストで知らせ、「📁 Driveへ保存」で手動やり直し）。
3. **置き場所は本人の `member_invoice_folders`（issuer × 請求書の year/month）**。無ければ `POST /members/:id/invoice-folders/generate` と同じ手順でその場で作る（年/月フォルダ・同姓同名回避・本人＋管理者群に writer）。
4. **ファイル名は `請求書_YYYY年M月_高橋宛_氏名_INV-番号.pdf`**（画面の印刷タイトルから日付を抜いたもの）。同じ請求書は Drive 上を name 検索して**上書き**するので、何度作り直しても 1 請求書 = 1 PDF。**DB 列は増やさない**（migration 無し）。
5. **削除時はゴミ箱送り**。`DELETE /invoices/:id` で同名 PDF を `trashed=true` にする（完全削除はしない）。残すと振込管理が拾って二重計上になるため。
6. 対象は**メンバー請求書のみ**。クライアント請求書（`invoice_type='client'`）はフォルダ体系が違うので対象外。
7. 無効化は環境変数 `INVOICE_PDF_DRIVE_SYNC=off`。

```
┌ 請求書（マイページ）────────────────────────────────┐
│ INV-202609-003  2026年9月 / ショート動画     [提出済み] │
│ [修正] [削除] [🖨 PDF出力] [📁 Driveへ保存]             │
└─────────────────────────────────────────────────┘
   作成 ─┐                      Drive: 請求書/2026年/09月/國貞 優衣 2026年09月/
   提出 ─┼─ 自動 ─▶ 同名で上書き   └ 請求書_2026年9月_高橋宛_國貞優衣_INV-202609-003.pdf
   削除 ─┘           ゴミ箱へ
```

## Consequences

- メンバーは「作成 → 提出」だけで PDF がフォルダに入る。手で上げるのは、ADR 046 のテンプレ（スプレッドシート）で作った人だけ。
- 振込管理のスキャンは従来どおり PDF を拾う。`extractInvoiceAmount` が「ご請求金額」直後の金額を取る前提なので、PDF でも見出しと金額を続けて描いている（jest で並びを固定）。
- 税抜小計の計算を `Math.floor(total / 1.1)` から整数演算 `Math.floor(total * 10 / 11)` に変えた（27,500 が 24,999 になる浮動小数の 1 円ずれ）。画面の印刷プレビューも同じ式に揃えた。
- 請求先の表記は画面と同じ「HARUKA FILM / 高橋聖 様」のまま。法人化（2026-09-22）後の宛名（株式会社HARUKA FILM 御中）に変えるかは別途判断（変えるときは `buildInvoicePdfModel` の `recipient` と `printInvoice()` を同時に直す）。
- PR #1202（ADR 046）がマージされたら、フォルダ確保のフォールバック `ensureInvoiceMonthFolderForUser` は #1202 の `ensureMemberInvoiceMonthFolder` / `resolveInvoiceMemberFolderLabel` に寄せる（挙動は同じ）。
- リポジトリに約 9MB のフォントが入る（Docker イメージも同量増）。

## Alternatives

- **headless Chrome（puppeteer）で印刷 HTML をそのまま PDF 化**: 見た目は完全一致するが、イメージ +400MB・メモリ増・Railway でのクラッシュリスク。却下。
- **HTML を Drive で Google ドキュメントに変換 → PDF export**: 依存ゼロだが flex レイアウトが崩れ、表の幅・余白が制御できない。却下。
- **ADR 046 のスプレッドシートを PDF export**: テンプレは単価を本人が入れる前提で、システムの請求書とは別物。混ぜない。
- **ブラウザ側で PDF を作ってアップロード**: 「自動で入る」にならない（ボタンを押す人の環境依存）。却下。
- **invoices に drive_file_id 列を足す**: 確実だが migration の段階マージが必要。同名上書きで要件を満たせるので今回は列を足さない。

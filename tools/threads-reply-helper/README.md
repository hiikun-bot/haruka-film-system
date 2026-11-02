# Threads → ChatGPT 返信支援（APIなし）

Threadsの画面を1クリックで撮影し、ログイン済みのChatGPT入力画面を開いて返信依頼とスクリーンショットを準備するChrome拡張の試作版です。OpenAI API・APIキー・従量課金は使いません。

## 操作

1. ChromeでThreads（threads.com または threads.net）を開き、返信対象の投稿を画面中央に表示する。
2. ブラウザーの拡張機能アイコンをクリック。または投稿を右クリックし「ChatGPTでこの投稿の返信文を考える」から返信スタイルを選択。
3. Chrome拡張が現在表示中のThreadsタブをPNGスクリーンショットに撮り、画像をクリップボードへコピーすることを試みる。
4. 新しいChatGPTタブが開き、返信指示文を入力し、画像の自動添付を試みる。
5. 添付画像が表示されているかを確認する。画像が表示されない場合は入力欄を選択し、Macは ⌘+V、Windowsは Ctrl+V でスクリーンショットを貼り付ける。
6. **ChatGPTの送信ボタンを押して返信を生成**し、文章を確認して、ChatGPT標準の「コピー」ボタンを押す。
7. Threadsの返信欄に貼り付けて送信する。

**重要：完全自動ではありません。** 送信操作と完成文章のコピーは本人が行います。OpenAI利用規約では ChatGPT の Output のプログラムによる自動抽出が禁止されているため、プログラムから回答を監視して自動コピーする機能は実装していません。

## インストール

1. GitHubのこのブランチをZIPで取得するか、ローカルにクローンする。
2. Chromeで `chrome://extensions/` を開いて「デベロッパーモード」を有効化。
3. 「パッケージ化されていない拡張機能を読み込む」を選び、この `tools/threads-reply-helper` フォルダを指定。
4. ChatGPT にログインしていることを確認。
5. Threadsの画面で実行する。

## コスト

- Chrome拡張自体の利用料は0円。
- GitHubの無料枠で管理できます。
- OpenAI APIの利用はありません。
- ChatGPT本体は利用プラン・回数制限の対象です。ChatGPTが完全に無制限で無料になるものではありません。

## 仕組みと注意事項

- `chrome.tabs.captureVisibleTab` でクリック時に表示中のThreads画面を撮影します。画面全体に他人の情報や通知が映り込む場合は操作前に確認してください。
- 画像は拡張機能の `chrome.storage.session` に一時保持され、ChatGPTタブへ送信されます。GitHubや独自のサーバーへアップロードしません。
- ChatGPTは独立したWebサイトであり、DOM構造や画像添付のUIが変わると自動入力・添付が動かなくなる場合があります。
- 画像が自動添付されたように見えてもプレビューを確認してから送信してください。
- 複数の投稿が見える場合、対象が曖昧になります。返信対象を画面中央に置いてください。
- クリップボード書き込みの許可がないなどの理由でコピーに失敗する可能性があります。その場合はChromeの画面キャプチャ機能等で画像を手動で添付してください。
- 自動投稿、ChatGPTの回答のスクレイピング・自動コピー、無人巡回は行いません。
- 実際のChatGPTログイン環境での動作検証はまだ実施していません。

## 公式情報

- ChatGPTへの画像入力 https://help.openai.com/en/articles/8400551-chatgpt-image-inputs-faq
- Chrome offscreen API https://developer.chrome.com/docs/extensions/reference/api/offscreen
- OpenAI 利用規約 https://openai.com/policies/terms-of-use/

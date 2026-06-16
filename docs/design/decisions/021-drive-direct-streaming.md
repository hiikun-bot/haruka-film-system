# ADR 021: 動画プレビューを Drive 直リンクで配信する（Railway プロキシ廃止）

- Status: Proposed
- Date: 2026-05-22
- Scope: ファイルプレビュー / 動画再生（`routes/haruka.js:/files/:fileId/stream`、`public/haruka.html` の `openFilePreview`）
- Related: ADR 018 / 019 / 020 (素材広場・user OAuth)、`lib/drive-share.js`

## Context

現状、クリエイティブ詳細のファイルプレビューで動画を開くと **Railway 経由でストリーミング** している:

```
Browser  ──Range──→  Railway (/files/:id/stream)  ──Range──→  Drive
         ←─stream─                                ←─stream─
```

具体的には [`routes/haruka.js:8281` の `/files/:fileId/stream`](routes/haruka.js#L8281) が
`drive.files.get({ alt: 'media' }).data.pipe(res)` で SA 経由に Drive ストリームを
ブラウザへ転送している。

### 観測されている問題

- 初回ロードに 5〜10 秒かかり、シーク中に「読み込み中」になる
- Google Workspace を契約しているのに **Google CDN の地理的最適化が一切活かせていない**
  （Railway 1 ノードを全ユーザーで共有してるため）
- Railway の帯域・CPU を動画転送が常時占有

### Drive 自体の配信は速い

Drive は YouTube と同じ Google のグローバル CDN 上で配信されるので、
ブラウザから直接アクセスできれば実体感は数倍速い。
既に `lib/drive-share.js` でクライアントレビュー用に
`permissions.create({ role:'reader', type:'anyone' })` + `webViewLink` 取得の
パターンを実運用している。

## Decision

**動画プレビューを開く際、可能であれば Drive 直リンクで `<video src>` を構成し、
不可能な場合のみ従来の Railway プロキシ経由にフォールバックする** 2 段構えにする。

### 実装方針

1. **新規エンドポイント** `GET /api/files/:fileId/direct-url`
   - 権限チェック（既存 `/files/:fileId/stream` と同じロール判定）
   - 対象ファイルに対して `lib/drive-share.js` の `ensureAnyoneReader` パターンを再利用して
     `permissions.create({ role:'reader', type:'anyone' })` を idempotent に実行
   - `webContentLink`（streaming 可能な直接URL）と `webViewLink`（fallback）を返却
   - faststart 版が存在すれば優先

2. **フロント** `openFilePreview` で動画ファイルの場合のみ:
   - まず `/api/files/:fileId/direct-url` を呼び、直リンク取得を試みる
   - 取得成功 → `<video src="{webContentLink}">` で直接 Drive から stream
   - 取得失敗 / 非 mp4 等 → 既存の `/files/:fileId/stream` プロキシ経由にフォールバック

3. **段階的ロールアウト**
   - Phase 1 (PoC): 動画のみ対応。画像 / PDF は据え置き
   - Phase 2: 効果測定して画像にも展開判断

### 採用するセキュリティモデル

Drive ファイルに `type: 'anyone', role: 'reader'` を idempotent に付与する。
これは既に `client_review_url` 発行時の運用と**同じ**であり、
追加のセキュリティリスクは発生しない（むしろ「クライアントに渡す前」の
動画にも anyone reader を付ける点が拡張）。

リンクを知っている第三者はファイルにアクセスできるが、
HARUKA FILM の動画は基本的に **撮影素材・編集中の中間物** で、
クライアント納品前にも anyone reader 化される運用と整合する。

### なぜこの方式か（採用理由）

- ブラウザ ↔ Drive の **2 ホップ → 1 ホップ** に減らせる
- Google CDN の地理最適化が効く（ユーザーは東京・日本各地・将来は海外）
- Railway の帯域コスト・CPU を解放
- **追加料金ゼロ**（既存の Google Workspace 内で完結）
- 失敗時は既存プロキシに fallback できるので **PoC のリスクが小さい**

## Consequences

### 良い点

- 動画プレビューの体感速度が数倍改善する見込み
- Railway 帯域・CPU が解放され、他機能（msquare 解析等）に振り向けられる
- 既存 `drive-share.js` の運用と同じセキュリティモデルなので学習コストゼロ
- フォールバック前提なので段階移行できる

### 悪い点・リスク

- **anyone reader を全レビュー対象動画に拡大**：リンク漏洩で第三者閲覧の可能性
  - 緩和策: 機密性が特に高い案件は従来プロキシ経由を強制するフラグ（`creatives.disable_direct_link`）を将来追加可能
- `permissions.create` の API quota（24h で 10,000 req/user 程度）：
  - 緩和策: idempotent なので 2回目以降は早い。permission 一覧をキャッシュして
    既に anyone reader 化済みならスキップ
- `webContentLink` がブラウザ `<video>` で再生できないケース:
  - Drive はファイルサイズによってウイルススキャン警告 HTML を挟むことがある
  - 緩和策: PoC で実機検証 → ダメなら `webViewLink/preview` の iframe 案 or
    `alt=media + SA access_token` URL 直渡し案に切替（ADR を更新）
- **アップロード完了直後のレース**（2026-06-09 実地観測）:
  - アップロード完了の十数秒〜数十秒後にプレビューを開くと、Drive 側の配信準備が
    間に合わず**直リンク・プロキシの両方**が一時的に失敗することがある
    （ファイル自体は健全。数分後には正常配信される。H.264/AAC でも発生）
  - 「アップロード → 即プレビュー確認」は編集者の常用フローなので発生頻度が高い
  - 緩和策: フロントで最終失敗時に 10秒→20秒 の2回まで自動リトライ。
    リトライ残がある間は Slack 自動エラー通知を抑制（リトライも尽きた最終失敗だけ通知）

### 中立

- 旧 `/files/:fileId/stream` は当面残す（fallback とサムネ・画像配信に使う）
- 将来 Cloudflare R2 / Workers でグローバル CDN を入れる場合の前段にもなる

## Alternatives Considered

### A. Cloudflare R2 + CDN

- Drive とは別に R2 にミラーアップロード、CDN 経由で配信
- 帯域無料、地理最適化が世界規模で効く
- **却下**: 月額コスト（R2 ストレージ $0.015/GB/月）が発生、2 系統管理が重い、
  まず Drive 直リンクで足りるか検証する方が先

### B. Cloudflare Workers でプロキシ層を入れ替え

- Railway の代わりに Workers で Drive にプロキシ
- 世界 300 拠点で実行されるので地理最適化が効く
- **却下**: 既存認証層との接続が複雑、PoC のスコープ外

### C. Drive `alt=media + ?access_token={SA token}` 形式の URL を発行

- SA の access_token をブラウザに渡し、`<video src>` で直接叩く
- **却下**: SA token は全 Shared Drive にフルアクセス可能なので、
  URL 漏洩したら社内資産全体の漏洩リスクがある

### D. Drive `/preview` を iframe で埋め込む

- `https://drive.google.com/file/d/{fileId}/preview` を iframe に
- Google のプレイヤーがそのまま使えて Google CDN 経由
- **却下**: クロスオリジン iframe では `video.currentTime` にアクセスできず、
  既存のコメント・ペイント・タイムコード機能が全て動かない

### E. user OAuth で `alt=media` 直叩き

- `drive.file` scope の OAuth トークンで `alt=media` を直叩く
- **却下**: `drive.file` scope は「自分がアップロードしたファイル」のみアクセス可。
  creative_files は SA がアップロードしたケースが多く適用不可

## Migration / Rollout

- Phase 1 (PoC, このADR起票と同時): 動画プレビューのみ対応。失敗時プロキシ fallback
- Phase 2: 体感速度を計測（Lighthouse / 主観評価）→ 全動画レビューで採用判定
- Phase 3: 画像・PDF への適用検討
- Phase 4: 旧プロキシエンドポイントは fallback 用に残すが、Railway 帯域がほぼ消えることを確認

## Status 遷移

- 2026-05-22: Proposed
- PoC 実装後、実機計測（初回ロード時間・シーク応答性）の結果を Consequences に追記して Accepted へ
- 致命的問題が出たら Rejected + 代替案検討

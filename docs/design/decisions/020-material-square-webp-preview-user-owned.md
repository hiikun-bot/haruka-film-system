# ADR 020: 素材広場の WebP プレビューを user OAuth でアップロードする（SA 所有を解消）

- Status: Accepted
- Date: 2026-05-19
- Scope: material-square / preview generation (`lib/faststart.js`)
- Related: ADR 018 (analyze via webp preview), ADR 019 (auto-apply after analyze)

## Context

素材広場フォルダ（Google Shared Drive）への動画アップロードは、
原本 mp4 は user OAuth (Resumable Upload, `drive.file` スコープ) で行われており
**ファイル所有者 = アップロードしたユーザー本人** になっている。

一方、自動生成される WebP プレビュー（60枚ストーリーボード）は
`_processVideoStoryboard` 内で SA (Service Account) クライアントで
`drive.files.create` していたため、**WebP の所有者 = SA** だった。

### 観測されたバグ

`drive.file` スコープの user OAuth は **「自分が作っていないファイル」を
404 Not Found 扱い** する仕様。このため:

- WebP を削除しようとすると "既に削除済" と誤判定（実体は Drive に残る）
- WebP を移動（自動振り分け先フォルダへ）しようとすると
  `insufficientFilePermissions` / 404 を投げ、エラーが握りつぶされる
- 結果: 振り分け後の整理済みフォルダに「ゴミ WebP」が残留／消えない

## Decision

**WebP プレビューも user OAuth で Drive にアップロードする**。

- `_processVideoStoryboard()` に `uploadAsUserDrive` 引数を追加
  - user OAuth 由来の Drive クライアントを受け取った場合、
    最終 `files.create` と `permissions.create` のみそのクライアントを使う
  - メタデータ取得・原本動画 DL・フレーム抽出は引き続き SA で実行（読み取りは SA でも可能、トークンを長時間消費しない）
- `generatePreviewForVideoOrg()` で `row.created_by` から user OAuth token を
  `googleOAuth.getValidAccessToken()` で取得し、`driveLib.driveClientWithToken()` で
  Drive クライアント化して `_processVideoStoryboard` に渡す

### Fallback 方針

以下のいずれかに該当する場合は **SA でアップロード（既存挙動）にフォールバック**:

- `row.created_by` が NULL（旧データ・OAuth 不要パスから INSERT された行）
- user が OAuth 連携していない or refresh_token 失効
- user OAuth でのアップロード自体が例外を投げた場合

フォールバックを採用する理由: プレビュー生成自体は止めない方が UX 上望ましい。
SA 所有の WebP に対しては別途 Hybrid 対応（並行 PR
`claude/fix-msquare-sa-fallback-for-preview`）で削除・移動を救う。

## Consequences

### Pros
- 新規アップロード分の WebP は user 所有になり、削除・自動振り分けが
  drive.file スコープでも正常に動く（404 silent skip が起きない）
- 原本 mp4 と WebP の所有者が同一ユーザーで揃い、Drive の所有権が
  「アップロード者」に統一される
- SA quota への書き込み圧力が減る

### Cons
- user OAuth token の取得＆refresh が preview 生成のたびに発生する
  （ただし `expires - now > 60s` なら DB read 1 回のみ。コスト誤差）
- user 連携が無いケースのフォールバックロジックが必要
  （ただし既存挙動と同じなので追加のメンテ負担は限定的）

### Migration

DB スキーマ変更は **不要**。
`video_file_organization_tests.created_by` 列は ADR 設計時から存在し、
INSERT パス（resumable / upload 系 route）で `req.user?.id` がセット済み。

### 既存 SA 所有 WebP

本 PR の対象外。並行で動く以下が hybrid 対応で救う:

- PR `claude/fix-msquare-sa-fallback-for-preview`
  「user OAuth で 404 が返った時に SA でリトライ」を追加し、
  古い SA 所有 WebP も削除・移動できるようにする

## Alternatives

1. **SA で全部 own して、ユーザー側は SA 経由でしか操作させない**
   - 却下: drive.file スコープで user OAuth に切り替えた経緯
     （Drive 全体への過剰権限を SA から外したい）と逆行する
2. **WebP も user OAuth で削除・移動だけ追加権限を SA→user に転送する**
   - 却下: `permissions.create` で owner 譲渡が必要だが
     Shared Drive 上でアクセス権限の再設定が SA から user への譲渡を
     許さないケースがあり、確実に動かない
3. **Hybrid のみで対応（user OAuth 失敗 → SA リトライ）**
   - 並行 PR で実装中。本 PR は「新規アップロード分は SA 所有を生まない」
     根治療法として、Hybrid と組み合わせる

## Implementation pointers

- `lib/faststart.js` `_processVideoStoryboard({ ..., uploadAsUserDrive })`
- `lib/faststart.js` `generatePreviewForVideoOrg({ rowId })` の token 取得・
  user Drive クライアント化
- `lib/google-oauth.js` `getValidAccessToken({ userId, scopeKey: 'drive.file' })`
- `lib/video-organization/drive.js` `driveClientWithToken(accessToken)`

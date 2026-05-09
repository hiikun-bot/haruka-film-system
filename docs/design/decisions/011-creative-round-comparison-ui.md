---
adr: 011
status: Accepted
date: 2026-05-09
tags: [creatives, ui, history, rounds, review]
related_tables: [creatives, creative_version_history, creative_files]
supersedes: null
superseded_by: null
---

# 011. クリエイティブ詳細モーダルの「ラウンド比較型UI」と round 履歴の正規化

- **Status**: Accepted
- **Date**: 2026-05-09
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

クリエイティブ詳細モーダル（`#modal-creative-detail`）は **修正回数が増えると過去ラウンドのDチェック指摘と今回の指摘内容を「縦スクロール往復」で比較する** UIになっており、3回目以降に視認コストが急増していた。

### 現状の保存形

`creatives` テーブルの単一カラムでコメントが保持されている。

| カラム | 用途 | 上書き挙動 |
|---|---|---|
| `creatives.director_comment` | チェック段階で書かれる「修正指示・承認コメント」 | **次のラウンドで上書きされる** |
| `creatives.editor_comment`   | 編集者からの返信 / 提出時連絡事項              | **次のラウンドで上書きされる** |
| `creatives.client_comment`   | クライアントからの修正指示                     | 上書き挙動同上 |
| `creatives.memo`             | チーム共有メモ                                  | 永続（ラウンド非依存） |
| `creative_files.version`     | 提出ファイルのバージョン (1=初稿、2=1回目修正…) | 各バージョン保持 |
| `creative_version_history`   | ラウンド履歴用に存在するが **書き込まれていない**（フロントの `loadVersionHistory_DISABLED` で参照されないため） | — |

### ラウンドの定義

- 1ラウンド = `クリエイター提出物 (creative_files version=N) + そのときディレクターから受けた指摘`
- N=0: 初稿提出前 → 単カラム表示で十分
- N=1: 初稿 + 1回目指摘 → 2カラム（左=初稿+指摘①、右=今回の修正中／チェック中）
- N≥2: ◀▶ で過去ラウンドを slide

### なぜ既存スキーマだと困るか

現状の単一カラム上書きでは、**v2 提出時に v1 の指摘内容が消える**。1回目修正時には v1 の指摘が `creatives.director_comment` に残っていても、v2 提出後に Dチェック2回目で新しい指摘が書き込まれた瞬間に v1 の指摘が失われる。**過去ラウンドの可視化はスキーマ拡張なしには不可能**。

## Decision

### 1. ラウンド履歴を `creative_version_history` に正規化して書き込む

既存の `creative_version_history` テーブルを再利用する（廃テーブル化を回避）。スキーマを少しだけ拡張する。

```sql
-- 既存:
-- CREATE TABLE creative_version_history (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
--   version_num INTEGER NOT NULL,
--   director_comment TEXT,
--   client_comment TEXT,
--   created_at TIMESTAMPTZ DEFAULT now()
-- );

ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS editor_comment   TEXT,
  ADD COLUMN IF NOT EXISTS round_stage      TEXT,        -- 'd_check' | 'p_check' | 'cl_check'
  ADD COLUMN IF NOT EXISTS creative_file_id UUID REFERENCES creative_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recorded_by      UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_cvh_creative_round
  ON creative_version_history(creative_id, version_num);
```

- `editor_comment`: そのラウンドで編集者が出した「提出時メモ／連絡事項」を frozen 保存。
- `round_stage`: D / P / CL のどのチェックラウンドかを区別（同じ version_num でも D→P→CL でラウンドが連なる）。
- `creative_file_id`: そのラウンドの「提出ファイル」を確定保存。後から `creative_files.version` が再採番されても紐付け不変。
- `recorded_by`: ラウンドを確定した actor（再提出ボタンを押した人）。監査用。

### 2. ラウンド snapshot の確定タイミング

**「修正済 → 再チェック」へ status 遷移する瞬間に snapshot を確定する**。

| 遷移 | snapshot に書く内容 |
|---|---|
| `Dチェック後修正` → `Dチェック` (再提出)         | `round_stage='d_check'`, version_num=（直前の Dチェック時のファイル version）, `director_comment`=直前の Dチェック指摘, `editor_comment`=今回提出の連絡事項 |
| `Pチェック後修正` → `Pチェック` (再提出)         | 同上 (P) |
| `クライアントチェック後修正` → `クライアントチェック中` (再提出) | 同上 (CL) |
| `Dチェック` → `Dチェック後修正` (修正依頼)       | snapshot しない（指摘内容は次の再提出時に確定） |

これにより、**「指摘 ＋ それに対する次の提出」がペアで frozen** される。指摘だけ書いて中断・キャンセルされたケースは履歴に残らないため、「実際に届いた往復」だけが残るシンプルな履歴になる。

設計上の含意:
- 各ラウンドは 1 つの `creative_version_history` 行で表せる。
- 複数の version_num に対して D / P / CL が走ってもよい（version_num=1 で D指摘、同じ version_num=1 で P指摘というケースもありうる。実運用は稀だが対応可）。
- backfill (既存 creatives): 初期データは「ラウンド0扱い（1枚絵フル幅）」とし、過去履歴は復元しない。これは ADR 上ユーザーに合意を取った前提（過去往復の遡及復元はコストに見合わない）。

### 3. ラウンド比較型 UI（フロント）

`#modal-creative-detail` のレイアウトを **過去ラウンド数 N と現在ステータスに応じて** 切り替える:

| N | ステータス | レイアウト |
|---|---|---|
| 0 | 制作中（初稿提出前） | 1枚絵（既存 UI そのまま） |
| 0 | 初稿の Dチェック | 2カラム: 左=v1+提出メモ, 右=Dの指摘入力 |
| 0 | 初稿の Dチェック後修正 | 2カラム: 左=v1+提出メモ+D指摘①(現在DB), 右=v2 アップロード+メモ |
| 1+ | Dチェック / 後修正等 | 2カラム + ◀▶（ラウンド0までスライド可） |

UI の主要 ID と振る舞い:
- `#cd-round-compare-wrap`: 2カラムラッパ（display:grid; grid-template-columns: 1fr 1fr; gap:16px）
- `#cd-round-left`: 左カラム（読み取り専用、過去ラウンドのデータをスライドで切替）
- `#cd-round-right`: 右カラム（編集中。現状の `cd-comment-field` / `cd-director-note` / `cd-editor-reply` / `cd-upload-section` を内側に集約）
- `#cd-round-prev` / `#cd-round-next`: ◀▶ ボタン
- `#cd-round-dots`: ●○ インジケータ
- `cdRenderRoundCompare()`: モーダルオープン時に `creative_version_history` + 現在 `creatives.director_comment / editor_comment` から左カラムのスライドを構築

ラウンドの順序付け:
- 履歴(`creative_version_history` 全行)を `(version_num ASC, recorded_at ASC)` で並べたものを「過去ラウンド」とする。
- 直前の指摘（=現在 `creatives.director_comment`、まだ snapshot されていないライブ値）も 1 ラウンドとして左カラムの「最新の過去」に連結する（修正中の場合のみ）。

### 4. 既存挙動の維持（互換性）

- `saveCreativeDetail()` の入力経路は不変（`director_comment` / `editor_comment` を `creatives` に書く）。
- snapshot 書き込みは `routes/haruka.js` の `/api/creatives/:id` PUT 内で **status 遷移を検知** して Server 側で実行する。フロントから明示的にスナップショット API を叩かなくて良い設計（同期化バグを避ける）。
- `creative_version_history` の旧書き込みエンドポイント (`POST /creative-versions`) は維持（廃止しない）。フロントは新フローで自動 snapshot を期待するため、明示呼び出しは不要だが残しておく。
- 既存のステータスバー / 「事後修正」 / 「納品完了モード」 / 「下書き保存」は不変。

### 5. モバイル対応

スマホ画面では 2 カラム比較は視認性が悪いため、`@media (max-width:768px)` で 1 カラムに戻し、タブ切替（[前回] / [今回]）で同じ情報にアクセスできるようにする。**本 PR では PC 2カラム / モバイルは現状の積み上げ表示維持** に留め、モバイル最適化は別 Issue で feature/mobile に依頼する（CLAUDE.md のチャット境界遵守）。

## Consequences

### Pros
- 修正3回目以降の比較スクロール往復が消滅。1画面で「前回の指摘 vs 今回の指摘」が見渡せる。
- 過去の指摘・提出メモが frozen 保存されるため、退職・引き継ぎ時にも完全な往復履歴が残る。
- `creative_version_history` という未使用テーブルが息を吹き返し、スキーマの「死蔵テーブル」が減る。
- `creative_files.version` と `creative_version_history.version_num` が紐付けられるため、ファイル削除時にも履歴を残せる（`creative_file_id` は ON DELETE SET NULL）。

### Cons / Trade-offs
- `creative_version_history` への自動 INSERT が増える。チェック遷移ごとに 1 行 / クリエイティブあたり数行 ~ 十数行。許容範囲。
- 既存データの backfill は行わない → 既存クリエイティブの「過去ラウンド」は表示されない（一度の再提出を経て初めて履歴が積み上がり始める）。
- 2カラムは PC 専用。モバイルでは別途タブ UI 対応が必要（feature/mobile スコープ）。

### スキーマ拡張に伴うリスク
- `creative_version_history` 既存行（人手で `POST /creative-versions` から登録した行があれば）には `editor_comment` / `round_stage` / `creative_file_id` / `recorded_by` が NULL のまま残る。UI 側で NULL 許容して描画する。

## 補足: バージョン番号採番ルール（2026-05-09 / 代表 髙橋指示）

**`creative_files.version` ＝ ラウンド番号（version_num）と等しい。**

ラウンドごとのやりとり 1往復につき 1 つ番号が進む。1 つのラウンド中の試行錯誤（アップロード → 取り消し → 再アップロード）ではバージョンは進まない。

### 採番ロジック（POST `/api/creatives/:id/upload`）

```
M = creative_files の MAX(version)  -- そのクリエイティブの現在の最大 version
if M = 0:                                       version = 1
elif M がスナップショット済 (=提出済):           version = M + 1   (次ラウンドへ)
elif M が未スナップショット (=未提出/取消し再アップ): version = M       (同ラウンド維持)
```

具体例（V1 提出 → D指摘 → V2 アップ → 取消 → 再 V2 アップ → V2 提出）:
1. 制作中 / files=[] → V1 アップ。M=0 → version=1
2. Dチェック移行（snapshot は再提出時に作るので V1 はまだ未 snapshot）
3. Dチェック後修正へ（V1 はまだ未 snapshot）

   ⚠ ここで再採番すると M=1 / 未 snapshot → version=1 衝突になりうる。これを避けるために、
   再提出 (=Dチェックへ status 遷移) 時に snapshot を確定する従来仕様に準拠する。
4. V2 アップ。M=1 / V1 は次の `Dチェック` 遷移時に snapshot されるが、まだここでは未 snapshot。
   → 上記ロジックだと version=1 衝突する。

   **回避**: V2 アップロードは「Dチェック後修正」status 中に起きる。再採番ロジックは MAX を
   ベースにしているので、V1 の status 遷移より先に snapshot を作っておくか、または
   「未 snapshot だが status が後修正 → 次のラウンド扱い」とする補正が必要。

実装上は **「V1 が `creative_files` 上に最大 1 行しか無い」かつ「creative_version_history 全体が
空」** のケースでの V2 採番が問題になる。この場合 `_cdComputeNextVersion()` のフロント計算と
サーバ採番が一致するため、サーバ側でも snapshot が空であれば `M+1` を採用する（= 修正ラウンド
入りでバージョンを進める従来挙動を残す）か、あるいは Dチェック→D後修正 遷移時にも軽い
snapshot を作る…という拡張余地がある。

ただし、運用上は **「V1 提出後の D後修正→V2 アップ」フローでは Dチェック → D後修正 の遷移時に
すでに `creatives.director_comment`（指摘文）が書かれており、UI の左カラムは "ライブ仮想ラウンド"
として描画される。このときの V2 アップロードは creative_files の MAX(version)=1 で、`creative_version_history`
にはまだ V1 の snapshot が無い**（snapshot は再提出時に確定するため）。

#### 実装の単純解（採用）

`creative_version_history` テーブルがそもそも空の状態（過去ラウンド 0 件）であっても、
**`creatives.status` が後修正系であれば「すでに 1 ラウンド経過している」とみなし version+1 を返す**
追加分岐を入れる。すなわち:

```
if M = 0:                                       version = 1
elif M がスナップショット済 (=提出済):           version = M + 1
elif (M が未スナップショット) かつ (status が後修正系):
                                               version = M + 1   (追加分岐)
elif M が未スナップショット (それ以外):           version = M       (取消→再アップ等の同ラウンド維持)
```

→ 後修正中の V2 初アップは version=2 で正しく入り、その V2 を取り消して再アップしても
status は後修正のままなので version=2 のまま、と整合する。

### 取り消しボタンの表示条件（厳格化）

旧: ステータスが「制作中」系 かつ 最新ファイル → 取り消し可
新: **当該ファイルが creative_version_history に未 snapshot** かつ 最新ファイル → 取り消し可

これにより：
- V1 を一度 Dチェックへ提出した後は、ステータスが何であれ V1 は取り消せない
- V2 を Dチェックへ提出した後は V2 も取り消せない（Dチェック後修正に戻ってきても）
- 現ラウンドの未提出版（=直近アップで snapshot 未登録）のみ取り消せる

DB 側の DELETE エンドポイントの 409 ガード（`creative_version_history` に snapshot 行があれば拒否）と
UI 表示条件が完全に一致するため、ユーザーが見るボタンと実行可能性が一致する。

## Alternatives Considered

### A. 別テーブル `creative_rounds` を新設
- ❌ 既存の `creative_version_history` と概念が同じ。テーブル二重化を避ける。

### B. 履歴を JSON 配列として `creatives.round_history JSONB` に持つ
- ❌ 検索・集計できない。スキーマ進化が JSON migration 地獄になる。

### C. UIだけ変えて履歴は `creatives.director_comment` の上書きで諦める
- ❌ 過去ラウンドが見えない（スキーマ上残っていないので物理的に不可能）。本 ADR の動機を満たさない。

### D. snapshot を「Dチェック → Dチェック後修正」遷移時に取る
- ❌ 「指摘内容だけ書いて中断」も履歴に残ってしまう。再提出が起きない指摘はラウンドとしてカウントすべきでない（実運用と合わない）。

## Migration / Rollout

### Stage A (本 ADR + 本 PR)
1. migration `2026-05-09_creative_round_history.sql`: スキーマ拡張（4 列追加 + index）。
2. `routes/haruka.js` PUT `/api/creatives/:id` で再提出遷移を検知し snapshot 自動 INSERT。
3. `routes/haruka.js` GET `/api/creatives/:id/rounds` 新規エンドポイント: ラウンド履歴を返す（version_num + creative_file_id + コメント3種を join したもの）。
4. フロント: `#modal-creative-detail` のレイアウトを 2 カラム化、◀▶ スライド実装、`cdRenderRoundCompare()` 追加。
5. PC のみ対応。モバイルは現状維持。

### Stage B (将来)
- モバイル用タブ UI: 別 Issue。
- 「ラウンドの差分ハイライト」（前回指摘との diff 表示）は射程外。

## Related

- ADR 008 (creative_file_comments スレッド): タイムコード単位のコメント。本 ADR は「クリエイティブ単位の往復履歴」で別レイヤー。
- ADR 009 (納品スナップショット): 担当者の凍結。本 ADR は「指摘内容の凍結」で対称。
- 既存テーブル `creative_version_history`: PR #?（過去・廃止状態）。本 ADR で復活。

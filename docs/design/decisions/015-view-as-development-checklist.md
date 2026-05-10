---
adr: 015
status: Accepted
date: 2026-05-10
tags: [view-as, roles, permissions, qa, dev-checklist]
related_tables: [roles, user_roles, role_permissions, permission_keys]
supersedes: null
superseded_by: null
related_adrs: [003]
---

# 015. VIEW AS（ロールプレビュー）を踏まえた開発チェックリスト

- **Status**: Accepted
- **Date**: 2026-05-10
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

最高管理者は VIEW AS（ロールプレビュー）機能で、admin / producer / director / editor / designer / secretary などの実効ロールを切り替えて UI を確認できる。
仕組みは以下のとおり：

- フロント: `previewRole` 変数 + `effectiveRole()` ヘルパー、`apiFetch()` が `X-View-As` ヘッダを自動付与
- サーバー: `auth.js#getEffectiveRole(req)` / `getEffectiveRolePrimary(req)` / `getEffectiveRoleCodes(req)` がヘッダを尊重（最高管理者のリクエストのみ）
- 認可: `requirePermission(key)` ミドルウェアが `getEffectiveRoleCodes` ベースで判定

ところが**権限・ロールに関わる新機能を追加するたびに VIEW AS で壊れる不具合が頻発**しており、開発工数のロスが大きい。再発の典型パターンは以下：

| パターン | 影響 |
|---|---|
| フロントで `currentUser.role` を直書き | UI 出し分けが VIEW AS 切替で更新されない |
| サーバーで `req.user.role` を直書き | API レスポンスがプレビュー時に切り替わらない |
| 新規 API に `requirePermission` を付け忘れ | プレビューで見えるが実際の権限制御が効いていない |
| 新しい `permission_key` を `permission_keys` マスタに登録し忘れ | 権限管理画面に出てこず admin が ON/OFF できない |
| 生 `fetch()` を使う | `X-View-As` ヘッダが送られず VIEW AS が無効化される |
| VIEW AS で動作確認しないまま PR | 本番で発覚 |

## Decision

**ロール・権限・認可・UI 出し分けに関わる実装を行うときは、PR 提出前に必ず本ドキュメントのチェックリストをすべて通す。**

例外なし。サブエージェント（projects-worker / clients-worker / teams-worker / creatives-worker / invoices-worker など）も同じく従うこと。

## チェックリスト

### A. フロントエンド（`public/haruka.html` 等）

- [ ] **UI 出し分け条件は `effectiveRole()` または `hasPermission(key)` を使う**
  - `currentUser.role` / `currentUser?.role` の**直書きは禁止**
  - 例外: 「実ユーザー判定が必須」な箇所のみ直書き可（`isSuperAdmin()` の中、自己編集判定 `currentUser.id === xxx` 等）。例外箇所には**理由を1行コメント**で残す
- [ ] **API 呼び出しは `apiFetch()` 経由**
  - 生 `fetch()` だと `X-View-As` ヘッダが付かない
- [ ] **新ボタン / 新メニュー / 新タブを追加したら、各ロールでの可視性を VIEW AS で確認**

### B. サーバーサイド（`routes/**`, `auth.js`, `utils/**`）

- [ ] **権限制御が必要な API ルートには `requirePermission(key)` を必ず付ける**
  - `requireAuth` のみで通している API は「ログインさえしていれば誰でも叩ける」ことを意味する。意図したものか必ず確認
- [ ] **ロール判定が必要な処理は `await getEffectiveRoleCodes(req)` または `await getEffectiveRolePrimary(req)` を使う**
  - `req.user.role` の**直書きは禁止**（VIEW AS が効かない＋ user_roles 多重ロール対応もできない）
- [ ] **新しい `permission_key` を使う場合は `permission_keys` マスタに登録**（migration / seed で）
  - 登録しないと権限管理画面に出てこず、admin が ON/OFF できない
- [ ] **API レスポンスが「ロールごとに見える列を絞る」場合、その絞り込みも実効ロールで判定**

### C. DB / Migration

- [ ] 新 `permission_key` を導入する場合は migration に INSERT を含める
- [ ] 既存 `role_permissions` の seed を変更する場合、`role_id` と `role TEXT` の dual-write 期間を考慮（ADR 003）

### D. 動作確認（PR 提出前）

- [ ] 最高管理者アカウントでログインし、VIEW AS スイッチャーで以下のロールを順に切り替えて動作確認
  - admin / producer_director / producer / director / editor / designer / secretary
  - 該当機能を触らないロールはスキップして良いが、**最低でも 3 ロール以上**は確認
- [ ] 確認結果を **PR 本文の Test plan に記載**（どのロールで何を見たか）
- [ ] サーバー側の API は curl などで `X-View-As: <role>` ヘッダを付けて実効レスポンスが切り替わることを確認（管理者セッション cookie 必須）

### E. サブエージェントへの委譲時

- [ ] worker 系サブエージェント（projects-worker / clients-worker など）に権限関連を依頼する指示テンプレに、本 ADR 015 へのリンクを必ず添付
- [ ] 「VIEW AS で全ロール動作確認すること」を**指示文に明記**

## 良い実装例

```js
// ✅ Good: フロントで effectiveRole() を使う
if (effectiveRole() === 'admin') { ... }

// ✅ Good: hasPermission() で権限ベースに判定
if (hasPermission('projects.edit')) { ... }

// ✅ Good: API 呼び出しは apiFetch
const res = await apiFetch('/api/projects');

// ✅ Good: サーバーで requirePermission
app.post('/api/projects', requirePermission('projects.create'), async (req, res) => { ... });

// ✅ Good: 実効ロールコードで判定
const codes = await getEffectiveRoleCodes(req);
if (codes.includes('admin')) { ... }
```

## 悪い実装例

```js
// ❌ Bad: currentUser.role 直書き（VIEW AS で切り替わらない）
if (currentUser.role === 'admin') { ... }

// ❌ Bad: 生 fetch（X-View-As ヘッダが付かない）
const res = await fetch('/api/projects');

// ❌ Bad: requirePermission 無し（ログインユーザー全員が叩ける）
app.post('/api/projects', requireAuth, async (req, res) => { ... });

// ❌ Bad: req.user.role 直書き（VIEW AS が効かない）
if (req.user.role === 'admin') { ... }
```

## Consequences

- 権限が絡む実装の手戻りが減る（最大の目的）
- VIEW AS 切り替え時の不具合がほぼなくなる
- 副次的に: `currentUser.role` / `req.user.role` の直書きが減ることで、ADR 003 の user_roles 多重ロール対応にも自然と乗っていく
- 副次的に: `permission_keys` 登録漏れが減ることで、admin が権限を後から微調整できる範囲が広がる

トレードオフ:
- PR 提出前の動作確認工数が少し増える（VIEW AS で 3 ロール以上を回す）
- → ただし不具合発覚 → 修正 PR → 再デプロイのコストよりは確実に小さい

## Alternatives

1. **ESLint ルールで `currentUser.role` / `req.user.role` 直書きを警告**
   - 将来追加候補。ただし正当な例外（`isSuperAdmin()` 内など）があるため、まずは手順ルール化を優先
2. **E2E テストで全ロール検証を自動化**
   - 工数大。本ルールが浸透した後の段階で検討
3. **CI で `permission_keys` の登録漏れを検知（grep ベースの簡易チェック）**
   - 検討余地あり。優先度は中

## 参考

- [auth.js#getEffectiveRole](../../../auth.js)
- [utils/roles.js](../../../utils/roles.js)
- [public/haruka.html#effectiveRole](../../../public/haruka.html) （`function effectiveRole()` で grep）
- [ADR 003: ロールはマスタテーブルで管理する](003-roles-as-master-data.md)

---
adr: 008
status: Accepted
date: 2026-05-08
tags: [teams, roles, leader, permissions]
related_tables: [team_members, teams, users]
supersedes: null
superseded_by: null
---

# 008. チームリーダーを役職と独立した「業務上の連絡窓口」として持つ

- **Status**: Accepted
- **Date**: 2026-05-08
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

現状、チームのリーダーバッジ判定は `teams.director_id` に依存している（`routes/haruka.js`
の `/announcements/:id/status` 行 6195 周辺）。これは「ディレクター役職者 = チームの連絡窓口
（リーダー）」という暗黙の前提に基づくが、実運用では成り立たないケースがある:

- **秘書チーム**: ディレクター役職者がいない。誰もリーダーバッジが付かず、督促や全体連絡時に
  「誰宛てにメンションすべきか」が機械判定できない。
- **ディレクター複数チーム**: ディレクター役職を複数人が持つチームでは、
  `teams.director_id` 1 人だけがバッジを得るのは恣意的。
- **役職と業務窓口は別概念**: 「役職（システム機能のロール）」と
  「業務上の連絡窓口（誰に報せれば回る人か）」は別軸であるべき。

`users.role` （ADR 003 で roles マスタ化済）はシステム機能の権限制御に使う一方、
**チーム単位の連絡窓口** は team_members テーブル側に独立した属性として持つのが自然。

## Decision

**`team_members` に `leader_rank` 列を追加し、リーダー / サブリーダーをチーム単位で
明示的に指定できるようにする。役職（`users.role`）とは独立した概念として扱う。**

### スキーマ

```
team_members
  ...既存列...
  leader_rank  text  CHECK (leader_rank IN ('leader', 'sub_leader') OR leader_rank IS NULL)
```

- `leader_rank='leader'` は **1 チームに最大 1 人**（部分 unique index）
- `leader_rank='sub_leader'` は複数可（連絡窓口の副担当を複数置けるように）
- NULL = 一般メンバー

### バッジ判定の優先順位

1. `team_members.leader_rank='leader'` のメンバー → リーダーバッジ表示
2. 1 が無い場合は既存 `teams.director_id` のメンバー → 後方互換のためリーダー扱い
3. それも無ければバッジ無し

### 段階導入

- **Stage 1**（本 ADR Accept 時に実装）: migration + backfill + バッジ判定切替。
  既存 `teams.director_id` に紐づく team_members 行へ自動的に `leader_rank='leader'` をコピー。
  UI 追加なし、見た目を変えない。サブリーダーバッジは Stage 1 では表示しない。
- **Stage 2**: チーム編集 UI に「リーダー」「サブリーダー」のチェック UI を追加。
  ディレクター指定（`teams.director_id`）の入力 UI と並列に置く。
- **Stage 3**: 督促・通知系で `leader_user_id` を「優先メンション先」として活用
  （announcement_remind / 案件のボール持ちサマリ等）。
- **将来**: `teams.director_id` を「役職としての主担当ディレクター」のみに用途を絞り、
  リーダー判定からは完全に切り離す（Stage 3 以降の慣熟確認後）。

## Consequences

### Positive

- 秘書チームのようにディレクター役職者がいないチームでも、リーダーを明示できる。
- 役職と連絡窓口の責務が分離され、ロール変更（編集者 → ディレクター昇格等）が
  リーダー指名と連動しなくなる（運用上の意図しない副作用を防げる）。
- `leader_rank='sub_leader'` でリーダーが不在のときの代替連絡窓口を持てる。
- バックフィルにより既存運用は壊れない。

### Negative

- `teams.director_id` と `team_members.leader_rank` の二系統が一時的に並走する
  （Stage 1〜3 の期間）。
- フロント側のバッジ判定を毎回両方見る必要があり、ロジックがやや複雑になる
  （`leader_user_id` フィールドを API 側で集約することで吸収）。

### Risks / Mitigations

- **Migration 未適用環境で API が落ちる**: `leader_rank` 参照は optional (try/catch / 列欠損 OK)
  にして、未適用環境でも 500 にしない。
- **重複したリーダー指名の事故**: 部分 unique index で DB 側で防ぐ。

## Alternatives Considered

### A. `users.role='leader'` を新設してロールで管理する

- **却下**: ロールはシステム機能の権限軸であり、チーム単位ではないため不適合。
  「あるチームのリーダーだが別チームでは一般メンバー」が表現できない。

### B. `teams.leader_id` を新設する

- **却下**: 1 チームに 1 人しか持てず、サブリーダー（複数）が表現できない。
  team_members 側に持つ方が将来の拡張（権限・連絡頻度の重み付け等）に強い。

### C. 現状維持（`teams.director_id` を流用）

- **却下**: 秘書チームのリーダー不在問題が解決しない。
  ディレクター役職と連絡窓口の責務混在は将来も増殖する負債になる。

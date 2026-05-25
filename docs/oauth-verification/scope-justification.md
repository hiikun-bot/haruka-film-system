# Google OAuth Verification – Scope Justification

This document collects the text we submit to Google when applying for OAuth verification of HARUKA FILM SYSTEM. Reviewers read English; the Japanese version is for our internal review.

---

## App Summary (App Function — short)

### English (paste into "What does your app do?" — keep under ~500 chars)

HARUKA FILM SYSTEM is an internal team management tool for a Japanese video production studio. It manages projects, creative deliverables, invoicing, and team availability. The Google Calendar integration lets each team member opt in to sync their personal calendar so that the team's available working hours per day are calculated and visualized for project staffing. Only time information (start/end/all-day flag) is fetched — never event content (title, description, location, attendees).

### 日本語（社内確認用）

HARUKA FILM SYSTEM は、日本の映像制作スタジオの社内向け業務管理ツールです。案件・クリエイティブ成果物・請求・チーム稼働時間を一元管理します。Google Calendar 連携は各メンバーが任意で自身の個人カレンダーを同期するもので、それにより日次の稼働可能時間が計算・可視化され、案件アサインに活用されます。取得するのは時間情報（開始・終了・全日フラグ）のみで、予定の内容（タイトル・説明・場所・参加者）は一切取得しません。

---

## Scope: `https://www.googleapis.com/auth/calendar.events.readonly`

### English (paste into "How will the scope be used?" for each sensitive scope)

We use `calendar.events.readonly` to compute each member's available working hours per day. For every consenting team member, we fetch events in a sliding window (today through ~60 days ahead). For each event we read **only**:

- `start.dateTime` / `start.date` / `start.timeZone`
- `end.dateTime` / `end.date` / `end.timeZone`
- `status` (to skip `cancelled`)
- `transparency` (to skip `transparent` — events marked "Available")
- `id` (for synchronization)

We **do not** request or store `summary`, `description`, `location`, `attendees`, `creator`, `organizer`, `conferenceData`, or `attachments`. This is enforced at the API request layer using the `fields` parameter (`fields=nextPageToken,items(id,status,transparency,start(dateTime,date,timeZone),end(dateTime,date,timeZone))`), so the event content never reaches our server.

The fetched time slots are subtracted from each member's baseline work schedule to derive their daily available hours, which are then shown in a team-wide availability grid that producers use for project staffing decisions.

### Why a narrower scope is not sufficient

`calendar.freebusy` returns only aggregate busy intervals and does not expose per-event metadata such as `transparency` and `status` that we explicitly rely on to:

1. Filter out events the member marked as **"Available"** (`transparency=transparent`) – e.g., FYI / personal reminder entries that should not reduce work hours.
2. Filter out **cancelled** events (`status=cancelled`) – freebusy can include them under some conditions.
3. Distinguish **all-day events** (`start.date` vs `start.dateTime`) from timed events, because we treat all-day "holiday" / "off" entries differently from short meetings.

These three distinctions are not derivable from `freebusy` alone and are essential for producing accurate working-hour numbers — the core function of the integration. We therefore use `events.readonly` but immediately discard everything other than the four time-related fields listed above.

### Data handling

- **Refresh token storage:** AES-256-GCM encrypted at rest in our Supabase database.
- **Event data storage:** Only time intervals are persisted in `member_working_hours_daily.gcal_raw_slots`. No event content.
- **Access control:** Calendar data is visible only to authenticated members of the same studio organization, after our internal role-based authorization check.
- **Sharing:** No data is transferred to any third party.
- **AI/ML:** Calendar data is never used to train any AI or ML model.
- **Advertising:** Calendar data is never used for advertising.
- **User control:** Members can disconnect at any time from the in-app "Disconnect" button, which immediately deletes their refresh token and all associated tokens from our database. They can also revoke at https://myaccount.google.com/permissions .

### Limited Use compliance statement

HARUKA FILM SYSTEM's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

### 日本語（社内確認用）

`calendar.events.readonly` は、各メンバーの日次稼働可能時間を算出するために使用しています。同意したチームメンバーごとに、今日〜約60日先までのスライディングウィンドウで予定を取得します。1件の予定から取得するのは **時間関連の項目のみ**:

- `start.dateTime` / `start.date` / `start.timeZone`
- `end.dateTime` / `end.date` / `end.timeZone`
- `status`（`cancelled` の除外用）
- `transparency`（"予定なし" マークの除外用）
- `id`（同期判定用）

`summary` / `description` / `location` / `attendees` / `creator` / `organizer` / `conferenceData` / `attachments` 等の予定の **内容** は API リクエストの `fields` パラメータで明示的に除外しており、サーバーに到達しません。

取得した時間スロットを各メンバーのベース勤務時間から差し引いて日次稼働可能時間を算出し、チーム全体の稼働カレンダーに表示します。プロデューサーはこれを見て案件アサインを決定します。

**なぜ `calendar.freebusy` では不足か:**

1. `transparency=transparent`（"予定なし" 扱い）の予定をフィルタアウトするために必要 — メンバーが「念のため入れた個人メモ」等が稼働時間を不当に減らさないようにする
2. `status=cancelled` の予定を除外するため
3. 終日予定（`start.date`）と時刻指定予定（`start.dateTime`）を区別するため — 終日「休み」と短時間ミーティングは別扱い

これらは `freebusy` だけからは導出できないため、`events.readonly` を採用しつつ、上記の時間関連4フィールド以外は直ちに破棄しています。

**データ取扱い:**
- refresh_token は AES-256-GCM で暗号化して保管
- 時間スロットのみ DB に保存、予定内容は保存しない
- 同じ事業者組織の認証済みメンバーのみ閲覧可
- 第三者提供なし
- AI/ML の学習には一切使用しない
- 広告目的の利用は一切しない
- ユーザーは「連携を切断」ボタンでいつでも refresh_token を即削除可能
- Google アカウント側からも https://myaccount.google.com/permissions で取消可能

---

## Scope: `https://www.googleapis.com/auth/userinfo.email`

Non-sensitive scope. Used only to display the connected Google account's email address in the user's settings UI ("Connected as: user@example.com") so the user can verify which account they've authorized. The email is not used for marketing, not shared, not used as a primary identifier (we use our internal user id).

## Scope: `openid`

Non-sensitive standard OIDC scope. Used implicitly with `userinfo.email` for OAuth account identification.

---

## Demo Video Outline (for reviewers)

The verification process also requires a short screen recording. Suggested flow (~60 seconds):

1. Log into HARUKA FILM SYSTEM at `https://app.harukafilm.com`
2. Navigate to Members → Calendar view
3. Click "📅 Connect Google Calendar"
4. Google OAuth consent screen appears showing the requested scopes
5. Approve consent
6. Return to the app, see the member's row populated with computed daily working hours
7. Click "Disconnect" to show the revocation flow
8. Confirm the row reverts to baseline schedule (no calendar data used)

The video should be uploaded as **YouTube Unlisted** and the URL pasted in the verification form.

---

## Authorized Domains

- `harukafilm.com` (verified in Google Search Console)

## App URLs

- Home page: `https://app.harukafilm.com/`
- Privacy policy: `https://app.harukafilm.com/privacy.html`
- Terms of service: `https://app.harukafilm.com/terms.html`

---

最終更新: 2026-05-26

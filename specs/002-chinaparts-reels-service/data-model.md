# Data Model: China Parts Reels Service

**Feature**: `002-chinaparts-reels-service` | **Date**: 2026-10-09

MongoDB holds all reels data. China Parts data is read live and never copied, except for the display fields cached on `reels_accounts`. The China Parts tables and columns read are listed in [contracts/chinaparts-read-model.md](contracts/chinaparts-read-model.md).

**Legend**: **Ported** means unchanged from Ciro except that `User` references now point to `reels_accounts`. **Changed** means ported with the listed edits. **New** means added for China Parts.

## Collections

### reels_accounts (New, replaces Ciro `User` for reels)

One document per China Parts account that has used reels.

| Field | Type | Rules |
|-------|------|-------|
| `_id` | ObjectId | Referenced everywhere as the account id (`userId`, `creatorId`, `authorId`, and so on) |
| `accountType` | `'customer' \| 'seller'` | Required |
| `externalId` | number | Required. China Parts `customers.id` or `sellers.id` |
| `name` | string | Public name, synced from China Parts (FR-011, FR-012) |
| `nameNormalized` | string | `normalizeForMatch(name)`, for account search |
| `username` | string | Handle as typed. 3 to 30 characters from `[\p{L}\p{M}\p{N}_.]` (R6) |
| `usernameNormalized` | string | `normalizeForMatch(username)`. Unique |
| `bio` | string | 0 to 150 characters. Default `''` |
| `avatarUrl` | string \| null | Synced. `null` means the app shows a placeholder |
| `standing` | `'good' \| 'suspended' \| 'deleted'` | Synced (R7). Only `good` may write, except deleting one's own reels and comments and recording views (FR-008) |
| `preferredCurrency` | string \| null | Synced (R7). Three-letter code from China Parts. `null` means the base currency (FR-036) |
| `missingSince` | Date \| null | Set when the account's China Parts row is missing in a sync cycle. A second consecutive miss marks the account `deleted` (R7) |
| `locale` | `'ar' \| 'en'` | Last `Accept-Language` seen. Default `'ar'` (R14) |
| `blockedUsers` | ObjectId[] | Accounts this account blocked. The field name is kept for the port |
| `followersCount`, `followingCount`, `totalLikes` | number | Stored counters, default 0 |
| `syncedAt` | Date | Last refresh from China Parts |
| `createdAt`, `updatedAt` | Date | Timestamps |

**Indexes**:
- unique `{accountType, externalId}`
- unique `{usernameNormalized}`
- `{blockedUsers: 1}`, for the reverse block lookup carried over from Ciro
- `{nameNormalized: 1}`
- partial `{standing: 1}` where `standing != 'good'`

### reels (Changed)

| Field | Type | Rules / change |
|-------|------|----------------|
| `creatorId` | ObjectId → reels_accounts | Must be a seller in good standing at upload (FR-025) |
| `media` | `{ videoKey: string, thumbnailKey: string, location: 'private' \| 'public' }` | **Replaces** `videoUrl` and `thumbnailUrl`. `location` is `public` only while the reel is published **and** its creator is in good standing (R12, FR-009). URLs are built per response: public URLs while public, presigned URLs for the owner otherwise. The thumbnail is generated when none is uploaded |
| `description` | string | At most 2,200 characters |
| `hashtags` | string[] | As typed, without `#`, deduplicated by normalized form. For display |
| `hashtagsNormalized` | string[] | **New**. Used for every match (R8) |
| `mentions` | `{userId, username}[]` | Only handles that resolve, matched by `usernameNormalized` |
| `productLinks` | `{productId: number, position: 0–4, tapsCount: number}[]` | **New**. At most 5, with unique `productId` (FR-035) |
| `status` | `pending_moderation \| published \| rejected \| hidden` | State machine below |
| `publishedAt`, `moderation`, `adminRestored` | | Ported |
| `viewsCount` | number | Signed-in views plus guest views (FR-024) |
| `likesCount`, `commentsCount`, `sharesCount`, `reportsCount` | number | Ported counters |

**Indexes**:
- **Ported**: `{status, createdAt, _id}`, `{creatorId, status, createdAt}`, `{status, updatedAt}`.
- **Replaced**: `{hashtags, createdAt}` becomes `{hashtagsNormalized: 1, createdAt: -1, _id: -1}`.

### reel_likes, reel_saves, reel_views, reel_shares, reel_reposts, follows, reel_reports, notification_events (Ported)

The schemas and indexes are unchanged from Ciro. Every user reference now points to `reels_accounts`. `reel_reports` keeps its rolling 24-hour limit index `{reporterId, createdAt}`.

**Report retention** (R16): reel and comment reports are kept while their reel exists, through hiding, restoring, dismissing, and comment deletion. They are deleted with the reel, by owner delete (FR-032) or account cleanup (FR-010).

### reel_comments (Changed)

| Field | Type | Rules / change |
|-------|------|----------------|
| `videoId`, `authorId`, `text`, `createdAt` | | Ported. `text` is 1 to 500 characters after trimming |
| `deletedAt` | Date \| null | **New**. Reads return only `deletedAt: null` |
| `deletedByRole` | `'author' \| 'reel_owner' \| 'operator' \| 'system'` \| null | **New**. `system` is used by the account cleanup cascade |

**Indexes**:
- `{videoId: 1, deletedAt: 1, createdAt: -1, _id: -1}` replaces the ported page index.
- `{authorId: 1}` is new, for standing filters and cleanup.

### reel_comment_reports (New)

| Field | Type | Rules |
|-------|------|-------|
| `commentId` | ObjectId → reel_comments | Required |
| `videoId` | ObjectId → reels | Required, copied from the comment |
| `reporterId` | ObjectId → reels_accounts | Must not be the comment's author |
| `reason` | `spam \| nudity \| violence \| hate_speech \| other` | Required |
| `customReason` | string | Required only when the reason is `other`. 1 to 500 characters, trimmed |
| `dismissedAt` | Date \| null | Set when an operator dismisses the report |
| `createdAt` | Date | |

**Indexes**:
- unique `{commentId, reporterId}`
- `{dismissedAt: 1, createdAt: -1}`, for the operator queue
- `{reporterId: 1, createdAt: -1}`, for the shared daily limit

### reel_guest_views (New)

| Field | Type | Rules |
|-------|------|-------|
| `installationId` | string (UUID v4) | From the `X-Installation-Id` header |
| `videoId` | ObjectId → reels | |
| `createdAt` | Date | |

**Indexes**: unique `{installationId, videoId}`, and `{videoId: 1}` for the cleanup cascade.

### reel_product_taps (New)

| Field | Type | Rules |
|-------|------|-------|
| `videoId` | ObjectId → reels | |
| `productId` | number | Must be in the reel's `productLinks` |
| `viewerId` | ObjectId \| null | Signed-in tapper |
| `installationId` | string \| null | Signed-out tapper |
| `createdAt` | Date | |

**Indexes**: `{videoId: 1, productId: 1, createdAt: -1}`, plus a TTL index on `createdAt` that keeps 365 days of raw taps. The per-link `tapsCount` keeps the total permanently.

### hashtag_stats (New)

| Field | Type | Rules |
|-------|------|-------|
| `tag` | string | The normalized hashtag. Unique |
| `display` | string | First display form seen |
| `publishedReelsCount` | number | Goes up by one when a reel carrying the tag is published or restored, and down by one when it is hidden, rejected, or deleted. Rows reaching 0 are removed |

**Index**: unique `{tag: 1}`. Search runs a substring regex over `tag`, capped at 200 matches (R9).

## State Machines

### Reel status

```text
                 clean verdict                  reports ≥ threshold (and not adminRestored)
pending_moderation ───────────► published ───────────────────────────────► hidden
        │                         ▲                                           │
        │ flagged verdict         └──────────── operator restore ─────────────┤
        ▼                                     (sets adminRestored = true)     │
     rejected ◄────────────────────────────── operator reject ────────────────┘

Any state ── owner delete ──► (document removed, cascade + all media deleted)
```

**Side effects of each transition**:

| Transition | Media | `hashtag_stats` | Notifications |
|------------|-------|-----------------|---------------|
| Pending to published | Copied to the public bucket if the creator is in good standing | Increased | Mentioned accounts |
| Pending to rejected | Stays private | Unchanged | Owner |
| Published to hidden | Public copy removed | Decreased | None |
| Hidden to published (restore) | Copied back to public if the creator is in good standing | Increased | None |
| Hidden to rejected | Stays private | Unchanged (already decreased on hide) | None |
| Creator leaves good standing (status unchanged) | Public copies of the creator's published reels removed | Unchanged | None |
| Creator regains good standing (status unchanged) | The creator's published reels copied back to public | Unchanged | None |

Every transition keeps the ported guarded-update rule. A transition applies only if the current status is the expected one, so concurrent reports or retries never fire twice. Side effects run in `ReelLifecycleService`, after the guarded update succeeds. The repository returns the outcome and never triggers them itself (R22).

**Creator standing**: standing is separate from status. A published reel whose creator isn't in good standing keeps the status `published`. It is excluded from every non-owner read through the not-in-good-standing set (R7), and its media leaves the public bucket (R12).

### Comment

```text
active ── author / reel's seller / operator / cleanup ──► deleted (deletedAt set, commentsCount −1 exactly once)
```

The author may delete a comment even when out of good standing. A reel's seller deleting someone else's comment needs good standing (FR-008, R16).

### Comment report

```text
open (dismissedAt = null) ── operator dismiss ──► dismissed
```

The operator queue shows comments that have at least one open report and are not deleted.

### Account standing

```text
good ◄──── sync ────► suspended
  │                       │
  └── row missing in two consecutive syncs ──► deleted ── cleanup job ──► reels and media deleted; comments deleted (system);
                                                      likes, saves, views, follows, reposts, and reports removed;
                                                      affected counters corrected; account document removed
```

Every move between `good` and another standing queues a media-visibility job for the account (R12). The cleanup must finish within 24 hours of China Parts removing the account (FR-010). The sync's mass-miss breaker stops it from marking accounts deleted when an implausible share of them goes missing at once (R7).

## Validation Rules (from the spec)

| Rule | Source |
|------|--------|
| Video: one file, MP4, MOV, or WebM, at most 100 MB, and at most 60 seconds measured on the server (plus 1 second tolerance). Cover: optional JPEG or PNG | FR-026, FR-027 |
| Description at most 2,200 characters. Comment 1 to 500 characters after trimming. Custom report reason 1 to 500 characters | FR-027, FR-040, FR-053 |
| Product links: at most 5, each owned by the uploader, `status = 1`, and not deleted | FR-035 |
| Feed page size defaults to 10 and is at most 25. Comment pages default to 20 and are at most 50 | FR-019, FR-040 |
| Report limit: 20 in a rolling 24 hours, shared by reel and comment reports | FR-055 |
| Auto-hide threshold: 25 distinct reporters | FR-056 |
| Handle: 3 to 30 characters, letters, digits, `_`, or `.`, unique after normalization. Bio at most 150 characters | FR-015 |
| Every limit is configurable through validated environment variables. Lengths are checked by `@MaxLengthFromConfig`, and page sizes are clamped (R24) | FR-070 |

## Redis Keys

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `auth:tok:{sha256(token)}` | `{accountType, externalId, accountId}` | `AUTH_CACHE_TTL_SECONDS` (60 s, at most 300) | Token validation cache (R4) |
| `auth:acct:{type}:{externalId}` | `{standing, name, avatarUrl, locale, preferredCurrency}` | 60 s, and deleted by the sync when the account's standing changes | Caller standing (R7), locale writes only on change (R14), card currency (R11) |
| `standing:excluded` | set of account ids | None, rebuilt every sync | Visibility exclusion (FR-009) |
| `product:card:{productId}` | product card JSON in the base currency | 60 s | Live product cards (R11) |
| `fx:rates` | hash of currency code to rate | `FX_CACHE_SECONDS` (300 s) | Card currency conversion (R11) |
| `push:dead:{sha256(fcmToken)}` | `1` | 30 days | Skip unregistered device tokens (R14) |
| throttler keys | counters | Window | Per-IP, per-account, guest, upload, and write limits (R10) |

All of these go through the shared `REDIS_CLIENT` (R23), except the throttler keys, which use the throttler storage's own connection.

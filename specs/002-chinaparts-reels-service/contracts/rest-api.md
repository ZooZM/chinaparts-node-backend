# Contract: REST API

**Feature**: `002-chinaparts-reels-service`

The paths keep Ciro's reels paths (`/api/reels/...`, `/api/users/...`) so the Ciro Flutter reels feature can be reused in the China Parts apps with minimal client changes. Differences from Ciro are marked **New** or **Changed**.

## Conventions

- **Success envelope**: `{ "success": true, "data": <payload>, "message": "<text>" }`.
- **Error envelope**: `{ "success": false, "error": "<SENTINEL>", "message": "<text>", "statusCode": <n> }`.
- **Request headers**:
  - `Authorization: Bearer <China Parts Sanctum token>` is the same token the app sends to China Parts.
  - `X-Installation-Id: <uuid v4>` should always be sent. It is required for signed-out view counting.
  - `Accept-Language: ar | en` sets the account's notification language (research R14).
- **Cursors** are opaque strings. Pass back `nextCursor` unchanged. A `null` value means the end of the list. The For You feed never returns `null` (FR-020), except when there is no reel at all to loop.

## Access levels

| Level | Meaning |
|-------|---------|
| **Public** | No authentication. Non-API routes only |
| **Optional** | Signed-out visitors allowed, and rate-limited (FR-004b). A present but invalid `Authorization` header gets `401 AUTH_INVALID_SESSION` (FR-004a) |
| **Signed-in** | A valid China Parts session is required |
| **Seller** | Signed-in with a seller account |
| **Admin** | `x-admin-key` header only. No user session is accepted (FR-059) |

**Good standing (FR-008)**: every non-GET request by a signed-in caller also requires good standing, at any level, with three exceptions:
- EP10, deleting one's own reel
- EP16, recording a view
- EP22, when the caller wrote the comment

Out of good standing, any other write gets `403 ACCOUNT_NOT_IN_GOOD_STANDING`.

**Defaults** (research R10): a route without an explicit level is Signed-in. A China Parts outage during session validation returns `503 UPSTREAM_UNAVAILABLE`, never a 401.

## Endpoints

### Feeds and reels

| # | Method and path | Access | Notes |
|---|-----------------|--------|-------|
| 1 | `GET /api/reels?cursor&limit&creatorId&hashtag` | Optional | For You feed (default), creator feed, or hashtag feed. Signed-out visitors get no repost injection. `hashtag` is matched after normalization. **Changed**: keyset cursor |
| 2 | `GET /api/reels/following?cursor&limit` | Signed-in | Original reels by followed accounts only |
| 3 | `GET /api/reels/liked?cursor&limit` | Signed-in | Private Liked list |
| 4 | `GET /api/reels/saved?cursor&limit` | Signed-in | Private Saved list |
| 5 | `GET /api/reels/reposted?userId&cursor&limit` | Optional | Public Reposts list. `userId` is required for signed-out visitors |
| 6 | `GET /api/reels/search?q&cursor&limit` | Signed-in | Videos matched by hashtag substring through `hashtag_stats`. Whitespace-only `q` returns 400 |
| 7 | `GET /api/reels/me/following?cursor&limit` | Signed-in | Followed accounts, for mention suggestions |
| 8 | `POST /api/reels` (multipart) | Seller | Fields: `video` (required), `thumbnail`, `description`, `productIds` (**New**, a JSON array or comma-separated list, at most 5). Returns the `ReelDto` with status `pending_moderation` |
| 9 | `GET /api/reels/:id` | Optional | Non-owners get 404 unless the reel is published and its creator is in good standing |
| 10 | `DELETE /api/reels/:id` | Signed-in | Owner only, otherwise `403 NOT_REEL_OWNER`. Allowed out of good standing (FR-008) |
| 11 | `PUT /api/reels/:id/products` | Seller | **New**. Body `{ "productIds": number[] }` (0 to 5) replaces the links. Owner only, otherwise `403 NOT_REEL_OWNER`. Returns the updated `ReelDto`, with its `products`. A product listed twice counts once |
| 12 | `POST /api/reels/:id/products/:productId/tap` | Optional | **New**. Records a tap and returns 204-equivalent `data: null`. A product not linked to the reel gets `404 PRODUCT_LINK_NOT_FOUND`. Signed-in callers need good standing |
| 13 | `POST /api/reels/:id/like` | Signed-in | Toggle |
| 14 | `POST /api/reels/:id/save` | Signed-in | Toggle |
| 15 | `POST /api/reels/:id/share` | Signed-in | Copy Link only (FR-042) |
| 16 | `POST /api/reels/:id/view` | Optional | Signed-in: once per account. Signed-out: once per `X-Installation-Id`. Without that header, signed-out views are ignored. No good standing needed (FR-008) |
| 17 | `POST /api/reels/:id/repost` / `DELETE /api/reels/:id/repost` | Signed-in | Explicit verbs |
| 18 | `GET /api/reels/:id/reposters?cursor&limit` | Optional | Excludes blocked accounts for signed-in viewers |
| 19 | `POST /api/reels/:id/report` | Signed-in | Body `{ reason, customReason? }` |

### Comments

| # | Method and path | Access | Notes |
|---|-----------------|--------|-------|
| 20 | `GET /api/reels/:id/comments?cursor&limit` | Optional | Excludes deleted comments, comments from accounts not in good standing, and blocked authors |
| 21 | `POST /api/reels/:id/comments` | Signed-in | Body `{ text }` |
| 22 | `DELETE /api/reels/:id/comments/:commentId` | Signed-in | **New**. Allowed for the comment's author, even out of good standing, or the reel's creator, who needs good standing (FR-008). Otherwise `403 COMMENT_NOT_DELETABLE` |
| 23 | `POST /api/reels/:id/comments/:commentId/report` | Signed-in | **New**. Body `{ reason, customReason? }`. Reporting your own comment gets `400 CANNOT_REPORT_OWN_COMMENT`. A repeat report quietly succeeds (`alreadyReported: true`) and is not counted. Shares the daily limit with EP19 (`429 REPORT_DAILY_LIMIT`) |

### Accounts

| # | Method and path | Access | Notes |
|---|-----------------|--------|-------|
| 24 | `GET /api/users/me` | Signed-in | **New**. Returns the caller's own reels account: `id`, `accountType`, `username`, `name`, `avatarUrl`, `bio`, `locale`, counters |
| 25 | `PATCH /api/users/me` | Signed-in | **New**. Body `{ username?, bio? }`. A taken handle gets `409 USERNAME_TAKEN` |
| 26 | `GET /api/users/search?q&cursor&limit` | Signed-in | Accounts matched by handle or name after normalization |
| 27 | `GET /api/users/:id/profile` | Optional | **Changed**: adds `user.accountType`. `videos` is always empty for customers |
| 28 | `POST /api/users/:id/follow` / `POST /api/users/:id/block` | Signed-in | Toggles. Following yourself gets 400 |

### Operator (admin key)

| # | Method and path | Access | Notes |
|---|-----------------|--------|-------|
| 29 | `GET /api/reels/moderation/hidden?cursor&limit` | Admin | Ported |
| 30 | `PATCH /api/reels/:id/moderation` | Admin | Body `{ action: 'restore' \| 'reject' }`. Ported |
| 31 | `GET /api/reels/moderation/comments?cursor&limit` | Admin | **New**. Comments with open reports, most recently reported first |
| 32 | `PATCH /api/reels/comments/:commentId/moderation` | Admin | **New**. Body `{ action: 'remove' \| 'dismiss' }`. Answers `{ id, action }`. `remove` soft-deletes the comment and takes the reel's count down once; `dismiss` closes the open reports and keeps the comment. A comment that is missing or already deleted is `404 COMMENT_NOT_FOUND` |

### Non-API routes (Public)

| # | Method and path | Envelope | Notes |
|---|-----------------|----------|-------|
| 33 | `GET /reels/:id` | No | Store fallback HTML for the customer app: App Store on iPhone, Google Play on Android, both links elsewhere (FR-069). The id is validated, every value is HTML-escaped, and the page carries canonical and `og:url` tags from `LINKS_PUBLIC_BASE_URL` |
| 34 | `GET /.well-known/apple-app-site-association` | No | `application/json`, no redirects |
| 35 | `GET /.well-known/assetlinks.json` | No | `application/json` |
| 36 | `GET /health/live`, `GET /health/ready` | Yes | Readiness reports MongoDB, Redis, and MySQL, and returns `503 NOT_READY` listing what failed (research R26). Not rate-limited |

Only routes 33 to 35 bypass the envelope, because Apple, Google, and browsers dictate their formats.

**Route order**: as in Ciro, static segments must be declared before `/:id` routes. For example, `moderation/hidden` and `comments/:commentId/moderation` must come before `:id`.

## Payloads

### ReelDto (Changed)

```jsonc
{
  "id": "6702f…",
  "videoUrl": "https://media.reels.example.sa/public/reels/6702f…/video.mp4", // public URL while the media is public; presigned for the owner otherwise (research R12)
  "thumbnailUrl": "https://media.reels.example.sa/public/reels/6702f…/thumb.jpg",
  "createdAt": "2026-10-09T10:00:00.000Z",
  "description": "فلتر زيت أصلي لكامري #فلتر_زيت #كامري_٢٠١٨",
  "hashtags": ["فلتر_زيت", "كامري_٢٠١٨"],             // display form
  "mentions": [{ "userId": "…", "username": "قطع_الرياض" }],
  "creator": {
    "id": "…", "name": "Riyadh Parts", "username": "riyadh_parts",
    "avatarUrl": null, "viewerFollowing": false,
    "accountType": "seller"                             // New
  },
  "status": "published",
  "viewsCount": 120, "likesCount": 14, "commentsCount": 3, "sharesCount": 2,
  "viewerLiked": false, "viewerSaved": false, "viewerReposted": false,   // always false for signed-out visitors
  "repostedBy": null, "repostersCount": 0, "topReposters": [],
  // repostersCount and topReposters are viewer-relative (FR-060): the reposters the viewer follows, plus the viewer.
  // repostersCount is never a total. Both are 0 and [] for signed-out visitors and on surfaces without repost context.
  "products": [ProductCardDto]                          // New, ordered by position; unavailable links omitted (FR-037)
}
```

### ProductCardDto (New)

```jsonc
{
  "productId": 812,
  "slug": "toyota-camry-oil-filter-812",
  "name": "Toyota Camry Oil Filter",
  "imageUrl": "https://chinaparts.example/storage/…/filter.jpg",  // null when none
  "price": "45.00",              // default active variant selling_price, converted to `currency`, decimal string
  "discountPercentage": "10.00", // never converted
  "finalPrice": "40.50",         // price after discount, in `currency`; see research R11 (Verify)
  "currency": "SAR",             // the viewer's preferred China Parts currency; the base currency for
                                 // signed-out visitors, viewers without one, or when no rate exists (FR-036)
  "available": true              // products.stock_quantity > 0
}
```

### CommentDto (Changed)

```jsonc
{
  "id": "…", "authorId": "…", "authorName": "Sara K.", "authorAvatarUrl": null,
  "text": "هل يناسب موديل ٢٠٢٠؟", "createdAt": "…",
  "viewerCanDelete": true,   // New: viewer is the author or the reel's creator
  "viewerCanReport": false   // New: signed in and not the author
}
```

### Operator comment queue item (New)

```jsonc
{
  "commentId": "…", "reelId": "…", "text": "…",
  "author": { "id": "…", "username": "…", "accountType": "customer" },
  "openReportsCount": 4, "lastReportedAt": "…",
  "reports": [{ "reporterId": "…", "reason": "spam", "customReason": null, "createdAt": "…" }]
}
```

## Rate limits

All limits are configurable (research R10, R24). A request over any limit gets `429 RATE_LIMITED`.

| Variable | Keyed by | Default | Applies to |
|----------|----------|---------|------------|
| `IP_RATE_LIMIT_PER_MINUTE` | Client IP | 1,200 a minute | Every request except health checks |
| `USER_RATE_LIMIT_PER_MINUTE` | Account | 300 a minute | Signed-in requests |
| `GUEST_RATE_LIMIT_PER_MINUTE` | Installation id and IP | 120 a minute | Signed-out requests (FR-004b) |
| `UPLOAD_RATE_LIMIT_PER_HOUR` | Account | 20 an hour | EP8 |
| `WRITE_RATE_LIMIT_PER_MINUTE` | Account | 30 a minute | EP19, EP21, and EP23 |

## Error sentinels

Every error the service returns carries one of these (research R25).

| HTTP | `error` | When |
|------|---------|------|
| 400 | `VALIDATION_FAILED` | A body, query, or path value fails validation. Examples: an empty or over-long comment, a whitespace-only search, `other` without a reason, and a signed-out EP5 request without `userId`. `message` lists the fields |
| 400 | `INVALID_CURSOR` | A cursor the service didn't issue |
| 400 | `VIDEO_REQUIRED`, `VIDEO_TOO_LONG`, `VIDEO_DURATION_UNREADABLE`, `UNSUPPORTED_MEDIA_TYPE` | Upload validation (FR-026) |
| 400 | `PRODUCT_NOT_ATTACHABLE` | The product isn't the seller's own, or isn't active (FR-035). The response lists the offending ids in `details.productIds` |
| 400 | `TOO_MANY_PRODUCTS` | More than `REEL_MAX_PRODUCTS` (at most 5, the stored ceiling). `details.maxProducts` holds the limit |
| 400 | `CANNOT_FOLLOW_SELF`, `CANNOT_BLOCK_SELF` | Following or blocking yourself (FR-045) |
| 400 | `CANNOT_REPORT_OWN_REEL`, `CANNOT_REPORT_OWN_COMMENT`, `CANNOT_REPOST_OWN_REEL` | Ported rules, plus the new comment rule |
| 401 | `AUTH_REQUIRED` | No session on a Signed-in or Seller route |
| 401 | `AUTH_INVALID_SESSION` | A token that is unknown, expired, signed out, or of an unsupported account type (FR-004a, FR-007) |
| 401 | `ADMIN_KEY_INVALID` | An Admin route without a valid `x-admin-key`, or with no key configured |
| 403 | `ACCOUNT_NOT_IN_GOOD_STANDING` | A write by an account out of good standing, except on the exempt routes (FR-008) |
| 403 | `REELS_SELLERS_ONLY` | A customer tries to upload or edit product links (FR-025) |
| 403 | `NOT_REEL_OWNER` | Deleting another seller's reel, or editing its product links |
| 403 | `COMMENT_NOT_DELETABLE` | Neither the comment's author nor the reel's creator |
| 404 | `REEL_NOT_FOUND` | Missing, deleted, or not visible to the caller (FR-021, FR-022) |
| 404 | `COMMENT_NOT_FOUND` | Missing or deleted comment |
| 404 | `ACCOUNT_NOT_FOUND` | Missing account, or one hidden from the caller by a block or by standing |
| 404 | `PRODUCT_LINK_NOT_FOUND` | A tap on a product that isn't linked to the reel |
| 409 | `USERNAME_TAKEN` | Handle collision after normalization |
| 409 | `REEL_NOT_HIDDEN` | An operator action that needs a hidden reel (ported) |
| 413 | `VIDEO_TOO_LARGE` | More than `REEL_MAX_VIDEO_BYTES` |
| 429 | `REPORT_DAILY_LIMIT` | Shared reel and comment report limit reached (FR-055) |
| 429 | `RATE_LIMITED` | Any limit in "Rate limits" |
| 500 | `INTERNAL_ERROR` | Anything unexpected. The message is generic, and details are logged server-side only |
| 503 | `UPSTREAM_UNAVAILABLE` | China Parts database unreachable while validating a session, or products being attached (EP8, EP11). Nothing is granted without verification, and the app must not sign the user out. Feed and reel reads never fail for this: cards that can't be built are left out (research R11) |
| 503 | `NOT_READY` | `/health/ready` when a dependency is down |

Client-facing sentinels are load-bearing (constitution IV). They are documented at their definition site and changed only together with the apps.

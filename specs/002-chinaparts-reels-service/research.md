# Research: China Parts Reels Service

**Feature**: `002-chinaparts-reels-service` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

Each decision lists what was chosen, why, and what else was considered. Items marked **Verify** depend on facts about the China Parts system that are not visible in the supplied schema. Each one must be confirmed with the China Parts team before the related task is closed.

**Revision 2026-10-10**: updated after the spec clarifications of 2026-10-10 and the cross-artifact analysis. R7, R9, R10, R11, R12, R14, R16, R17, and R18 changed. R22 to R26 are new.

---

## R1. How the reels module is reused

**Decision**: Fork the reels module from the Ciro Chat backend (`src/modules/reels` at commit `51f8db5`) into a new repository, together with the shared pieces it relies on: the response envelope, exception filter, base repository, Redis throttler storage, and admin key guard. Record the source commit in the new repository's README so later Ciro fixes can be ported deliberately.

**Rationale**: The module is coupled to Ciro's `User` model, its JWT login, and its notifications module. A fork lets us replace those three couplings in one place without destabilizing a shipped Ciro feature. The data model and most of the business logic carry over unchanged.

**Alternatives considered**:
- *Shared npm package used by both backends*: the cleanest long-term answer, but extracting a host-neutral core means refactoring Ciro's live module first. Revisit once both products are stable. The comment-management and Arabic-search changes now specified in both specs are the first candidates for shared code.
- *Serve China Parts from the existing Ciro backend (multi-tenant)*: rejected. It mixes two companies' data, conflicts with Saudi data residency (FR-072), and breaks FR-001's independent deployment.
- *Rebuild reels inside the China Parts backend*: rejected by FR-001 and FR-002, and it would discard working, tested code.

## R2. Runtime stack

**Decision**: Keep the Ciro stack: Node.js 22 LTS, TypeScript 5.7+ with full `strict`, NestJS 11, MongoDB through Mongoose 9, Redis through ioredis, BullMQ for background work, and Jest for tests.

**Rationale**: The forked code, its schemas, indexes, and tests run unchanged on this stack. It also matches the team's existing deployment pipeline and constitution.

**Alternatives considered**: Store reels data in China Parts' MySQL. Rejected, because FR-002 forbids writing there, and the module's document model would need a rewrite.

## R3. Reading China Parts data

**Decision**: Connect directly to China Parts' MySQL, ideally a read replica, with a dedicated user that has **column-level `SELECT` grants only** on the columns listed in [contracts/chinaparts-read-model.md](contracts/chinaparts-read-model.md). Use the `mysql2` driver with parameterized queries inside one `china-parts` module. No ORM, no migrations, no schema sync.

**Rationale**:
- The database permissions themselves make FR-002 (no writes) and FR-016 (no emails, phones, IDs, addresses, or payment data) impossible to violate. The service cannot read those columns at all.
- No change to China Parts' backend code is needed. The only China Parts-side work is creating one MySQL user.
- Data is always current, which FR-014 and FR-036 need.

**Alternatives considered**:
- *Internal HTTP API added to China Parts' backend*: cleaner coupling, but it requires China Parts code changes, which the scope excludes.
- *Change-data-capture stream (Debezium or binlog)*: real-time, but heavy to operate for a handful of tables.
- *Periodic data dumps*: too stale for session revocation (FR-005) and live prices (FR-036).

**Verify**: replica availability, and network access from the in-Kingdom hosting (R17) to the China Parts database.

## R4. Authenticating China Parts sessions

**Decision**: China Parts issues Laravel Sanctum personal access tokens. This is identified by the `personal_access_tokens` table with a 64-character `token` hash, `abilities`, and `expires_at`. The service validates the same bearer token the apps already send to China Parts:

1. Read `Authorization: Bearer <token>`.
2. If the token contains `|`, split it at the first `|` into `id` and `secret`. Load the row by `id` and compare `sha256(secret)` with `token` in constant time. Otherwise, look the row up by `token = sha256(token)`. This mirrors Sanctum's own lookup.
3. Reject the token if `expires_at` has passed. Also reject it if `CHINAPARTS_TOKEN_EXPIRATION_MINUTES` is set and `created_at` plus that many minutes has passed. This mirrors `sanctum.expiration`.
4. Map `tokenable_type` to `customer` or `seller` through configured values. Every other type, including admins, is refused (FR-007).
5. Cache a successful result in Redis for 60 seconds, keyed by `sha256` of the full token and never the raw token. A signed-out token's row is deleted by Sanctum, so revocation takes effect within 60 seconds, well inside FR-005's 5 minutes.
6. A request with an `Authorization` header that fails any of these checks is refused with 401, even on routes open to signed-out visitors (FR-004a). If the China Parts database can't be reached, the request gets `503 UPSTREAM_UNAVAILABLE` instead, so a database outage never looks like a sign-out to the app.

The service never updates `last_used_at`, because it has no write access.

**Rationale**: Users get single sign-on (FR-003) with no China Parts code change, and Sanctum's lookup is simple and stable.

**Alternatives considered**: Calling a China Parts "who am I" endpoint per request adds latency and couples availability. A separate token exchange needs China Parts code.

**Verify**: the exact `tokenable_type` strings (for example `App\Models\Customer` or a morph alias like `customer`), whether `sanctum.expiration` is set, and whether `sanctum.token_prefix` is used. A prefix is harmless because the whole secret is hashed, but tests should cover it.

## R5. Reels identity

**Decision**: Add a `reels_accounts` collection keyed uniquely by `(accountType, externalId)`. Create the account on the first authenticated request. The ported code reads these fields from Ciro's `User`, so `reels_accounts` keeps the same names: `name`, `username`, `avatarUrl`, `bio`, `blockedUsers`, `followersCount`, `followingCount`, and `totalLikes`. The auth guard sets `req.user.userId` to the reels account's ObjectId, the same shape every ported controller already reads.

**Rationale**: FR-006's customer and seller number collision is solved once, at the identity layer. Every other collection references a single ObjectId, so the ported schemas, indexes, and queries stay unchanged.

**Alternatives considered**: Storing `(type, id)` pairs on every relation. Rejected, because it would rewrite every schema and index in the module.

## R6. Handles

**Decision**:
- **Allowed characters**: Unicode letters (Arabic or Latin), digits, underscore, and period, 3 to 30 characters.
- **Uniqueness**: checked against the normalized form (`usernameNormalized`, see R8), so أحمد and احمد count as the same handle.
- **Generation**: take the seller's shop name or the customer's first name, replace spaces with `_`, and strip other characters. If the result is shorter than 3 characters, use `shop` for sellers or `user` for customers. On a collision, append `_2`, `_3`, and so on.
- **Editing**: owners can change the handle and bio. The bio is limited to 150 characters.

**Rationale**: FR-015 requires a valid handle even for Arabic-only names, and FR-028 requires Arabic @mentions to resolve. Latin-only handles would make Arabic mentions impossible.

**Alternatives considered**: Transliterating Arabic into Latin, which is lossy and produces odd results. Random handles like `user_8f3k`, which are unfriendly to mention.

## R7. Display data, standing, and keeping them current

**Decision**:
- **Seller name**: the `shops.name` of the seller's lowest-id shop, because the schema allows several shops per seller and the spec says "the shop name". Without a shop, use `first_name` plus the last-name initial.
- **Customer name**: `first_name` plus the last-name initial (FR-012).
- **Pictures**: the customer's `customers.image`, resolved against `CHINAPARTS_PUBLIC_STORAGE_URL` when it is a relative path. For sellers, use the shop or seller image from the `media` table with a configured collection name. With no picture, return `null` and the app shows a placeholder.
- **Preferred currency**: `customers.preferred_currency` or `sellers.preferred_currency`, synced onto the reels account as `preferredCurrency`. An empty value means the base currency. Product cards use it (R11, FR-036).
- **Standing**: a customer is in good standing when `status = 1`. A seller is in good standing when `status` matches a configured approved value (default `approved,1`, because the column is a string whose comment lists numeric codes). The identity review status is ignored, as clarified.
- **Sync job**: a BullMQ job repeats every `ACCOUNT_SYNC_INTERVAL_MINUTES` (default 5, at most 10).
  - It re-reads **every** reels account, customers and sellers alike, by primary key in batches of 1,000. At the R20 scale that is about 205 indexed reads per cycle on the replica.
  - It refreshes names, pictures, preferred currency, and standing, then rebuilds the Redis set of reels accounts **not in good standing**.
  - Each account whose standing changed gets a media-visibility job (R12), so direct media links follow standing too (FR-009).
- **Missing accounts (FR-010)**: an account absent from China Parts is stamped `missingSince`. If it is still absent on the next cycle, it becomes `deleted`, joins the not-in-good-standing set, and gets a cleanup job. Requiring two consecutive misses guards against a one-off read error.
- **Mass-miss breaker**: if one cycle finds more than 10 accounts missing **and** more than `SYNC_MAX_MISSING_RATIO` (default 1%) of those checked, it marks nothing and logs an error. A misconfigured or empty replica must never trigger mass deletion.
- **Live check**: the auth guard re-reads the caller's own row whenever its 60-second cache expires, so a suspended user loses write access within a minute. The sync also deletes the `auth:acct:` entry of every account whose standing changed, so the next request sees the new standing at once.
- **Upstream errors**: if any China Parts query fails during a sync, the run stops without marking anything missing or changing any standing. The next scheduled run starts over. An unreachable database must never look like a deleted account.
- **Visibility**: the ported code already removes content from a viewer's block set on every read. Each read now removes the union of the block set and the not-in-good-standing set. This meets FR-009 for API reads with no new query paths or index changes. Media links are handled by R12.

**Rationale**:
- Standing, display, and media-link changes take effect within about 6 minutes, inside FR-009's and FR-014's 15. Deleted accounts are detected within about 10 minutes and cleaned well inside FR-010's 24 hours.
- A full re-read doesn't depend on `updated_at`. Laravel can change a row without touching it, which undermined the earlier incremental design for customers.

**Alternatives considered**:
- *Incremental customer reads by `updated_at`, plus a nightly existence sweep*: the earlier design. Rejected because a status change that skips `updated_at` could stay invisible for a day, and an account deleted just after the sweep could outlive FR-010's 24 hours.
- *Re-reading only recently active accounts*: cheaper, but a dormant suspended account's comments would stay visible.

**Verify**: the actual seller `status` values, the `media` collection names for shop, seller, and product images, and the public storage base URL.

## R8. Arabic text handling

**Decision**: One pure function, `normalizeForMatch(text)`, applied to stored hashtags, handles, public names, and every search query or hashtag lookup:

1. Apply Unicode NFKC, which folds Arabic presentation forms into their base letters.
2. Lowercase.
3. Remove Arabic diacritics (U+064B to U+065F and U+0670) and the stretching character (U+0640).
4. Map أ, إ, آ, and ٱ to ا, ى to ي, and ة to ه.
5. Map Arabic-Indic digits ٠ to ٩ (U+0660 to U+0669) and Persian digits ۰ to ۹ (U+06F0 to U+06F9) to 0 to 9.

Recognition patterns use Unicode property classes:
- Hashtags: `#([\p{L}\p{M}\p{N}_]+)`.
- Mentions: `@([\p{L}\p{M}\p{N}_.]+)`.

The `u` flag is required, and marks (`\p{M}`) are included so a diacritic never cuts a tag in half.

Reels store both `hashtags`, exactly as typed for display, and `hashtagsNormalized` for matching.

**Rationale**: This covers FR-028, FR-049a, and SC-009. The old pattern `#([a-zA-Z0-9_]+)` silently dropped every Arabic hashtag.

**Alternatives considered**: MongoDB text indexes or collation. Neither normalizes Arabic letter variants, and text indexes don't support substring search.

## R9. Feed paging

**Decision**: Replace the ported main-feed logic with keyset paging.

**Background**: the ported logic loads the entire published catalog on every request and slices it in memory. That is fine for a demo catalog and fails SC-003 at production size.

- **Cursor**: an opaque base64url value of `{pass, createdAt, id, injected?}`. Each page is `(createdAt, _id) < cursor`, sorted newest first, limit + 1, on the existing `{status, createdAt, _id}` index. A cursor the service didn't issue gets `400 INVALID_CURSOR`.
- **Looping (FR-020)**: when a pass is exhausted, the page is filled from the top of a new pass (`pass + 1`), skipping reels already on the current page. FR-019's "no duplicates or gaps" holds within a pass, and the loop is FR-020's deliberate exception.
- **Exclusions**: the block set and the not-in-good-standing set are applied as `creatorId $nin`.
- **Reposts (FR-017)**: kept as in Ciro. The first page of pass 0 is seeded with reels reposted by followed accounts, using at most the 50 most recent reposts.
  - The seeded ids travel in the cursor's `injected` list (12-byte ids in base64url, under 1 KB).
  - They are excluded with `_id $nin` for the rest of pass 0, so a seeded reel never reappears in its chronological slot.
  - From pass 1 on, the list is dropped and every reel appears once per pass.
- **Other feeds**: the Following feed, creator and hashtag feeds, the Liked, Saved, and Reposted lists, the reposters list, and comments (on `{videoId, deletedAt, createdAt, _id}`) move to the same keyset style, keyed by the relation's `createdAt`. The operator queues use keyset paging on their own sort keys.
- **Account search (EP26)**: results are ranked exact match first, then by `followersCount`, and capped at 200. The cursor is an opaque offset into that capped list, because a computed ranking has no stable keyset.
- **Page sizes**: clamped rather than rejected, as `min(requested or default, max)`, with defaults and maximums from configuration (R24).
- **Search**: a small `hashtag_stats` collection holds one row per normalized hashtag with its published reel count. Search first finds matching tags by substring (at most 200), then finds reels by `hashtagsNormalized $in` on an index. A substring scan over tags is far cheaper than over every reel.
- **Account search cost**: a substring regex over `usernameNormalized` and `nameNormalized` scans the index keys rather than seeking a range. At up to 205,000 short keys that costs tens of milliseconds, on a signed-in, rate-limited route. The load test measures it. If p95 exceeds 300 ms, the fix is a token collection built like `hashtag_stats`.

**Rationale**: Each page costs the same at any catalog size, which keeps SC-003. The `injected` list keeps FR-017's "shown once each" without server-side session state.

## R10. Request identity, access levels, and rate limits

**Decision**: Resolve identity and enforce access and rate limits through global guards, so a route that forgets an annotation fails closed (constitution V). Global guards run in registration order, before any controller guard:

1. **`IpThrottlerGuard`**: limits every request by client IP to `IP_RATE_LIMIT_PER_MINUTE` (default 1,200). It runs before any token lookup, so a flood of invented tokens can't reach China Parts' database without limit. The limit is generous because mobile carriers put many users behind one IP.
2. **`ViewerAuthGuard`**: reads the route's level from an `@Access()` decorator: `public`, `optional`, `signed-in`, `seller`, or `admin`. A route without the decorator counts as `signed-in`.
   - No `Authorization` header means a guest. A present header is validated through the China Parts strategy (R4).
   - A token that fails validation gets `401 AUTH_INVALID_SESSION`, even on `optional` routes (FR-004a).
   - If China Parts can't be reached, the guard passes `503 UPSTREAM_UNAVAILABLE` through unchanged. It never turns an outage into a sign-out.
   - A guest on a `signed-in` or `seller` route gets `401 AUTH_REQUIRED`. A customer on a `seller` route gets `403 REELS_SELLERS_ONLY`.
   - `admin` routes ignore user sessions. The guard checks `x-admin-key` with a constant-time comparison and fails closed when no key is configured (FR-059). The check lives in this guard rather than on the admin controller, so a missing controller guard can't open an admin route.
   - It sets `req.installationId` from `X-Installation-Id` only when the value is a valid UUID v4.
3. **`IdentityThrottlerGuard`**: limits signed-in callers by account id to `USER_RATE_LIMIT_PER_MINUTE` (default 300), and guests by installation id plus IP to `GUEST_RATE_LIMIT_PER_MINUTE` (default 120, FR-004b). Abuse-prone routes add tighter named limits:
   - uploads: `UPLOAD_RATE_LIMIT_PER_HOUR` (default 20)
   - comment and report writes: `WRITE_RATE_LIMIT_PER_MINUTE` (default 30)
4. **`GoodStandingGuard`**: every non-GET request by a signed-in caller needs good standing (FR-008, `403 ACCOUNT_NOT_IN_GOOD_STANDING`), unless the route carries `@StandingExempt()`. Three routes do:
   - deleting one's own reel (EP10)
   - recording a view (EP16)
   - deleting a comment (EP22). There the service applies the rule itself: the comment's author may delete it without good standing, but a reel owner deleting someone else's comment needs good standing.

   Recording a product tap is not exempt, so a signed-in caller out of good standing gets 403 there. The app sends taps in the background and ignores the result.

The health routes are `public` and skip the throttlers.

- **Guest routes**: the For You feed, hashtag feeds, a single reel, profiles, Reposts lists and reposters, comments (read only), view recording, and product-tap recording. Everything else requires sign-in (FR-004).
- **Guest views (FR-024)**: counted in a `reel_guest_views` collection, unique on `(installationId, reelId)`. The installation ID comes from an `X-Installation-Id` header, a random UUID the app generates once per install.

**Rationale**:
- Global guards run before route guards, so identity has to be resolved globally for the identity throttler to know who is calling.
- The per-IP limit closes a gap in the earlier design. A client sending a fresh installation id with every request escaped the guest limit and could inflate guest views at will.
- Ciro configures `ThrottlerModule` but never applies `ThrottlerGuard`, so the fork brings no throttling for signed-in routes. This design adds it.

**Alternatives considered**:
- *Per-route `@UseGuards(AuthGuard, ThrottlerGuard)`, as first planned*: a forgotten decorator leaves a route open and unthrottled.
- *Throttling signed-in callers by a hash of the unverified token*: rotating invented tokens gets around it.

## R11. Product links

**Decision**:
- **Storage**: up to 5 `productLinks` (`productId`, `position`) are embedded on each reel. They are set from a `productIds` field on upload and replaced through an owner-only endpoint.
- **Validation**: each product must have `seller_id` equal to the uploader, `status = 1`, and `deleted_at IS NULL` (FR-035).
- **Cards (FR-036)**: built live, one batched MySQL query per feed page, cached in Redis for 60 seconds per product in the base currency. Each card carries:
  - `name`
  - `slug`
  - `imageUrl`: the first image by `order_column`
  - `price`: the default active variant's `selling_price`, in the viewer's currency
  - `discountPercentage`: from `products.discount_percentage`
  - `finalPrice`: the price after the discount, in the viewer's currency
  - `currency`: the viewer's currency (below)
  - `available`: `products.stock_quantity > 0`
- **Currency (FR-036)**: prices are converted to the signed-in viewer's `preferredCurrency` (R7). Guests, and viewers with no preferred currency, get the base currency (`CHINAPARTS_BASE_CURRENCY`, default `SAR`).
  - Rates come live from China Parts' own exchange-rate table, read by `exchange-rates.repository.ts` and cached in Redis for `FX_CACHE_SECONDS` (default 300).
  - `price` and `finalPrice` are converted, and `discountPercentage` is not. Until China Parts confirms its own rule, the service converts the base price, then applies the discount, then rounds half-up to 2 decimals.
  - If the viewer's currency has no rate, or the rate table can't be read, the card falls back to the base currency. `currency` always names the unit, so a price never appears in the wrong one.
  - The table and column names come from configuration (`CHINAPARTS_FX_*` in [contracts/chinaparts-read-model.md](contracts/chinaparts-read-model.md)), because the supplied read model doesn't include the currency table yet. A table name can't be a query parameter, so the names are validated against `^[A-Za-z0-9_]+$` at boot and quoted as identifiers.
- **China Parts unreachable during a read**: a feed or reel read never fails because cards can't be built. Products whose cards are still cached are shown, and the others are left out of that response. Validating products for attachment (EP8, EP11) still returns `503 UPSTREAM_UNAVAILABLE`, because nothing is granted without verification.
- **Unavailable products (FR-037)**: a product that is inactive, deleted, or owned by another seller is left out of the cards. The link stays stored so the product reappears if reactivated.
- **Taps (FR-038)**: each tap appends to `reel_product_taps` and increments a counter on the link.

**Rationale**: Prices stay current, and a stale card lasts at most 60 seconds. Converting at response time keeps one cached card per product rather than one per currency.

**Verify**:
- China Parts' storefront applies offers and big sales, so the card's `finalPrice` must match the product page. Confirm the computation, or return only `price` and `discountPercentage` and let the app compute the final price with China Parts' own logic.
- Where China Parts stores exchange rates, which direction a rate runs (units per base currency, or the reverse), and how and when it rounds converted prices.
- The product image collection name.

## R12. Media storage and playback

**Decision**:
- **Storage**: S3-compatible object storage hosted in Saudi Arabia (R17), behind a `StorageService` with an S3 driver (`@aws-sdk/client-s3`) and a local-disk driver for development.
- **Two buckets**: **private** (pending, rejected, and hidden media) and **public** (published media only).
- **Upload**: the ported multipart upload is kept, with the 100 MB limit, the server-side duration check, and the fast-start remux. It writes to a temporary file, then to the private bucket, then removes the temporary file. When no cover image is uploaded, one is generated from a frame at 1 second.
- **Visibility rule**: media sits in the public bucket only while the reel is `published` **and** its creator is in good standing. `ReelLifecycleService.syncMediaVisibility` re-applies this rule after every status change and every standing change (R7). Direct links therefore stop working when an account leaves good standing and work again when it returns (FR-009).
- **State changes**:
  - Publishing or restoring copies the media to the public bucket, if the creator is in good standing.
  - Hiding, rejecting, deleting, or the creator leaving good standing removes the public copy.
  - The creator regaining good standing copies their published reels' media back.
  - Deleting a reel also removes its private media.
- **Standing jobs**: the sync (R7) queues one media-visibility job per account whose standing changed. The job pages through that account's published reels. At up to a few hundred reels per seller, it finishes in minutes, inside FR-009's 15.
- **Cache lifetime**: public objects are written with `Cache-Control: public, max-age=300`. Copies held by phones or proxies therefore expire within FR-009's 15 minutes after a link stops working.
- **Owner previews**: owners see their own non-public media through 15-minute presigned URLs, including their published reels while they are out of good standing.
- **Playback**: from the public bucket's in-Kingdom hostname, which supports HTTP range requests (FR-023). No third-party CDN in v1.

**Rationale**:
- Pending and flagged videos, and the videos of accounts out of good standing, can never be fetched publicly, even by someone who guesses or kept an object URL.
- Publishing is a single server-side copy.
- Serving from in-Kingdom storage satisfies FR-072. A CDN would cache copies at edge locations abroad unless restricted to Saudi points of presence, which needs legal review first.

**Alternatives considered**:
- *One bucket with per-object access controls*: easy to get wrong and not supported uniformly by S3-compatible providers.
- *Direct-to-bucket uploads with presigned URLs*: scales better, but moves the duration check to an asynchronous step. Deferred until upload volume justifies it.

## R13. Automatic screening provider

**Decision**: Keep Sightengine behind the existing provider interface, with a stub provider for development and tests. Before production:

- enable Sightengine's immediate-deletion policy on the account
- sign its GDPR data processing addendum
- choose its processing region
- get written confirmation that no copy is kept in logs or backups (FR-073)

The worker downloads the reel's video from the private bucket to a temporary file, calls the provider, and deletes the file. The pending-sweep retry rules are unchanged (FR-031).

**Rationale**: Sightengine already works with this code. Its FAQ advertises a customer-set deletion policy that can delete submitted content immediately, plus a data processing addendum and a choice of processing region ([Sightengine FAQ](https://sightengine.com/faq/sightengine-vs-competitors-comparison), [content moderation](https://sightengine.com/content-moderation)). The default retention period is not published, so the written confirmation is a launch gate.

**Alternatives considered**: An in-Kingdom moderation provider. None with video screening was identified. If one appears, the provider interface makes switching a single new class.

## R14. Push notifications

**Decision**:
- **Sending**: `firebase-admin` multicast sends, using China Parts' Firebase service account. Customer and seller apps may live in separate Firebase projects, so the service accepts one credential per app.
- **Recipients**: tokens come from `device_tokens`, filtered by the recipient's `tokenable_type`, `tokenable_id`, and `app` (`customer` or `seller`), which meets FR-063.
- **Dead tokens**: the service can't delete them from China Parts, so tokens Firebase reports as unregistered are stored in a Redis set for 30 days and skipped.
- **Language (FR-065)**: text is rendered on the server in Arabic or English, using the recipient's `locale`. The locale is the last `Accept-Language` value (`ar` or `en`) seen on their authenticated requests, defaulting to `ar`. A `LocaleInterceptor` in the accounts module compares it with the locale held in the caller's `auth:acct:` cache entry and writes only when it changes.
- **Payload (FR-073a)**: FCM and APNs relay messages outside Saudi Arabia, which FR-073a permits for this content only.
  - A message carries the `notification` title and body in the recipient's language, which may contain the actor's public name, plus `data` with `source`, `type`, `actorId`, and `reelId`. Nothing else.
  - One `PushPayloadBuilder` composes every message. Its unit test fails if any other field appears (SC-015).
  - Messages expire after 24 hours (`android.ttl`, `apns-expiration`), so undelivered ones aren't held longer than needed.
- **Delivery**: through a BullMQ queue so failures never affect the triggering action (FR-066). The existing notification-event dedup rules are unchanged.

**Rationale**: China Parts has no per-account language setting. Using the last language the account was seen with needs no client work and no native string resources.

**Verify**: whether the two apps share one Firebase project, and the exact `app` values in `device_tokens`.

## R15. Reel links

**Decision**:
- **Domain**: a subdomain such as `reels.<china-parts-domain>`, needing only a DNS record from China Parts, pointed at the service.
- **App link files**: the service serves the files that let a domain open an app: `/.well-known/apple-app-site-association` for the customer app (Team ID and bundle ID from configuration, path `/reels/*`) and `/.well-known/assetlinks.json` (package name and signing-certificate fingerprints from configuration).
- **Store fallback**: `/reels/:id` serves the ported fallback page, pointing at the customer app's store listings (FR-067 to FR-069). iPhones get the App Store link, Android phones get Google Play, and every other device, such as a desktop browser, gets both.
- **Link previews**: the page carries `<link rel="canonical">` and `og:url` built from `LINKS_PUBLIC_BASE_URL`, plus a fixed `og:title` from configuration, so messaging apps preview shared links consistently. Every value is HTML-escaped.
- **Security fix**: the page must validate the id as an ObjectId and HTML-escape it. The ported page inserts the raw id into HTML, which is a cross-site scripting hole.

**Rationale**: Using a subdomain avoids touching the China Parts web server.

**Alternatives considered**: `chinaparts.<domain>/reels/:id`, which needs a routing rule on China Parts' web server. That is possible later as a redirect.

## R16. Comment deletion and reporting

**Decision**:
- **Soft delete**: comments get `deletedAt` and `deletedByRole` (`author`, `reel_owner`, or `operator`). Reads exclude deleted comments. The counter decrement uses a guarded `findOneAndUpdate({_id, deletedAt: null})`, so it runs exactly once (FR-040b).
- **Comment reports**: a new `reel_comment_reports` collection, unique on `(commentId, reporterId)`, with a `dismissedAt` field.
- **Shared daily limit (FR-055)**: counts the reporter's reel and comment reports from the last 24 hours, the same rolling window the ported code uses.
- **Operator list**: groups undismissed reports by comment, newest report first.
- **Dismissing**: sets `dismissedAt` on that comment's open reports. A later report from a new reporter creates a new open report, which puts the comment back on the list.
- **Standing (FR-008)**: a comment's author may delete it even when out of good standing. A reel owner deleting someone else's comment needs good standing, checked in `CommentsService` because the route itself is exempt from the standing guard (R10).
- **Retention**: reports are kept while their reel exists, through hiding, restoring, dismissing, and comment deletion. They are deleted with the reel, whether its owner deletes it (FR-032) or account cleanup removes it (FR-010). This reading satisfies both the spec's "kept for audit" and FR-032, and no report outlives its reel.

**Rationale**: Soft deletion keeps the evidence for audit after removal, which the clarification requires.

## R17. Hosting and data residency

**Decision**:
- **Region**: host everything that stores reels data in Saudi Arabia: the API containers, MongoDB, Redis, object storage, backups, and logs. The reference target is Google Cloud's Dammam region (`me-central2`). Its Cloud Storage is reachable through the S3-compatible API. An in-Kingdom VPS provider with MinIO is an equivalent fallback.
- **MongoDB**: run it ourselves as a replica set. MongoDB Atlas lists no Saudi region, and AWS's Saudi region is not yet open ([Google Cloud Dammam](https://www.googlecloudpresscorner.com/2023-11-15-Google-Cloud-Expands-Regional-Presence-with-Opening-of-Dammam-Cloud-Region-Forecast-to-Boost-Economy-by-USD-109-Billion-by-2030), [AWS Saudi region](https://www.aboutamazon.com/news/aws/aws-cloud-region-saudi-arabia), [Atlas Dammam request](https://feedback.mongodb.com/forums/924145-atlas/suggestions/47277080-support-for-gcp-saudi-arabia-dammam-me-central2-fo)).
- **Monitoring tools**: logs and error reports stay in-Kingdom. Foreign monitoring tools receive no personal data.
- **Deployment**: keep the existing pattern of GitHub Actions deploying over SSH. Build runners handle code, not reels data.
- **Diagnostics**: the CI diagnostics workflow prints container status, `/health/ready`, and environment variable names only. Logs are read over SSH and never copied into CI output, which GitHub stores outside the Kingdom.
- **What may leave**: only screening submissions (FR-073, R13) and push payloads (FR-073a, R14).

**Rationale**: This meets FR-072, FR-073a, and SC-015.

**Verify**: where China Parts' MySQL runs, so the service can be placed with low latency to it.

## R18. Changes to the forked code

Every one of these is a required task, not an optional clean-up.

| Area | Change |
|------|--------|
| Identity | Replace the `User` model with `ReelsAccount` (R5), and replace `JwtAuthGuard` with the global guard chain and `@Access()` levels (R4, R10). The fork's `reels-moderation.service.ts` also imports `User` and changes with the rest. |
| Rate limits | Apply throttling to every route. Ciro configures `ThrottlerModule` but applies no guard (R10). |
| Layering | Move status side effects and response enrichment out of `ReelsDbRepository` into services (R22). |
| Errors | Give every ported error a sentinel (R25). |
| Redis | Bring Ciro's `RedisModule`, which the archive list leaves out, into `src/common/redis` (R23). |
| Typing | Replace `@Request() req: any` with a typed request in every controller, as constitution principle III requires. |
| Feed | Replace the load-everything main feed with keyset paging (R9). |
| Text | Switch hashtag and mention parsing to Unicode, and store normalized forms (R8). |
| Media | Replace local `uploads/` storage and the static file route with the storage service (R12). |
| Notifications | Replace `NotificationsModule` with the push module (R14). |
| Redirect page | Fix the cross-site scripting hole in the store redirect page (R15). |
| Seeding | Load the seed service only when `SEED_DEMO_CONTENT=true`, and refuse it when `NODE_ENV=production` (FR-071). |
| New features | Add product links (R11), comment management (R16), guest access (R10), and standing exclusion (R7). |

## R19. Testing strategy

**Decision**:
- **Unit tests**: colocated `*.spec.ts`, ported along with the module.
- **End-to-end tests**: Supertest against the full app, with:
  - in-memory MongoDB, as Ciro already uses
  - a Testcontainers MySQL 8.0 loaded from `test/fixtures/chinaparts-schema.sql`, the subset of the supplied dump this service reads, and connected as the restricted user
  - a Testcontainers Redis
- **Read-only proof (SC-006)**: a dedicated test checksums the China Parts tables before and after a full run and confirms the restricted user cannot write.
- **Required cases**: an identity-collision fixture where every number exists as both a customer and a seller (SC-005), and a table of Arabic matching cases for `normalizeForMatch` (SC-009).

## R20. Scale and availability assumptions

The spec deferred these. The plan assumes the following for v1, and they should be revisited after launch:

- **Sellers**: up to 5,000 sellers with reels accounts.
- **Customers**: up to 200,000 customers.
- **Reels**: up to 50,000 reels in the first year, about 1 TB of media at roughly 20 MB per reel.
- **Concurrent viewers**: 500 (SC-003).
- **Availability**: two API instances behind a load balancer, plus one worker instance, targeting 99.5% monthly availability.
- **Backups**: daily MongoDB backups to in-Kingdom private storage, kept 14 days.

## R21. Constitution for the new repository

**Decision**: Copy this constitution (v1.0.0) into the new repository and amend it in the first pull request. The amendment is a MINOR bump that adds two permitted exceptions, both recorded in the plan's Complexity Tracking:
- read-only external data sources accessed through a dedicated integration module
- authentication delegated to a host platform's tokens

**Rationale**: The constitution's stack section names MongoDB as the only database and Passport JWT as the only login method. This service necessarily reads MySQL and trusts China Parts tokens.

## R22. Where side effects live

**Decision**: Repositories only read and write data. Status-transition side effects and response enrichment live in services.

- `ReelsDbRepository` depends on Mongoose models and configuration only. It never calls a service.
- Operations that can change a reel's status return the outcome instead of acting on it:
  - `reportReel` returns `hidden` when the report crossed the auto-hide threshold.
  - `deleteReelCascade` returns the deleted reel's status, media keys, and normalized hashtags.
  - `ReelsService` then calls `ReelLifecycleService` with that outcome.
- `ReelLifecycleService` depends on `ReelsDbRepository` (to record `media.location`), `ReelMediaService` (storage copies), `HashtagStatsService`, and `StandingService`. `ReelMediaService` depends only on `StorageService`.
- `ReelPresenter` turns repository results into response DTOs. Once per page, it fills `videoUrl` and `thumbnailUrl` through `MediaUrlService`, and `products` through `ProductLinksService`.
- The shared report limit (FR-055) is checked in `ReelsService` and `CommentReportsService`. Each adds `ReelsDbRepository.countRecentReelReports` to `CommentReportsRepository.countRecent` before writing.

**Rationale**: Constitution II keeps business decisions in services and data access in repositories. It also keeps the dependency graph acyclic. If the repository called the lifecycle service, which writes back through the repository, NestJS would need `forwardRef`.

**Alternatives considered**: Calling services from `ReelsDbRepository` at each ported transition site, as the first task list did. Rejected for the reasons above.

## R23. Shared infrastructure clients

**Decision**: Copy Ciro's `RedisModule` (`src/modules/redis`, a global `REDIS_CLIENT` provider) into `src/common/redis/`. Every Redis use injects it: the token and account caches, the not-in-good-standing set, the product-card and exchange-rate caches, dead push tokens, and sync state. BullMQ and the throttler storage keep their own connections from `REDIS_URL`, as in Ciro.

**Rationale**: Constitution I requires shared clients to come from dedicated modules. The fork's archive list leaves `src/modules/redis` out, so without this decision each service would open its own connection.

## R24. Configurable limits

**Decision**: Every limit FR-070 names is an environment variable validated by Joi, with the spec's value as its default.

| Variable | Default | Requirement |
|----------|---------|-------------|
| `REEL_MAX_VIDEO_BYTES` | 104857600 | FR-026 |
| `REEL_MAX_DURATION_SECONDS` | 60 | FR-026 |
| `REEL_MAX_DESCRIPTION_LENGTH` | 2200 | FR-027 |
| `REEL_COMMENT_MAX_LENGTH` | 500 | FR-040 |
| `REEL_REPORT_REASON_MAX_LENGTH` | 500 | FR-053 |
| `FEED_PAGE_SIZE_DEFAULT`, `FEED_PAGE_SIZE_MAX` | 10, 25 | FR-019 |
| `COMMENTS_PAGE_SIZE_DEFAULT`, `COMMENTS_PAGE_SIZE_MAX` | 20, 50 | FR-040 |
| `REEL_MAX_PRODUCTS` | 5 | FR-035 |
| `REEL_REPORT_DAILY_LIMIT` | 20 | FR-055 |
| `REEL_REPORT_AUTOHIDE_THRESHOLD` | 25 | FR-056 |
| `GUEST_RATE_LIMIT_PER_MINUTE` | 120 | FR-004b |

- **Lengths**: a config-aware class-validator constraint, `@MaxLengthFromConfig('<VARIABLE>')`, enabled through `useContainer` so it can inject `ConfigService`. Structural checks stay as static decorators.
- **Page sizes**: clamped in services rather than rejected (R9).
- **Deadline guards**: settings that protect spec deadlines get Joi maximums. `AUTH_CACHE_TTL_SECONDS` is at most 300 (FR-005), and `ACCOUNT_SYNC_INTERVAL_MINUTES` is at most 10 (FR-009, FR-014).

**Rationale**: Static decorators can't read configuration, and FR-070 forbids code changes for limits. Without the maximums, a configuration change could silently break a timing requirement.

## R25. Error sentinels

**Decision**: Every error the service returns carries a sentinel from the [contracts/rest-api.md](contracts/rest-api.md) table.

- Ported Ciro errors get sentinels too: `REEL_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `CANNOT_FOLLOW_SELF`, `CANNOT_BLOCK_SELF`, `CANNOT_REPORT_OWN_REEL`, `CANNOT_REPOST_OWN_REEL`, `NOT_REEL_OWNER`, `REEL_NOT_HIDDEN`, `INVALID_CURSOR`, `VIDEO_REQUIRED`, `VIDEO_DURATION_UNREADABLE`, `UNSUPPORTED_MEDIA_TYPE`, and `ADMIN_KEY_INVALID`. Their English messages stay as they are.
- The global `ValidationPipe` maps DTO failures to `400 VALIDATION_FAILED`, with the field messages in `message`.
- The exception filter maps anything unexpected to `500 INTERNAL_ERROR` with a generic message, and logs the details server-side only.

**Rationale**: Constitution IV treats client-facing strings as load-bearing. In Ciro, the `error` field fell back to NestJS's generic names such as `Not Found` and `Bad Request`, which a client can't branch on.

## R26. Health checks

**Decision**: `GET /health/live` and `GET /health/ready` sit outside `/api` and use the standard envelope. Readiness returns the status of MongoDB, Redis, and MySQL. A failure is `503 NOT_READY`, listing what failed.

**Rationale**: Load balancers read only the status code, so nothing requires a special format. The envelope exemption stays limited to the three files whose formats Apple, Google, and browsers dictate (constitution IV).

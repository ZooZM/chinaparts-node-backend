# Implementation Plan: China Parts Reels Service

**Branch**: `002-chinaparts-reels-service` | **Date**: 2026-10-09, revised 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-chinaparts-reels-service/spec.md`

**Note**: These design documents live in the Ciro Chat backend repository only until the new repository exists. Move the whole `specs/002-chinaparts-reels-service/` folder there as part of the first task.

## Summary

Build a new, standalone NestJS service for China Parts. It is seeded with a fork of the Ciro Chat reels module at commit `51f8db5`, and the chatbot module will join it later under its own spec.

Each of the fork's three Ciro dependencies is replaced with a China Parts equivalent:

| Ciro dependency | China Parts replacement |
|-----------------|-------------------------|
| Ciro's `User` model | A reels-owned `ReelsAccount`, keyed by account type plus China Parts account number |
| Ciro's JWT login | Validation of China Parts' existing Sanctum tokens |
| Ciro's notifications module | Push to the devices China Parts already has registered |

All China Parts data, including sessions, accounts, standing, shops, products, preferred currencies, exchange rates, and devices, is read through a MySQL user with column-level `SELECT` grants. That user physically cannot write to China Parts or read private fields.

New capabilities on top of the fork:
- product links with live product cards, priced in the viewer's preferred currency
- read-only access for signed-out visitors
- comment deletion and reporting
- Arabic-aware hashtag and search matching
- standing sync that hides suspended accounts' content, including their direct media links

The ported main feed loads the whole catalog per request. It is replaced with keyset paging to meet the performance targets.

All reels data, including media, is hosted in Saudi Arabia. Only two things leave the Kingdom: videos and descriptions sent for automatic screening, with a provider configured to keep nothing, and push payloads restricted to public data.

### Changes in the 2026-10-10 revision

| Source | Change | Research |
|--------|--------|----------|
| Clarification: push residency (FR-073a) | Push payloads are limited to text, the actor's public name, and ids, built in one place and audited | R14, R17 |
| Clarification: good standing (FR-008) | Every write needs good standing, except deleting one's own reels or comments and recording views | R10, R16 |
| Clarification: repost count (FR-060) | `repostersCount` is defined as viewer-relative and never a total | R9, contracts |
| Clarification: media links (FR-009) | Media is public only while the reel is published and its creator is in good standing | R12 |
| Clarification: card currency (FR-036) | Cards are converted to the viewer's preferred currency with China Parts' exchange rates | R7, R11 |
| Analysis: layering | Repositories return outcomes, and services run side effects and enrichment | R22 |
| Analysis: rate limits and access | A global guard chain adds per-IP, per-account, and guest limits, and access defaults to signed-in | R10 |
| Analysis: outages | A China Parts outage returns 503, never a sign-out | R4, R10 |
| Analysis: feed duplicates | The cursor carries injected repost ids, so a reel shows once per pass | R9 |
| Analysis: sync timing | Every account is re-read every cycle, with two-miss deletion and a mass-miss breaker | R7 |
| Analysis: limits, errors, health, Redis | FR-070 variables, a complete sentinel table, health inside the envelope, and a shared Redis module | R23 to R26 |
| Analysis: report retention | Reports are kept while their reel exists and deleted with it | R16 |

## Technical Context

**Language/Version**: TypeScript 5.7+ with full `strict`, on Node.js 22 LTS

**Primary Dependencies**:
- **Carried over from Ciro**: NestJS 11, `@nestjs/mongoose` with Mongoose 9, `@nestjs/bullmq` with BullMQ 5, ioredis, `@nestjs/throttler` with Redis storage, `@nestjs/passport`, class-validator, class-transformer, Joi, helmet, `firebase-admin`, `@nestjs/axios` with `form-data` (Sightengine), `@ffmpeg-installer/ffmpeg`, and `music-metadata`.
- **New**: `mysql2` (read-only China Parts access), `passport-http-bearer` (token strategy), and `@aws-sdk/client-s3` with `@aws-sdk/s3-request-presigner` (object storage).

**Storage**:
- MongoDB 7+ replica set for reels data, self-managed and in-Kingdom.
- Redis 7 for caches, rate limits, and queues, through one shared client (R23).
- S3-compatible object storage in Saudi Arabia for media, with one private and one public bucket.
- China Parts MySQL 8.0, read-only.

**Testing**: Jest with ts-jest for unit tests, and Supertest for end-to-end tests. End-to-end tests use in-memory MongoDB plus Testcontainers for MySQL 8.0 (seeded from the China Parts schema subset) and Redis.

**Target Platform**: Linux containers (Docker) on in-Kingdom infrastructure. The reference target is Google Cloud Dammam (`me-central2`), and an in-Kingdom VPS with MinIO is the fallback.

**Project Type**: Web service (REST API) consumed by the China Parts customer and seller Flutter apps.

**Performance Goals**:
- 95% of feed pages return within 1 second at 500 concurrent viewers (SC-003).
- The first reel plays within 2 seconds (SC-002).
- 95% of clean uploads are published within 2 minutes (SC-004).
- 95% of notifications are delivered within 30 seconds (SC-010).
- Account search stays under 300 ms at p95 (R9).

**Constraints**:
- No writes to China Parts, enforced by database grants.
- A signed-out session stops working within 60 seconds, and never more than 300 seconds. The requirement is 5 minutes.
- Standing, display, and media-link changes appear within about 6 minutes. The requirement is 15 minutes.
- Accounts deleted in China Parts are detected within about 10 minutes and cleaned up well inside 24 hours.
- Uploads are limited to 100 MB and 60 seconds.
- All stored reels data stays in Saudi Arabia. Only screening submissions and push payloads leave.
- A request carrying an invalid session is refused, never downgraded to signed-out access. A China Parts outage returns 503, never a sign-out.
- Every route defaults to signed-in access, and every route except the health checks is rate-limited.

**Scale/Scope**: About 5,000 sellers, 200,000 customers, 50,000 reels, and roughly 1 TB of media in year one (research R20). The service exposes 34 API operations plus 5 public routes. It uses 15 MongoDB collections and reads 9 China Parts tables, one of which, the exchange-rate table, is pending confirmation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The gates are evaluated against `.specify/memory/constitution.md` v1.0.0. The new repository adopts the same constitution, with the amendment in research R21.

| Principle | Status | How the plan complies |
|-----------|--------|-----------------------|
| I. Modular feature architecture | PASS | Each capability is its own module: `reels`, `accounts`, `china-parts`, `push`, and `health`. Shared infrastructure lives in `src/common`: storage, the Redis client (R23), guards, text normalization, errors, and filters. Domain-aware pieces stay in their module, for example the locale interceptor in `accounts`. Modules use each other only through exported providers. |
| II. Layered separation | PASS with justified exceptions | Controllers stay thin, and services call repositories. Repositories never call services. Status side effects run in `ReelLifecycleService`, response enrichment in `ReelPresenter`, and the shared report limit in services (R22). New Mongo repositories extend `BaseRepository`. Two exceptions are recorded under Complexity Tracking: the ported multi-collection `ReelsDbRepository`, and the MySQL read repositories. |
| III. Strict type safety | PASS (gated) | The new repository starts with full `strict: true`. Every ported controller's `@Request() req: any` is replaced with a typed `AuthenticatedRequest` or `ViewerRequest` before merge. |
| IV. Validated boundaries | PASS with justified exception | Every input uses class-validator DTOs. Configurable lengths use a config-aware validator (R24). Responses use the standard envelope, including health checks (R26). Every error carries a documented sentinel (R25), and configuration is validated by Joi. Only the HTML store page and the two `.well-known` files bypass the envelope, because Apple, Google, and browsers fix their formats. |
| V. Security by default | PASS with justified exception | The app keeps helmet, strict CORS, and input sanitization. A global guard chain resolves identity and defaults every route to signed-in. It rate-limits by IP, by account, and by guest, which also covers the signed-in routes Ciro left unthrottled (R10). Database grants block private China Parts fields entirely. The admin key check fails closed. Push payloads carry public data only (R14). Login is delegated to China Parts tokens instead of Passport JWT, which is recorded under Complexity Tracking. The plan also fixes the cross-site scripting hole in the ported redirect page. |
| VI. Performance and scalability | PASS after redesign | The ported feed loads everything per request and is replaced with keyset paging (R9). Hashtag search goes through a tag dictionary, and account search is measured against a 300 ms budget. Screening, push, standing sync, media visibility, and account cleanup all run on BullMQ. Hot state lives in Redis, and reads use lean queries with projections and indexes. |
| VII. Clean code and tests | PASS | Ported specs come along with the code. Every new service gets a colocated unit spec, including the upload service, presenter, lifecycle service, sync processor, currency conversion, and push payload builder. Changed ported services update their existing specs. End-to-end tests cover the identity collision, the read-only proof, guest access, Arabic matching, rate limits, and standing exemptions. |
| Technology standards | PASS with justified exceptions | MySQL is read through `mysql2`, and China Parts tokens are validated through `passport-http-bearer`. Both are recorded below. Socket.IO isn't needed, because the service has no real-time features. |

**Post-design re-check (after Phase 1, revised 2026-10-10)**: PASS. No repository calls a service, and the only repositories that bypass `BaseRepository` are the two recorded exceptions. The contracts keep the standard envelope everywhere except the three files whose formats Apple, Google, and browsers dictate. Every error in the contracts has a sentinel. No new unjustified dependency was introduced.

## Project Structure

### Documentation (this feature)

```text
specs/002-chinaparts-reels-service/
├── spec.md
├── plan.md                    # This file
├── research.md                # Phase 0: decisions R1–R26
├── data-model.md              # Phase 1: collections, state machines, Redis keys
├── quickstart.md              # Phase 1: local setup and verification walkthrough
├── contracts/
│   ├── rest-api.md            # Every endpoint, access level, rate limit, payload, and error sentinel
│   ├── chinaparts-read-model.md  # China Parts tables and columns read, grants, verification checklist
│   └── client-integration.md  # Headers, error handling, reel links, product cards, push payloads
├── checklists/requirements.md
└── tasks.md                   # Phase 2, created by /speckit-tasks
```

### Source Code (new repository, working name `chinaparts-node-backend`)

```text
src/
├── main.ts                         # helmet, CORS, sanitize, ValidationPipe (VALIDATION_FAILED), envelope, filter, useContainer
├── app.module.ts                   # Joi env schema, Mongo, BullMQ, Throttler, MySQL pool, global guard chain (R10)
├── common/
│   ├── filters/global-exception.filter.ts        # copied from Ciro, emits sentinels (R25)
│   ├── interceptors/global-response.interceptor.ts  # copied from Ciro
│   ├── repositories/base.repository.ts           # copied from Ciro
│   ├── throttler/redis-throttler.storage.ts      # copied from Ciro
│   ├── redis/redis.module.ts                     # global REDIS_CLIENT, from Ciro src/modules/redis (R23)
│   ├── errors/error-codes.ts                     # every sentinel (R25)
│   ├── queues/queue-names.ts                     # BullMQ queue names shared across modules
│   ├── config/
│   │   ├── worker-role.ts                        # API and worker process roles
│   │   └── limits.ts                             # typed FR-070 limits and page-size clamping (R24)
│   ├── validation/max-length-from-config.ts      # config-aware length constraint (R24)
│   ├── guards/
│   │   ├── access.decorator.ts          # @Access(level), @StandingExempt()
│   │   ├── ip-throttler.guard.ts        # global 1: per-IP limit
│   │   ├── viewer-auth.guard.ts         # global 2: identity, access levels, admin key
│   │   ├── identity-throttler.guard.ts  # global 3: per-account and guest limits, named route limits
│   │   └── good-standing.guard.ts       # global 4: writes need good standing (FR-008)
│   ├── http/
│   │   ├── viewer-request.ts            # typed req.user, req.installationId
│   │   └── viewer.decorator.ts          # @CurrentUser(), @Viewer()
│   ├── text/normalize-for-match.ts      # Arabic normalization (R8)
│   └── storage/                         # StorageService with S3 and local drivers (R12)
├── modules/
│   ├── china-parts/                     # read-only MySQL adapter (R3)
│   │   ├── china-parts.module.ts
│   │   ├── mysql.provider.ts
│   │   ├── china-parts.config.ts        # value mappings, FX identifiers
│   │   ├── tokens.repository.ts         # personal_access_tokens (R4)
│   │   ├── chinaparts-accounts.repository.ts  # customers, sellers, shops, media, preferred currency
│   │   ├── products.repository.ts       # products, product_variants, media
│   │   ├── exchange-rates.repository.ts # exchange-rate table (R11)
│   │   └── devices.repository.ts        # device_tokens
│   ├── accounts/                        # reels identity (R5–R7)
│   │   ├── schemas/reels-account.schema.ts
│   │   ├── accounts.repository.ts
│   │   ├── accounts.service.ts          # provisioning, handles, profile edits, locale
│   │   ├── china-parts-token.strategy.ts
│   │   ├── standing.service.ts          # not-in-good-standing set
│   │   ├── standing-sync.processor.ts   # full re-read every cycle, missing accounts, breaker (R7)
│   │   ├── locale.interceptor.ts        # Accept-Language to locale (R14)
│   │   └── accounts.controller.ts       # GET and PATCH /api/users/me
│   ├── push/                            # FCM delivery (R14)
│   │   ├── push.module.ts
│   │   ├── push-sender.ts               # PUSH_SENDER interface and PushJob
│   │   ├── push-payload.builder.ts      # the only place payloads are built (FR-073a)
│   │   ├── queued-push.sender.ts
│   │   ├── fcm-push.client.ts
│   │   ├── push.processor.ts
│   │   └── templates/{ar,en}.ts
│   ├── reels/                           # fork of Ciro src/modules/reels
│   │   ├── (ported controllers, services, schemas, DTOs, moderation/)
│   │   ├── feed/                        # feed-cursor.ts (keyset, injected ids) and offset-cursor.ts (account search) (R9)
│   │   ├── lifecycle/                   # reel-lifecycle.service.ts, media-visibility.processor.ts, account-cleanup.processor.ts (FR-010) (R12, R22)
│   │   ├── presentation/                # ReelPresenter: media URLs and product cards (R22)
│   │   ├── products/                    # product-links.service.ts, price-conversion.service.ts (R11)
│   │   ├── comments/                    # deletion, reports, operator queue (R16)
│   │   ├── hashtags/                    # hashtag_stats dictionary (R9)
│   │   ├── media/                       # upload, publish, unpublish, presign, thumbnails (R12)
│   │   └── links/                       # store page + .well-known files (R15)
│   └── health/                          # liveness and readiness, inside the envelope (R26)
test/
├── fixtures/chinaparts-schema.sql       # subset of the supplied dump, plus the stand-in currencies table
├── fixtures/chinaparts-seed.sql         # collision fixture: every id is both a customer and a seller
├── utils/containers.ts                  # Testcontainers MySQL + Redis
└── e2e/*.e2e-spec.ts
docker-compose.yml / docker-compose.local.yml   # api, worker, mongo, redis, minio (+ mysql locally)
.github/workflows/deploy.yml                   # same SSH deploy pattern as Ciro
.github/workflows/diagnostics.yml              # status and health only, never logs (R17)
```

**Structure Decision**: The new repository is a single NestJS service. The reels module imports the accounts module, never the reverse. Work that needs both, such as account cleanup, lives in the reels module, and the accounts sync hands it off by queue name only, so the module graph stays acyclic. The API process and the worker process run the same image. `WORKER_ROLE` decides whether queue processors start, so the API scales independently of background work. The future chatbot module will be added as `src/modules/chatbot/` under its own spec. Nothing in this plan creates it.

## Delivery Order

This order is for task generation. Each step is independently testable, and the steps follow the spec's user story priorities.

1. **Foundation**: new repository, constitution copy and amendment, shared common pieces (envelope, sentinels, Redis module, configurable limits), configuration schema, the global guard chain, `china-parts` module with grants, token strategy, `accounts` module, `health`. Porting puts side effects behind `ReelLifecycleService` and enrichment behind `ReelPresenter` from the start (R22).
2. **US1, watching**: ported feed with keyset paging and injected-id cursor, reel detail, views (signed-in and guest), standing sync (full re-read, missing accounts, breaker), standing exclusion, and guest access with rate limits.
3. **US2, publishing**: storage service, upload into the private bucket, screening worker, the media visibility rule (status and standing), and the seller access level.
4. **US3, engagement**: like, save, share, comments with keyset paging, Liked and Saved lists, and comment deletion with the standing rule.
5. **US4, product links**: attaching and editing products, live cards with currency conversion, and taps.
6. **US5, profiles**: profiles, follow, block, Following feed, handle and bio editing.
7. **US6, search**: normalization, `hashtag_stats`, hashtag feeds, account search with ranked offset paging.
8. **US7, moderation**: reel and comment reporting with the shared limit in services, and the operator queues.
9. **US8, reposts**: reposts, reposters, and the viewer-relative badge count.
10. **US9, notifications**: push module, the payload builder (FR-073a), locale, and dead-token handling.
11. **US10, links**: reel links, `.well-known` files, the fixed store page.
12. **Hardening**: account cleanup cascade (reports go with their reels), backups, residency audit including push payloads (SC-015), read-only proof (SC-006), load test including account search (SC-003), and diagnostics that never export logs.

## Requirement Traceability

Endpoint numbers refer to [contracts/rest-api.md](contracts/rest-api.md). Decision numbers refer to [research.md](research.md).

| Requirements | Delivered by |
|--------------|--------------|
| FR-001, FR-002 | Separate repository and deployment (R1, R17). Column-level read-only grants ([chinaparts-read-model.md](contracts/chinaparts-read-model.md)) |
| FR-003 to FR-007 | `ChinaPartsTokenStrategy`, `ViewerAuthGuard` with `@Access()` levels, and the Redis token cache (R4, R10). Admin and other token types are rejected. Outages return 503 |
| FR-004a, FR-004b | `ViewerAuthGuard` refuses invalid headers. `IdentityThrottlerGuard` limits guests by installation ID plus IP, and `IpThrottlerGuard` bounds rotating installation IDs (R10) |
| FR-008 | `GoodStandingGuard` on every non-GET request, with `@StandingExempt()` on EP10, EP16, and EP22, and the author check in `CommentsService` (R10, R16) |
| FR-009, FR-010 | The full-read standing sync with missing-account detection and the mass-miss breaker, the `standing:excluded` set added to the ported block-set filter, media visibility jobs, and the account cleanup processor (R7, R12) |
| FR-011 to FR-016 | Display fields on `reels_accounts`, synced from China Parts. Handle rules (R6). `GET` and `PATCH /api/users/me` (24, 25). FR-016 is enforced by the grants |
| FR-017 to FR-024 | Keyset feeds with injected-id cursors (R9) on endpoints 1, 2, and 9. Ported owner visibility rules. Media served from the public bucket with range requests (R12). Views on endpoint 16 with `reel_guest_views` |
| FR-025 to FR-033 | Seller access level and endpoint 8. Ported duration check and remux. Unicode parsing (R8). Ported pending state and screening worker with fail-closed retries (R13). Media visibility on each status change through `ReelLifecycleService` (R12, R22). Owner delete on endpoint 10 with cascade. On a failed upload, the temp file and any uploaded object are deleted before the error returns, and the reel document is written only after the object is stored |
| FR-034 to FR-038 | `productLinks` on reels, endpoints 8 and 11, live `ProductCardDto` with a 60-second cache, conversion to the viewer's preferred currency through China Parts' exchange rates, and taps on endpoint 12 (R11) |
| FR-039 to FR-043 | Ported like, comment, save, and share on endpoints 13, 14, 15, and 21. Comment soft delete on endpoint 22 (R16). Liked and Saved lists on endpoints 3 and 4 |
| FR-044 to FR-048 | Ported profiles, follow, and block on endpoints 27 and 28. Mention suggestions on endpoint 7. FR-048 holds by design, since nothing is written to China Parts |
| FR-049 to FR-052 | `normalizeForMatch`, `hashtagsNormalized`, and `hashtag_stats` (R8, R9). Endpoints 1, 6, and 26. Exclusion sets on every read |
| FR-053 to FR-059 | Ported reel reports, auto-hide, and admin routes (19, 29, 30). Comment reports and the operator queue (23, 31, 32, R16). Shared rolling daily limit checked in services (R22). Admin key checked by `ViewerAuthGuard`, failing closed |
| FR-060, FR-061 | Ported reposts on endpoints 5, 17, and 18. Viewer-relative `repostersCount` and `topReposters`, never a total |
| FR-062 to FR-066 | Push module (R14): server-side Arabic and English text, `device_tokens` filtered by app, dead-token cache, BullMQ delivery, ported notification-event dedup. FR-063a is covered by the seller access level and the app capability matrix in [client-integration.md](contracts/client-integration.md) |
| FR-067 to FR-069 | Links module: store page and `.well-known` files on routes 33 to 35 (R15) |
| FR-070, FR-071 | Joi-validated limits with `@MaxLengthFromConfig` and page-size clamping (R24, [quickstart.md](quickstart.md) section 3). `SEED_DEMO_CONTENT`, refused in production |
| FR-072, FR-073, FR-073a | In-Kingdom hosting, storage, backups, and logs, with diagnostics that never export logs (R17). Sightengine immediate-deletion policy as a launch gate (R13). `PushPayloadBuilder` with a field-set test and a 24-hour expiry (R14) |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A second database (MySQL through `mysql2`) beside MongoDB, read by repositories that don't extend `BaseRepository` | China Parts is the source of truth for sessions, accounts, standing, products, exchange rates, and devices. `BaseRepository` is Mongoose-only. | Copying China Parts data into MongoDB through an API or a change stream needs China Parts code changes (excluded by FR-002), or it goes stale and breaks FR-005 and FR-036. |
| Login through China Parts Sanctum tokens (`passport-http-bearer`) instead of Passport JWT | FR-003 requires single sign-on with existing China Parts sessions. The service doesn't issue identities. | Issuing our own JWTs would need a token exchange endpoint in China Parts (excluded) or a second login (forbidden by FR-003). |
| The ported `ReelsDbRepository` keeps touching several models and doesn't extend `BaseRepository` | Feed composition joins reels, likes, saves, reposts, follows, and accounts in one place, behind the existing `ReelsRepository` interface. It returns outcomes and never calls a service (R22). | Splitting it per model during the port would double the port's risk with no behavior gain. It stays recorded debt, and new repositories follow the rule. |
| HTML store page and the `.well-known` app link files bypass the response envelope | Browsers and the Apple and Google link-verification crawlers need these exact formats. | Wrapping them in the envelope breaks app link verification and the store fallback. |

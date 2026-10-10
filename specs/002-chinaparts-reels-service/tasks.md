---

description: "Task list for the China Parts Reels Service"
---

# Tasks: China Parts Reels Service

**Input**: Design documents from `specs/002-chinaparts-reels-service/`

**Prerequisites**: [plan.md](plan.md) (revised 2026-10-10), [spec.md](spec.md), [research.md](research.md) (R1–R26), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included. Constitution principle VII requires a colocated unit spec for every service with business logic. Research R19 and success criteria SC-005, SC-006, SC-009, and SC-014 require the end-to-end suites below. Write each story's end-to-end test first and confirm it fails before implementing.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and demonstrated on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel, because it touches different files and depends on no incomplete task.
- **[Story]**: The user story the task belongs to (US1 to US10, from spec.md).

## Path Conventions

- **New repository paths**: every path is relative to the new repository root, `chinaparts-node-backend/` (plan.md, "Source Code").
- **Ciro paths**: `Ciro:<path>` means that file in the Ciro Chat backend (`chat-app-backend`) at commit `51f8db5`, the fork source (research R1).
- **References**: "R#" means a decision in research.md, "EP#" means an endpoint number in contracts/rest-api.md, and "FR-"/"SC-" mean spec.md requirements and success criteria.

## Rules that apply to every task

- **Errors**: every error carries a sentinel from the contracts/rest-api.md "Error sentinels" table, thrown as `new XxxException({ error: ErrorCode.X, message })` (R25).
- **Access**: every route declares its level with `@Access()` from `src/common/guards/access.decorator.ts`, matching the contracts/rest-api.md endpoint tables. A route without it is treated as Signed-in (R10).
- **Layering**: repositories never import or call a service. Status side effects go through `ReelLifecycleService`, and response enrichment goes through `ReelPresenter` (R22).
- **Redis**: every Redis use injects `REDIS_CLIENT` from `src/common/redis/redis.module.ts` (R23).
- **Limits**: every FR-070 limit is read through `LimitsService` or `@MaxLengthFromConfig`, never hard-coded (R24).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the repository, tooling, and fixtures.

- [X] T001 Create the repository `chinaparts-node-backend/` and fork the sources per quickstart.md §1.
  - **Archive**: run `git archive 51f8db5` from Ciro to extract `src/modules/reels`, `src/modules/redis`, and `src/common/{filters,interceptors,repositories,throttler}`.
  - **Redis module**: move `src/modules/redis/redis.module.ts` to `src/common/redis/redis.module.ts` (R23), and delete the empty `src/modules/redis/`.
  - **Docs**: copy `specs/002-chinaparts-reels-service/` and `.specify/memory/constitution.md` from the Ciro working tree, since both are gitignored there.
  - **README**: write `README.md` stating "Reels module forked from chat-app-backend@51f8db5" and linking specs/002-chinaparts-reels-service/plan.md.
- [X] T002 Initialize the NestJS 11 project in `package.json`, `tsconfig.json`, `tsconfig.build.json`, and `nest-cli.json`.
  - **Runtime dependencies**: @nestjs/{common,core,platform-express,config,mongoose,bullmq,throttler,passport,axios}, mongoose@9, bullmq@5, ioredis, mysql2, passport, passport-http-bearer, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, firebase-admin, class-validator, class-transformer, joi, helmet, express-mongo-sanitize, xss-clean, form-data, @ffmpeg-installer/ffmpeg, music-metadata@7, rxjs, reflect-metadata.
  - **Dev dependencies**: @nestjs/testing, jest, ts-jest, supertest, mongodb-memory-server, testcontainers, @testcontainers/mysql, @testcontainers/redis, @types/*, typescript@5.7.
  - **Scripts**: build, start, start:dev, lint, format, test, test:e2e.
  - **TypeScript**: `strict: true`, `emitDecoratorMetadata`, `experimentalDecorators`, target ES2023.
- [X] T003 [P] Copy `Ciro:eslint.config.mjs` and `Ciro:.prettierrc` to `eslint.config.mjs` and `.prettierrc`. Keep the type-checked typescript-eslint config, and set `@typescript-eslint/no-explicit-any`, `no-floating-promises`, and `no-unsafe-argument` to `error`.
- [X] T004 [P] Amend `.specify/memory/constitution.md` to v1.1.0 (MINOR), per R21. Add the two permitted exceptions to "Technology & Platform Standards": read-only external data sources through a dedicated integration module, and authentication delegated to host-platform tokens. Update the Sync Impact Report. Create `CLAUDE.md` with a `<!-- SPECKIT START -->` block pointing to specs/002-chinaparts-reels-service/plan.md.
- [X] T005 [P] Create `Dockerfile`, `docker-compose.yml`, and `docker-compose.local.yml`.
  - **`Dockerfile`**: multi-stage `node:22-bookworm-slim`, running `npm ci` then `npm run build`, with entrypoint `node dist/main.js`. The runtime stage also copies `assets/seed/`, so the development seeder works in staging images (T038).
  - **`docker-compose.yml`**: service `api` (`WORKER_ROLE=api`), `worker` (`WORKER_ROLE=worker`, same image), `mongo:7` started with `--replSet rs0` plus an init healthcheck, and `redis:7`.
  - **`docker-compose.local.yml`**: adds `mysql:8.0`, mounting `test/fixtures/{chinaparts-schema,chinaparts-seed,grants}.sql` into `/docker-entrypoint-initdb.d` in that order. It also adds `minio/minio` plus a `minio/mc` init container that creates `reels-private` and `reels-public` and sets anonymous download on `reels-public`.
- [X] T006 [P] Create `.gitignore` and `.env.example` in the repository root. `.gitignore` covers node_modules, dist, .env, .local-media, and coverage. `.env.example` contains:
  - every variable in quickstart.md §3
  - the `CHINAPARTS_*` mapping variables from contracts/chinaparts-read-model.md ("Configuration that maps China Parts values")
  - the seeder's `SEED_SELLER_EXTERNAL_IDS=1` and `SEED_CUSTOMER_EXTERNAL_IDS=1,2` (T038)
- [X] T007 [P] Create the China Parts test fixtures in `test/fixtures/`.
  - **`test/fixtures/chinaparts-schema.sql`**: the eight `CREATE TABLE` statements from the appendix of contracts/chinaparts-read-model.md, with `PRIMARY KEY (id)` on each table and `device_tokens`. Add the stand-in `currencies (code varchar(3) PRIMARY KEY, exchange_rate decimal(16,6) NOT NULL)` described in that appendix.
  - **`test/fixtures/grants.sql`**: the grant script from that contract with `<db>=chinaparts_dev`, `<host>='%'`, password `reels_ro_local`, and `<fx_table>`/`<fx_code_column>`/`<fx_rate_column>` = `currencies`/`code`/`exchange_rate`, without `REQUIRE SSL`. Also create `reels_audit` with `SELECT` on `chinaparts_dev.*` and password `reels_audit_local`.
  - **`test/fixtures/chinaparts-seed.sql`**: the fixture list in quickstart.md §2.
    - Customers 1 to 3. Customer 3 has `status=0`. Customer 2 has `preferred_currency='USD'`. Everyone else has `NULL`.
    - Sellers 1 to 3. Seller 1 is `approved` with shop `قطع غيار الرياض`, seller 2 is `suspended`, and seller 3 is `pending`.
    - Products 101 to 104 for seller 1: 101 active with stock 5, 102 active with stock 0, 103 with `status=0`, and 104 soft-deleted. Product 201 belongs to seller 2.
    - A default active variant for each product, with `selling_price` 45.00 and 101's `discount_percentage` 10.00.
    - `media` rows for product 101 (collection `images`) and shop 1 (collection `logo`).
    - `device_tokens` for customer 1 (app `customer`) and seller 1 (app `seller`).
    - `currencies` rows `('SAR', 1.000000)` and `('USD', 0.266667)`.
- [X] T008 [P] Create the test media in `test/fixtures/media/` and `assets/seed/`, and the end-to-end scaffolding in `test/jest-e2e.json` and `test/utils/containers.ts`.
  - **Media**: generate `test/fixtures/media/sample-10s.mp4` and `test/fixtures/media/sample-70s.mp4` with `ffmpeg -f lavfi -i testsrc=duration=N:size=320x568:rate=24 -f lavfi -i sine=duration=N -shortest -movflags +faststart`. Copy `sample-10s.mp4` to `assets/seed/sample-10s.mp4`.
  - **Jest**: create `test/jest-e2e.json` with a 120 s timeout, `testRegex` `.e2e-spec.ts$`, and `rootDir` `.`.
  - **Containers**: create `test/utils/containers.ts`. It starts Testcontainers MySQL 8.0 (running the three fixture files as root) and Redis 7, and exports their connection settings plus `rootQuery(sql, params)` and `stopMysql()`/`startMysql()` helpers for test-only setup.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Bootstrap, the global guard chain, China Parts access, sign-in, the reels identity, and porting the forked module so it compiles and runs on `reels_accounts` with the R22 layering.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T009 Implement `src/app.module.ts`.
  - **Configuration**: `ConfigModule.forRoot` with a Joi schema covering every variable in `.env.example`.
    - Every optional string uses `.optional().allow('')`, because of Ciro deploy gotcha 2 (quickstart.md §3).
    - `STORAGE_DRIVER` is `s3` or `local`. The `S3_*` variables are required when it is `s3`, using `Joi.when`.
    - `WORKER_ROLE` is `api`, `worker`, or `all`, defaulting to `all`.
    - Every FR-070 limit in R24 is an integer of at least 1 with the spec's default. `AUTH_CACHE_TTL_SECONDS` is at most 300, and `ACCOUNT_SYNC_INTERVAL_MINUTES` is at most 10. `SYNC_MAX_MISSING_RATIO` is between 0 and 1.
    - `CHINAPARTS_FX_TABLE`, `CHINAPARTS_FX_CODE_COLUMN`, and `CHINAPARTS_FX_RATE_COLUMN` match `^[A-Za-z0-9_]+$`. `CHINAPARTS_FX_RATE_DIRECTION` is `per_base` or `to_base`.
  - **Connections**: `MongooseModule.forRootAsync(MONGODB_URI)`, `BullModule.forRootAsync(REDIS_URL)`, `RedisModule` from `src/common/redis/redis.module.ts`, and `ThrottlerModule.forRootAsync` with `RedisThrottlerStorage` from `src/common/throttler/redis-throttler.storage.ts`. Do **not** register `ThrottlerGuard`. The custom guards in T026 use the storage directly.
  - **Worker role**: export `src/common/config/worker-role.ts` with `isWorkerRole(config)`. Feature modules use it to register queue processors only when the role is `worker` or `all`.
  - **Queues**: export `src/common/queues/queue-names.ts` with `ACCOUNTS_SYNC`, `ACCOUNTS_CLEANUP`, `MEDIA_VISIBILITY`, `REELS_MODERATION`, and `REELS_PUSH`.
- [X] T010 Implement `src/main.ts` with:
  - `helmet()`, plus CORS from the `CORS_ORIGINS` list, read through `ConfigService` and validated by T009's schema (constitution IV)
  - `express-mongo-sanitize` and `xss-clean`
  - a global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, and `transform`, whose `exceptionFactory` throws `BadRequestException({ error: 'VALIDATION_FAILED', message: <field messages> })` (R25)
  - `useContainer(app.select(AppModule), { fallbackOnErrors: true })`, so validation constraints can inject `ConfigService` (R24)
  - the global `GlobalResponseInterceptor` and `GlobalExceptionFilter`
  - `app.set('trust proxy', 1)`
  - **no** static `/uploads` route, because media comes from object storage (R12)
- [X] T011 [P] Create `src/common/errors/error-codes.ts`, exporting every sentinel in the contracts/rest-api.md "Error sentinels" table as `const enum ErrorCode`.
  - **Filter**: update `src/common/filters/global-exception.filter.ts`. An `HttpException` whose response contains `{ error: <sentinel> }` produces `{ success:false, error, message, statusCode }`. Anything that isn't an `HttpException` produces `500 INTERNAL_ERROR` with a generic message, and its stack is logged server-side only. Remove the ported `any` casts.
  - **Tests**: add `src/common/filters/global-exception.filter.spec.ts`.
- [X] T012 [P] Implement the configurable limits per R24 in `src/common/config/limits.ts` and `src/common/validation/max-length-from-config.ts`.
  - **`src/common/config/limits.ts`**: a `LimitsService` exposing every R24 limit as typed numbers, plus `clampPageSize(kind: 'feed'|'comments', requested?: number): number`, which returns `min(requested ?? default, max)`.
  - **`src/common/validation/max-length-from-config.ts`**: a class-validator constraint `@MaxLengthFromConfig('<VARIABLE>')` that injects `ConfigService` and measures the trimmed string.
  - **Tests**: `limits.spec.ts` and `max-length-from-config.spec.ts`.
- [X] T013 [P] Create the typed request shapes in `src/common/http/`.
  - **`src/common/http/viewer-request.ts`**: `AuthenticatedUser { userId: string; accountType: 'customer'|'seller'; externalId: number; standing: 'good'|'suspended'|'deleted'; locale: 'ar'|'en'; preferredCurrency: string | null }`, plus `AuthenticatedRequest` and `ViewerRequest` (with optional `user` and `installationId`).
  - **`src/common/http/viewer.decorator.ts`**: param decorators `@CurrentUser()`, which returns `AuthenticatedUser`, and `@Viewer()`, which returns `{ user?: AuthenticatedUser; installationId?: string }`.
- [X] T014 [P] Implement `src/common/text/normalize-for-match.ts` per R8.
  - **`normalizeForMatch()`**: NFKC, lowercase, strip U+064B–U+065F, U+0670, and U+0640, map أإآٱ to ا, ى to ي, and ة to ه, and map U+0660–U+0669 and U+06F0–U+06F9 to 0–9.
  - **Patterns**: export `HASHTAG_PATTERN = /#([\p{L}\p{M}\p{N}_]+)/gu` and `MENTION_PATTERN = /@([\p{L}\p{M}\p{N}_.]+)/gu`.
  - **Tests**: `src/common/text/normalize-for-match.spec.ts` with a table covering each letter mapping, diacritics, tatweel, both digit styles, Latin case, presentation forms, and mixed Arabic, English, and emoji text (SC-009).
- [X] T015 [P] Implement the storage service in `src/common/storage/` per R12.
  - **`storage.module.ts`**: global.
  - **`storage.service.ts`**: an interface with:
    - `putFile(bucket, key, filePath, contentType)` and `copy(fromBucket, toBucket, key)`. Every write into `S3_PUBLIC_BUCKET` sets `Cache-Control: public, max-age=300` (R12).
    - `delete(bucket, key)`, `downloadToTemp(bucket, key): Promise<string>`, and `presignGet(bucket, key, ttlSeconds)`.
    - `publicUrl(key)`, which uses `MEDIA_PUBLIC_BASE_URL`.
  - **Drivers**: `drivers/s3.driver.ts` uses `@aws-sdk/client-s3` with `S3_ENDPOINT` and `forcePathStyle`. `drivers/local.driver.ts` uses `./.local-media/<bucket>/`.
  - **Tests**: `storage.service.spec.ts` against the local driver, including the public-bucket `Cache-Control` metadata.
- [X] T016 Create the China Parts module in `src/modules/china-parts/` per R3.
  - **`china-parts.module.ts`**: exports the repositories below.
  - **`mysql.provider.ts`**: a `mysql2/promise` pool from `CHINAPARTS_MYSQL_*`, with optional SSL and `connectionLimit` 10, plus a `ping()` for health checks. Wrap every driver error as `ServiceUnavailableException({ error: 'UPSTREAM_UNAVAILABLE' })`.
  - **`china-parts.config.ts`**: parses the mapping variables in contracts/chinaparts-read-model.md into typed sets: customer, seller, product, and shop types, approved seller values, collections, disk URLs, token expiry, base currency, and the validated FX identifiers and rate direction.
- [X] T017 [P] Implement `src/modules/china-parts/tokens.repository.ts`.
  - **Methods**: `findById(id)` and `findByHash(sha256Hex)`, using exactly the column lists in contracts/chinaparts-read-model.md ("Queries the service runs").
  - **Tests**: `tokens.repository.spec.ts` mocks the pool and asserts that no `SELECT *` is ever issued.
- [X] T018 [P] Implement `src/modules/china-parts/chinaparts-accounts.repository.ts`.
  - **Methods**: `getCustomers(ids)` and `getSellers(ids)`, which uses the lowest-id shop subquery. Both batch in groups of 1,000 and read `preferred_currency`, never `updated_at`. They return only the rows found, and callers derive missing ids.
  - **Images**: resolved per R7. Relative `customers.image` paths get `CHINAPARTS_PUBLIC_STORAGE_URL`. Seller and shop images come from `media` through `CHINAPARTS_MEDIA_URL_TEMPLATE` and `CHINAPARTS_DISK_URLS`.
  - **Output**: maps rows to `ChinaPartsAccount { accountType, externalId, name, avatarUrl, standing, preferredCurrency }`.
    - Customer name is `first_name` plus the last-name initial with a period.
    - Seller name is the shop name, falling back to the customer format.
    - A customer is `good` when status is 1. A seller is `good` when status is in the approved values. Everything else is `suspended`.
    - An empty `preferred_currency` becomes `null`.
  - **Tests**: `chinaparts-accounts.repository.spec.ts`.
- [X] T019 Create `src/modules/accounts/schemas/reels-account.schema.ts` with every field and index in the data-model.md "reels_accounts" section, including `locale`, `preferredCurrency`, and `missingSince`. Field names `name`, `username`, `avatarUrl`, `bio`, `blockedUsers`, `followersCount`, `followingCount`, and `totalLikes` must match what the ported reels code reads from Ciro's `User`. `blockedUsers` is typed `Types.ObjectId[]` with ref `ReelsAccount`.
- [X] T020 Implement `src/modules/accounts/accounts.repository.ts`, extending `BaseRepository<ReelsAccountDocument>`.
  - **Methods**:
    - `findByExternal(type, externalId)` and `createProvisioned(data)`
    - `findByIdsLean(ids, projection)` and `listByType(type, afterId, limit): Promise<{ id: string; externalId: number }[]>`, which pages over every account for the sync
    - `updateDisplay(id, { name, nameNormalized, avatarUrl, standing, preferredCurrency, syncedAt })`
    - `setMissingSince(ids, date | null)`, `markDeleted(ids)`, `updateLocale(id, locale)`, and `updateProfile(id, { username, usernameNormalized, bio })`
  - **Rule**: every read is `.lean()` with a projection.
- [X] T021 [P] Implement `src/modules/accounts/handle.util.ts` per R6.
  - **`generateHandleBase(name, accountType)`**: spaces become `_`, characters outside `[\p{L}\p{M}\p{N}_.]` are stripped, and the result is cut to 30 characters. Under 3 characters, the fallback is `shop` for sellers or `user` for customers.
  - **`isValidHandle(value)`**: true for 3 to 30 characters of letters, marks, digits, `_`, or `.`.
  - **Tests**: `handle.util.spec.ts` covering an Arabic-only shop name, a mixed name, symbols, and short names.
- [X] T022 Implement `src/modules/accounts/accounts.service.ts` and `src/modules/accounts/accounts.module.ts`. The module exports `AccountsService`, `AccountsRepository`, `StandingService`, and the `ReelsAccount` Mongoose feature.
  - **`resolveOrProvision(chinaPartsAccount)`**: finds by `(accountType, externalId)`. If missing, it creates the account with a generated handle, retrying on a duplicate `usernameNormalized` with `_2`, `_3`, and so on, up to 20 times. If found, it refreshes the display fields and `preferredCurrency` when they changed.
  - **`getMe(userId)`**.
  - **`updateMe(userId, {username?, bio?})`**: validates with `isValidHandle`, limits the bio to 150 characters, and returns `409 USERNAME_TAKEN` on a normalized collision.
  - **`recordLocale(userId, 'ar'|'en')`**.
  - **Tests**: `accounts.service.spec.ts`.
- [X] T023 [P] Implement `src/modules/accounts/standing.service.ts` per R7. It maintains the Redis set `standing:excluded` of account ids not in good standing, with `isExcluded(id)`, `members()` cached in memory for 10 s, `add(id)`, `remove(id)`, and `replaceAll(ids)`. Write `replaceAll` atomically through a temporary key plus `RENAME`. Add `standing.service.spec.ts`.
- [X] T024 Implement `src/modules/accounts/china-parts-token.strategy.ts`, a `PassportStrategy(BearerStrategy, 'chinaparts')`, following R4's steps 1 to 6 exactly.
  - **Validation**: compare hashes with `crypto.timingSafeEqual`. Apply `CHINAPARTS_TOKEN_EXPIRATION_MINUTES`. A `tokenable_type` outside the customer and seller sets is rejected (FR-007).
  - **Caching**: cache `auth:tok:{sha256(token)}` for `AUTH_CACHE_TTL_SECONDS`. Refresh the account through `ChinaPartsAccountsRepository` behind the 60 s `auth:acct:` cache, which holds `{ standing, name, avatarUrl, locale, preferredCurrency }` (data-model.md "Redis Keys").
  - **Side effects**: call `AccountsService.resolveOrProvision`. When standing changed, update `reels_accounts.standing` and `StandingService`.
  - **Result**: return `AuthenticatedUser`. Validation failures throw `UnauthorizedException({ error: 'AUTH_INVALID_SESSION' })`. `UPSTREAM_UNAVAILABLE` from the MySQL provider propagates unchanged and is never converted to 401.
  - **Tests**: `china-parts-token.strategy.spec.ts` covering an `id|secret` token, a pipeless token, a prefixed token, an expired token, a deleted row, an admin type, the customer/seller collision (SC-005), a cache hit, and MySQL down returning 503.
- [X] T025 Implement the access decorators and the identity guard in `src/common/guards/` per R10, step 2.
  - **`access.decorator.ts`**: `@Access('public'|'optional'|'signed-in'|'seller'|'admin')`, `@StandingExempt()`, `@RateLimitClass('upload'|'write')`, and `@SkipRateLimit()`.
  - **`viewer-auth.guard.ts`**: reads the level, defaulting to `signed-in`.
    - With no `Authorization` header, the caller is a guest. With one, it runs the `chinaparts` strategy. Validation failures are `401 AUTH_INVALID_SESSION`, and `503 UPSTREAM_UNAVAILABLE` passes through unchanged.
    - A guest on `signed-in` or `seller` gets `401 AUTH_REQUIRED`. A customer on `seller` gets `403 REELS_SELLERS_ONLY`.
    - `admin` ignores user sessions and checks `x-admin-key` against `ADMIN_API_KEY` with `crypto.timingSafeEqual`. It returns `401 ADMIN_KEY_INVALID` when the key is wrong or missing, or when no key is configured.
    - It sets `req.installationId` from `X-Installation-Id` only when the value is a valid UUID v4.
  - **Ported guard**: fold the cases of `src/modules/reels/admin-key.guard.spec.ts` into `viewer-auth.guard.spec.ts`, then delete `src/modules/reels/admin-key.guard.ts` and its spec.
  - **Tests**: `viewer-auth.guard.spec.ts`.
- [X] T026 [P] Implement the throttling guards in `src/common/guards/` per R10, steps 1 and 3. Both are custom `CanActivate` guards that call the injected `ThrottlerStorage.increment(key, ttlMs, limit, 0, name)`. Over the limit, they throw `429 RATE_LIMITED` with a `Retry-After` header. Both skip routes marked `@SkipRateLimit()`.
  - **`ip-throttler.guard.ts`**: key `ip:{req.ip}`, limit `IP_RATE_LIMIT_PER_MINUTE` per minute.
  - **`identity-throttler.guard.ts`**:
    - Signed-in callers use key `user:{userId}` with `USER_RATE_LIMIT_PER_MINUTE`. Guests use `guest:{installationId ?? 'none'}:{ip}` with `GUEST_RATE_LIMIT_PER_MINUTE`.
    - Routes marked `@RateLimitClass('upload')` add `upload:{userId}` with `UPLOAD_RATE_LIMIT_PER_HOUR` per hour.
    - Routes marked `@RateLimitClass('write')` add `write:{userId}` with `WRITE_RATE_LIMIT_PER_MINUTE`.
  - **Tests**: `ip-throttler.guard.spec.ts` and `identity-throttler.guard.spec.ts`.
- [X] T027 [P] Implement `src/common/guards/good-standing.guard.ts` per R10, step 4. For any non-GET request with `req.user`, it throws `403 ACCOUNT_NOT_IN_GOOD_STANDING` unless `standing === 'good'` or the route carries `@StandingExempt()`. Add `good-standing.guard.spec.ts`.
- [X] T028 Register the global guard chain in `src/app.module.ts` as `APP_GUARD` providers in exactly this order: `IpThrottlerGuard`, `ViewerAuthGuard`, `IdentityThrottlerGuard`, `GoodStandingGuard`. Add a comment explaining that the order is load-bearing (R10).
- [X] T029 Implement the `src/modules/health/` module and register it in `src/app.module.ts`.
  - **Routes**: `health.controller.ts` serves `GET /health/live` (always 200) and `GET /health/ready`, which pings MongoDB, Redis, and MySQL. Both sit outside `/api` and carry `@Access('public')` and `@SkipRateLimit()`.
  - **Envelope**: both return the standard envelope. A failed readiness check throws `ServiceUnavailableException({ error: 'NOT_READY', message })`, with `message` naming the failed dependencies (R26).
- [X] T030 Port identity across `src/modules/reels/`: replace every use of Ciro's `User` model with `ReelsAccount`.
  - **Files**: `reels.module.ts` (import `AccountsModule` instead of registering `User`), `reels.service.ts`, `reels-db.repository.ts`, `reels-moderation.service.ts`, `reels-notifications.service.ts`, `reels-text.util.ts`, `reels-seed.service.ts`, and every `schemas/*.ts` (`ref: 'User'` becomes `ref: 'ReelsAccount'`).
  - **Imports**: remove every import from `../users/`.
  - **Username search**: `searchUsers` matches `usernameNormalized` and `nameNormalized` instead of `username` and `name`.
- [X] T031 Port access in `src/modules/reels/reels.controller.ts`, `reels-users.controller.ts`, and `reels-admin.controller.ts`.
  - **Access**: remove every `JwtAuthGuard` and `AdminKeyGuard` use. Add `@Access('seller')` to EP8 and EP11, and a class-level `@Access('admin')` on the admin controller. Give every other route an explicit `@Access('signed-in')`, because T103 fails on any route that relies on the default. US1 later switches the guest routes to `optional`.
  - **Standing**: add `@StandingExempt()` to EP10 (delete own reel) and EP16 (view).
  - **Typing**: replace every `@Request() req: any` with `@CurrentUser() user: AuthenticatedUser`, passing `user.userId` where `req.user.userId` was used. Give every public method an explicit return type (constitution III).
- [X] T032 Port errors to sentinels in `src/modules/reels/**` per R25. Every ported `throw new XxxException('<text>')` becomes `throw new XxxException({ error: ErrorCode.X, message: '<text>' })`, keeping the text:
  - `Reel not found` → `REEL_NOT_FOUND`, and `User not found` → `ACCOUNT_NOT_FOUND`
  - `Cannot follow yourself` → `CANNOT_FOLLOW_SELF`, and `Cannot block yourself` → `CANNOT_BLOCK_SELF`
  - `Cannot report your own reel` → `CANNOT_REPORT_OWN_REEL`, and `Cannot repost your own reel` → `CANNOT_REPOST_OWN_REEL`
  - `Only the owner can delete this reel` → `NOT_REEL_OWNER`, and `Reel is not hidden` → `REEL_NOT_HIDDEN`
  - `Invalid cursor` → `INVALID_CURSOR`
  - `A video file is required` → `VIDEO_REQUIRED`, `Unsupported file type` → `UNSUPPORTED_MEDIA_TYPE`, `Could not read the video duration` → `VIDEO_DURATION_UNREADABLE`, and the duration-limit error → `VIDEO_TOO_LONG`
  - the report-limit `HttpException` (429) → `REPORT_DAILY_LIMIT`
- [X] T033 Port notifications to a pluggable sender in `src/modules/push/`.
  - **New**: create `src/modules/push/push-sender.ts` (a `PUSH_SENDER` token, a `PushSender` interface with `send(message: PushJob): Promise<void>`, and the `PushJob` type `{ recipientId, type, actorId?, reelId? }`). Also create `src/modules/push/noop-push.sender.ts`, which logs at debug, and `src/modules/push/push.module.ts`, which provides the no-op sender.
  - **Changed**: `src/modules/reels/reels-notifications.service.ts` keeps its event recording and dedup logic but replaces `PushService` and `DeviceTokensRepository` with an injected `PUSH_SENDER`.
  - **Done when**: T030 to T033 are complete and the reels module compiles. Until then, the controllers still import Ciro's `jwt-auth.guard` (removed in T031) and this service imports `../notifications/` (removed here).
- [X] T034 Port text parsing in `src/modules/reels/reels-text.util.ts` per R8 and FR-028.
  - **Parsing**: use `HASHTAG_PATTERN` and `MENTION_PATTERN`. Return `hashtags` (display form, deduplicated by normalized value), `hashtagsNormalized`, and `mentions` resolved through `usernameNormalized $in`.
  - **Schema**: in `src/modules/reels/schemas/reel.schema.ts`, add `hashtagsNormalized: string[]`, and replace the `{hashtags, createdAt}` index with `{hashtagsNormalized: 1, createdAt: -1, _id: -1}`.
  - **Tests**: add `reels-text.util.spec.ts` covering Arabic tags, a tag split by diacritics, and mixed text.
- [X] T035 Port the media model in `src/modules/reels/media/` and `src/modules/reels/schemas/reel.schema.ts`.
  - **Schema**: replace `videoUrl` and `thumbnailUrl` with `media: { videoKey, thumbnailKey, location: 'private'|'public' }` (data-model.md).
  - **`src/modules/reels/media/media-url.service.ts`**: `urlsFor(reel, viewerId?)`. When `media.location` is `public`, it returns `StorageService.publicUrl`. For the owner otherwise, it returns `presignGet` with a 900 s TTL. Anyone else gets `null`.
  - **`src/modules/reels/media/reel-media.service.ts`**: depends only on `StorageService`, and never writes to MongoDB.
    - `publish(media)` copies both keys from `S3_PRIVATE_BUCKET` to `S3_PUBLIC_BUCKET`.
    - `unpublish(media)` deletes the public copies.
    - `deleteAll(media)` deletes both buckets' copies.
    - Each method is idempotent.
  - **Tests**: add specs for both services.
- [X] T036 Create `src/modules/reels/presentation/reel-presenter.service.ts` per R22.
  - **`present(items, viewer)`**: fills `videoUrl` and `thumbnailUrl` through `MediaUrlService`, once per page.
  - **Refactor**: remove URL building from `hydrate()` in `src/modules/reels/reels-db.repository.ts`, which now returns `media` and `productLinks` untouched. Route every `ReelsService` method that returns reels or pages through the presenter.
  - **Tests**: add `reel-presenter.service.spec.ts`.
- [X] T037 Create `src/modules/reels/lifecycle/reel-lifecycle.service.ts`, the single place for status and standing side effects (data-model.md "Reel status", R12, R22).
  - **Dependencies**: `ReelsDbRepository`, `ReelMediaService`, and `StandingService`. `HashtagStatsService` is added in US6.
  - **`syncMediaVisibility(reel)`**:
    - Compute `public = status === 'published' && !StandingService.isExcluded(creatorId)`.
    - Call `publish` or `unpublish` only when `media.location` differs.
    - Record the result with `ReelsDbRepository.setMediaLocation(id, location)`.
  - **Hooks**: `onPublished`, `onUnpublished` (hide or reject from published), and `onRestored` call `syncMediaVisibility`. `onDeleted(snapshot)` calls `deleteAll`.
  - **Refactor** so the repository returns outcomes:
    - `reportReel` returns `'reported'|'duplicate'|'hidden'` and receives the threshold as a parameter from `LimitsService`.
    - `adminModerateReel` returns the updated reel or `null`.
    - `deleteReelCascade` returns `{ creatorId, status, media, hashtagsNormalized }`.
    - `ReelsService` and `reels-moderation.service.ts` call the lifecycle hooks after the guarded update succeeds.
  - **Rule**: `reels-db.repository.ts` imports no service.
  - **Tests**: add `reel-lifecycle.service.spec.ts`, covering a published reel whose creator is excluded staying private.
- [X] T038 Rewrite `src/modules/reels/reels-seed.service.ts` as a development-only seeder.
  - **Gating**: register it only when `SEED_DEMO_CONTENT=true`, and throw at boot if `NODE_ENV=production` (FR-071).
  - **Accounts**: provision `reels_accounts` for `SEED_SELLER_EXTERNAL_IDS` and `SEED_CUSTOMER_EXTERNAL_IDS` through `ChinaPartsAccountsRepository` and `AccountsService.resolveOrProvision`, skipping ids China Parts doesn't have.
  - **Content**: upload `assets/seed/sample-10s.mp4` through `StorageService` into the private bucket. Create 12 published reels for the first seeded seller with Arabic and English hashtags, then call `ReelLifecycleService.syncMediaVisibility` on each.
- [X] T039 Port the Ciro unit specs so they pass: `src/modules/reels/reels.service.spec.ts`, `reels-moderation.service.spec.ts`, `reels-notifications.service.spec.ts`, `reels-redirect.controller.spec.ts`, and `moderation/stub.provider.spec.ts`. Swap the mocks to `ReelsAccount`, `PUSH_SENDER`, `ReelLifecycleService`, `ReelPresenter`, and `media`, and assert sentinels instead of messages. `npm test` must be green.
- [X] T040 Create the end-to-end harness in `test/utils/`.
  - **`test/utils/app.ts`**: `createTestApp(env?)` boots the full `AppModule` against `test/utils/containers.ts`, an in-memory MongoDB replica set, the local storage driver, the `stub` moderation provider, and `WORKER_ROLE=all`, with optional env overrides.
  - **`test/utils/tokens.ts`**: `issueToken(type, externalId)` inserts a Sanctum row as root and returns `` `Bearer ${id}|${secret}` `` (quickstart.md §4).
  - **`test/utils/fixtures.ts`**:
    - `createPublishedReel(sellerExternalId, opts)` writes a reel and its media through `StorageService` and `ReelLifecycleService`, for tests that don't exercise upload.
    - `runSync()` runs one standing sync directly.
    - `drainQueue(name)` waits until a BullMQ queue is empty.
- [X] T041 [P] Port `Ciro:test/reels.e2e-spec.ts` to `test/e2e/reels-regression.e2e-spec.ts` using the new harness, with `issueToken` replacing the JWT login and `reels_accounts` replacing `User`. Every ported behavior must still pass. Skip assertions about features this spec drops, such as sending a reel to a chat, and explain why in a comment.
- [X] T042 [P] Write `test/e2e/auth.e2e-spec.ts` covering FR-003 to FR-007, FR-004a, and FR-005.
  - **Valid tokens**: customer and seller tokens work with no other sign-in.
  - **Rejected tokens**: an unknown token, an expired one, and an admin-type one each return `401 AUTH_INVALID_SESSION`.
  - **Revocation**: deleting the token row makes it fail once the cache TTL passes (the TTL is set to 2 s in the test).
  - **No header**: a request to a Signed-in route returns `401 AUTH_REQUIRED`.
  - **Outage**: with MySQL stopped and a fresh token, a Signed-in route returns `503 UPSTREAM_UNAVAILABLE`, not 401.
- [X] T043 [P] Write `test/e2e/guards.e2e-spec.ts` for R10.
  - **Default**: EP3 with no header returns `401 AUTH_REQUIRED`, proving the Signed-in default.
  - **Per-IP limit**: with `IP_RATE_LIMIT_PER_MINUTE=10`, signed-out requests that rotate `X-Installation-Id` still get `429 RATE_LIMITED` on the 11th.
  - **Per-account limit**: with `USER_RATE_LIMIT_PER_MINUTE=5`, the 6th signed-in request gets 429.
  - **Admin**: EP29 with no key, a wrong key, or a valid user token returns `401 ADMIN_KEY_INVALID`. With `ADMIN_API_KEY` empty, every key is refused.
  - **Health**: `/health/live` is never rate-limited and returns the envelope.

**Checkpoint**: The forked module runs on China Parts identities behind the global guard chain. The ported regression suite passes, and story work can begin.

---

## Phase 3: User Story 1 - Watch reels with an existing China Parts account (Priority: P1) 🎯 MVP

**Goal**: Signed-in and signed-out users watch a fast, endlessly looping feed of published reels from sellers in good standing.

**Independent Test**: Seed published reels. Then open the feed signed in as customer 1 and as seller 1, and again signed out. Check that:
- pages show no duplicates or gaps, and the feed loops
- liking while signed out asks for sign-in
- suspending seller 1 hides its reels for everyone else after one sync (spec US1)

### Tests for User Story 1 ⚠️

- [X] T044 [P] [US1] Write `test/e2e/feed.e2e-spec.ts`.
  - **Paging (FR-019)**: page through 30 reels with limit 10 while inserting 3 new reels between pages, and assert no duplicates or skips within the pass.
  - **Page size**: no `limit` returns 10, and `limit=100` returns 25 (clamped).
  - **Looping (FR-020)**: the pass ends, the loop continues, and `nextCursor` is never null.
  - **Cursor**: a tampered cursor returns `400 INVALID_CURSOR`.
  - **Visibility (FR-021)**: non-owners never see pending, rejected, or hidden reels. The owner does.
  - **Views (FR-024)**: a signed-in view counts once.
- [X] T045 [P] [US1] Write `test/e2e/guest.e2e-spec.ts` for SC-014 and FR-004.
  - **Allowed signed out**: EP1, EP9, EP18, EP20, EP27, and EP5 with `userId` all succeed. EP5 without `userId` returns `400 VALIDATION_FAILED`.
  - **Guest views**: EP16 with `X-Installation-Id` counts once per installation.
  - **Sign-in required**: EP13 (like), EP2, and EP6 return `401 AUTH_REQUIRED`.
  - **Invalid header**: an invalid `Authorization` on EP1 returns `401 AUTH_INVALID_SESSION`. With MySQL stopped, an uncached token on EP1 returns `503 UPSTREAM_UNAVAILABLE`.
  - **Rate limit**: exceeding `GUEST_RATE_LIMIT_PER_MINUTE` (set to 5) returns `429 RATE_LIMITED`.
- [X] T046 [P] [US1] Write `test/e2e/identity-collision.e2e-spec.ts` for SC-005. Using customer 1 and seller 1 (same number), check that:
  - `GET /api/users/me` returns two different ids and account types
  - a like by one never shows `viewerLiked` for the other
  - their Liked and Saved lists are disjoint
- [X] T047 [P] [US1] Write `test/e2e/standing.e2e-spec.ts` for FR-009, FR-010 detection, FR-014, and SC-007.
  - **Suspension**: set seller 1 to `suspended` through `rootQuery` and call `runSync()`.
    - Seller 1's reels disappear from EP1 and EP9 for customer 1, but stay visible to seller 1 with their status.
    - Seller 1's likes return `403 ACCOUNT_NOT_IN_GOOD_STANDING`.
  - **Reinstatement**: after reinstating and syncing again, the reels reappear.
  - **Display**: renaming the shop in MySQL changes `creator.name` after a sync.
  - **No `updated_at`**: changing customer 1's `status` to 0 while restoring the old `updated_at` is still picked up by the next sync (R7).
  - **Missing rows**: delete customer 3's row. After one sync, `missingSince` is set and standing is unchanged. After a second sync, standing is `deleted` and the account is excluded.
  - **Breaker**: with 12 extra provisioned customers whose rows are then deleted, two syncs mark nothing deleted and log an error.
  - **Upstream errors**: with MySQL stopped, `runSync()` fails, and no account gets `missingSince` or a standing change.

### Implementation for User Story 1

- [X] T048 [P] [US1] Implement `src/modules/reels/feed/feed-cursor.ts` per R9.
  - **API**: `encodeFeedCursor({ pass, createdAt, id, injected? })` and `decodeFeedCursor(cursor)`, plus `decodeListCursor(cursor)` for lists that end (pass 0, nothing injected). The header is base64url JSON; `injected` follows after a `.` as concatenated 12-byte ids in base64url, so each part is encoded once.
  - **Errors**: a malformed or unverifiable cursor throws `400 INVALID_CURSOR`.
  - **Tests**: add `feed-cursor.spec.ts`, including a 50-id `injected` list under 1 KB.
- [X] T049 [US1] Rewrite `listFeed` in `src/modules/reels/reels-db.repository.ts` per R9. The repository receives `excludedIds` and `limit` as parameters and calls no service.
  - **Paging**: remove the load-the-whole-catalog branch. The For You feed uses keyset paging (`(createdAt,_id) < cursor`, sorted `{createdAt:-1,_id:-1}`, limit+1) on `{status:'published', creatorId:{$nin: excluded}}`.
  - **Looping**: when a pass runs out, continue from the top with `pass+1`, skipping ids already on the page.
  - **Reposts**: seed only the first page of pass 0 with the 50 most recent followee reposts. Return their ids in the cursor's `injected` list, and apply `_id $nin injected` on every later page of pass 0. Drop the list from pass 1.
  - **Scoped feeds**: creator and hashtag feeds use keyset paging and end (`nextCursor:null`). The hashtag filter matches `hashtagsNormalized` with `normalizeForMatch(hashtag)`.
  - **Page size**: `ReelsService` passes `LimitsService.clampPageSize('feed', limit)`.
- [X] T050 [US1] Add guest views in `src/modules/reels/schemas/reel-guest-view.schema.ts`, `src/modules/reels/reels-db.repository.ts`, and `src/modules/reels/reels.service.ts`.
  - **Schema**: `src/modules/reels/schemas/reel-guest-view.schema.ts` (data-model.md "reel_guest_views"), registered in `reels.module.ts`.
  - **Repository**: add `recordGuestView(reelId, installationId)` to `reels-db.repository.ts`. It inserts if absent and increments `viewsCount` only on a real insert.
  - **Service**: update `recordView` in `src/modules/reels/reels.service.ts`. Signed-in views use the ported per-account path, guest views with an `installationId` use the guest path, and guest views without one do nothing (FR-024). Update `reels.service.spec.ts`.
- [X] T051 [US1] In `src/modules/reels/reels.service.ts`, replace `getBlockSet(viewerId)` with `getExclusionSet(viewer?)`. It returns the viewer's mutual block set (none for guests) together with `StandingService.members()`.
  - **Coverage**: pass it to every read in `reels.service.ts`: feeds, `getReel`, comments, profiles, Liked, Saved, Reposted, reposters, and search.
  - **Single reels**: `getReel` returns `404 REEL_NOT_FOUND` to non-owners when the creator is excluded.
  - **Comments**: `getComments` drops comments whose `authorId` is excluded (FR-009).
  - **Tests**: update `reels.service.spec.ts`.
- [X] T052 [US1] Implement `src/modules/accounts/standing-sync.processor.ts` per R7, with the BullMQ queue `ACCOUNTS_SYNC` repeating every `ACCOUNT_SYNC_INTERVAL_MINUTES`, registered only for the worker role.
  - **Full re-read**: page through every account with `AccountsRepository.listByType` in batches of 1,000, and read them through `getCustomers` and `getSellers`. Update display fields, `preferredCurrency`, and standing.
  - **Missing rows**: the first miss sets `missingSince`. A miss on the next cycle marks the account `deleted`. A found row clears `missingSince`.
  - **Breaker**: if more than 10 accounts **and** more than `SYNC_MAX_MISSING_RATIO` of those checked are missing, change nothing for missing rows and log an error.
  - **Standing set**: rebuild `standing:excluded` with `StandingService.replaceAll` from every account whose `standing != 'good'`.
  - **Cache**: delete the `auth:acct:{type}:{externalId}` entry of every account in `changedStanding`, so its next request sees the new standing (R7).
  - **Upstream errors**: if any China Parts query fails, stop the run without marking anything missing or changing any standing, and let the next scheduled run start over (R7).
  - **Exports**: `runOnce(): Promise<{ changedStanding: string[]; newlyDeleted: string[] }>` for tests and for the hooks added in T060 and T101.
  - **Tests**: `standing-sync.processor.spec.ts`.
- [X] T053 [US1] Open the signed-out routes in `src/modules/reels/reels.controller.ts` and `src/modules/reels/reels-users.controller.ts`.
  - **Access**: set `@Access('optional')` and `@Viewer()` on EP1, EP5, EP9, EP16, EP18, EP20, and EP27.
  - **Services**: make the matching methods in `reels.service.ts` accept `viewer: { user?: AuthenticatedUser; installationId?: string }`.
    - For guests, every `viewer*` flag is false, there is no repost injection, and `repostersCount` is 0 with `topReposters` empty.
    - EP5's query DTO requires `userId` for guests, returning `400 VALIDATION_FAILED` otherwise.
  - **Tests**: update `reels.service.spec.ts`.
- [X] T054 [US1] Implement EP24, `GET /api/users/me`, in `src/modules/accounts/accounts.controller.ts`. It carries `@Access('signed-in')` and returns `{ id, accountType, username, name, avatarUrl, bio, locale, followersCount, followingCount, totalLikes }`. Register the controller in `accounts.module.ts`.

**Checkpoint**: The MVP works. China Parts users and signed-out visitors can watch reels.

---

## Phase 4: User Story 2 - Seller publishes a reel that passes automatic content review (Priority: P2)

**Goal**: Approved sellers upload reels of up to 60 seconds. Screening publishes or removes them, and media is public only while a reel is published and its creator is in good standing.

**Independent Test**: Seller 1 uploads `sample-10s.mp4`, the stub publishes it, and customer 1 sees it. A flagged upload never appears publicly. Customers, suspended sellers, and over-limit videos are refused. Suspending seller 1 makes the copied video URL stop working (spec US2, FR-009).

### Tests for User Story 2 ⚠️

- [X] T055 [P] [US2] Write `test/e2e/upload.e2e-spec.ts`.
  - **Happy path**: seller 1 uploads, gets status `pending_moderation`, and the object exists only in the private bucket. After the stub's clean verdict, the reel is `published`, the object exists in the public bucket with `Cache-Control: public, max-age=300`, and a mention notification event is recorded.
  - **Flagged**: a flagged upload (stub configured to flag) becomes `rejected`, has no public object, and the owner gets a `reelRejected` event.
  - **Refused**:
    - customer 1: `403 REELS_SELLERS_ONLY`
    - seller 2 (suspended): `403 ACCOUNT_NOT_IN_GOOD_STANDING`
    - `sample-70s.mp4`: `400 VIDEO_TOO_LONG`
    - a `text/plain` file: `400 UNSUPPORTED_MEDIA_TYPE`
    - `REEL_MAX_VIDEO_BYTES=1000`: `413 VIDEO_TOO_LARGE`
    - a description over `REEL_MAX_DESCRIPTION_LENGTH`: `400 VALIDATION_FAILED`
  - **Failed storage**: a storage `putFile` failure (spied) leaves no reel document and no objects (FR-033).
  - **Thumbnails**: an upload without a cover still gets a generated thumbnail.
  - **Delete**: an owner delete removes both buckets' objects. Another seller's delete returns `403 NOT_REEL_OWNER`.
  - **Media follows standing (FR-009)**:
    - Suspend seller 1, call `runSync()`, and `drainQueue(MEDIA_VISIBILITY)`. The public object is gone, and seller 1 still gets a presigned URL.
    - While suspended, seller 1 can still delete its own reel.
    - Reinstating restores the public object.
    - A reel that passes screening while its creator is suspended stays private.
  - **Upload limit**: with `UPLOAD_RATE_LIMIT_PER_HOUR=2`, the third upload returns `429 RATE_LIMITED`.

### Implementation for User Story 2

- [X] T056 [P] [US2] Provide `generateThumbnail` in `src/modules/reels/media/video.util.ts`, beside the other ffmpeg helpers (it is part of that file, not a separate `thumbnail.util.ts`): `generateThumbnail(videoPath): Promise<string>` runs the `@ffmpeg-installer/ffmpeg` binary with `-ss 1 -frames:v 1 -q:v 3` to a temporary JPEG. Its specs are in `video.util.spec.ts`, which uses `test/fixtures/media/sample-10s.mp4`.
- [X] T057 [US2] Move upload handling out of the controller into `src/modules/reels/media/reel-upload.service.ts`.
  - **Steps**:
    - Pre-generate the reel ObjectId.
    - Keep the ported duration check, allowing at most `REEL_MAX_DURATION_SECONDS` plus 1 second of measurement tolerance (FR-026), and the fast-start remux.
    - Generate a thumbnail if none was uploaded.
    - `putFile` both into `S3_PRIVATE_BUCKET` under `reels/{reelId}/video.mp4` and `reels/{reelId}/thumb.jpg`.
    - Only then create the reel document with `media.location='private'`.
  - **Failure**: on any failure, delete the temporary files and any objects already uploaded (FR-033).
  - **Limits**: read the size and duration limits from `LimitsService`. In `src/modules/reels/dto/create-reel.dto.ts`, validate `description` with `@MaxLengthFromConfig('REEL_MAX_DESCRIPTION_LENGTH')`.
  - **Controller**: in `src/modules/reels/reels.controller.ts`, EP8 uses Multer disk storage in `os.tmpdir()/reels-uploads` with `REEL_MAX_VIDEO_BYTES`. It is `@Access('seller')` and `@RateLimitClass('upload')`, and it delegates to the service.
  - **Tests**: add `src/modules/reels/media/reel-upload.service.spec.ts`. Cover a successful upload, a storage failure after the video is stored (the video object is deleted and no document exists), a duration failure, and a missing cover.
- [X] T058 [US2] Update `src/modules/reels/reels-moderation.service.ts`.
  - **Download**: fetch the video with `StorageService.downloadToTemp` from the private bucket, call the provider, and always delete the temporary file.
  - **Verdict**: a clean verdict runs the guarded publish and then `ReelLifecycleService.onPublished`, which makes media public only if the creator is in good standing. A flagged verdict records the rejection.
  - **Retries**: keep the ported fail-closed retries and the pending sweep (FR-031) unchanged.
  - **Tests**: update `reels-moderation.service.spec.ts`.
- [X] T059 [US2] Wire owner delete (EP10) in `src/modules/reels/reels-db.repository.ts` and `src/modules/reels/reels.service.ts`.
  - **Repository**: `deleteReelCascade` in `src/modules/reels/reels-db.repository.ts` keeps the ported cascade, adds `reel_guest_views` and `reel_reports`, and returns the R22 snapshot.
  - **Service**: `ReelsService.deleteReel` checks ownership (`403 NOT_REEL_OWNER`), calls the repository, then calls `ReelLifecycleService.onDeleted(snapshot)`. EP10 stays `@StandingExempt()`.
  - **Later additions**: product taps (T074) and comment reports (T085) join the cascade.
  - **Tests**: update `reels.service.spec.ts`.
- [X] T060 [US2] Implement `src/modules/reels/lifecycle/media-visibility.processor.ts` (queue `MEDIA_VISIBILITY`, worker role only).
  - **Job**: `{ accountId }` pages through that account's published reels with a new `ReelsDbRepository.listPublishedByCreator(creatorId, cursor, limit)`, and calls `ReelLifecycleService.syncMediaVisibility` on each.
  - **Hook**: extend `src/modules/accounts/standing-sync.processor.ts` to enqueue one job per id in `changedStanding`, with job id `media:{accountId}:{cycleStartedAt}`.
  - **Tests**: add `media-visibility.processor.spec.ts`.

**Checkpoint**: Sellers can publish, screening controls visibility, and media follows standing.

---

## Phase 5: User Story 3 - Like, comment, save, and share reels (Priority: P3)

**Goal**: Engagement works as in Ciro. Comment authors and reel owners can delete comments, following the standing rule.

**Independent Test**: Customer 1 likes, comments on, saves, and copies the link of seller 1's reel, and sees the counts change. Seller 1 deletes customer 1's comment, and seller 3 can't. A suspended author can still delete their own comment (spec US3, FR-008).

### Tests for User Story 3 ⚠️

- [X] T061 [P] [US3] Write `test/e2e/engagement.e2e-spec.ts`.
  - **Likes**: toggling a like changes `likesCount` by ±1, and re-liking creates no second `reelLike` event.
  - **Comments**: comments come back newest first and page by cursor with no duplicates across pages. `limit=100` returns 50. Empty, whitespace-only, and over-`REEL_COMMENT_MAX_LENGTH` comments get `400 VALIDATION_FAILED`.
  - **Saves and shares**: saves are invisible to others, and EP15 increments `sharesCount`.
  - **Lists**: the Liked and Saved lists exclude hidden reels.
  - **Comment deletion**:
    - Deleting a comment as its author and as the reel owner both decrement `commentsCount` exactly once, including under 5 concurrent DELETEs.
    - Seller 3 gets `403 COMMENT_NOT_DELETABLE`.
    - Deleting an already deleted comment returns `404 COMMENT_NOT_FOUND`.
  - **Standing (FR-008)**:
    - After customer 1 is set to `status=0` and `runSync()` runs, customer 1 can still delete its own comment but gets 403 when commenting.
    - While seller 1 is suspended (after `runSync()`), deleting customer 2's comment on its own reel returns `403 ACCOUNT_NOT_IN_GOOD_STANDING`.
  - **Flags**: `viewerCanDelete` and `viewerCanReport` are correct for the author, the reel owner, another user, and a guest.
  - **Write limit**: with `WRITE_RATE_LIMIT_PER_MINUTE=3`, the fourth comment gets `429 RATE_LIMITED`.

### Implementation for User Story 3

- [X] T062 [US3] Update `src/modules/reels/schemas/reel-comment.schema.ts` per data-model.md "reel_comments": add `deletedAt` (default null) and `deletedByRole`, replace the page index with `{videoId:1, deletedAt:1, createdAt:-1, _id:-1}`, and add `{authorId:1}`.
- [X] T063 [US3] Implement `src/modules/reels/comments/comments.repository.ts` (extending `BaseRepository<ReelCommentDocument>`) and `src/modules/reels/comments/comments.service.ts`.
  - **`deleteComment(reelId, commentId, actor)`**: `actor` is either `{ user }` or `{ operator: true }`. A missing or deleted comment is `404 COMMENT_NOT_FOUND`. For a user:
    - the comment's author deletes with role `author`, whatever the author's standing
    - the reel's creator deletes with role `reel_owner`, and needs `standing === 'good'`, otherwise `403 ACCOUNT_NOT_IN_GOOD_STANDING`
    - anyone else gets `403 COMMENT_NOT_DELETABLE`
  - **Exactly once**: the repository soft-deletes with `findOneAndUpdate({_id, videoId, deletedAt:null}, {deletedAt, deletedByRole})`. Only when that matched does it run `$inc commentsCount:-1` on the reel.
  - **Tests**: `comments.service.spec.ts`.
- [X] T064 [US3] Wire comments in `src/modules/reels/reels.controller.ts` and `reels-db.repository.ts`.
  - **EP22**: `DELETE /api/reels/:id/comments/:commentId` carries `@Access('signed-in')` and `@StandingExempt()`, delegating to `CommentsService`.
  - **EP21**: add `@RateLimitClass('write')`. In `dto/create-comment.dto.ts`, `text` uses `@MaxLengthFromConfig('REEL_COMMENT_MAX_LENGTH')` after trimming.
  - **EP20 reads**: keyset paging on `(createdAt, _id)` through `feed-cursor.ts` with `pass` fixed at 0. Filter `deletedAt:null`, drop excluded or blocked authors, and clamp the page with `LimitsService.clampPageSize('comments', limit)`.
  - **Response shape**: add `viewerCanDelete` and `viewerCanReport` to `CommentDto` in `src/modules/reels/reels.repository.ts` (contracts/rest-api.md "CommentDto").
- [X] T065 [US3] Convert `listLiked` and `listSaved` in `src/modules/reels/reels-db.repository.ts` from offset paging to keyset paging on the relation's `(createdAt, _id)`, reusing `feed-cursor.ts` with `pass` fixed at 0.

**Checkpoint**: Engagement and comment deletion work.

---

## Phase 6: User Story 4 - Go from a reel to the product being shown (Priority: P4)

**Goal**: Sellers attach up to 5 of their own active products. Viewers see live product cards in their preferred currency and tap through.

**Independent Test**: Seller 1 attaches products 101 and 102. Check that:
- the cards show the current price and availability in SAR, and in USD for customer 2
- deactivating 101 removes its card
- taps are counted (spec US4)

### Tests for User Story 4 ⚠️

- [X] T066 [P] [US4] Write `test/e2e/products.e2e-spec.ts`.
  - **Attaching**: attaching 101 and 102 works.
  - **Refused**:
    - products 103, 104, and 201: `400 PRODUCT_NOT_ATTACHABLE` listing the ids
    - six products: `400 TOO_MANY_PRODUCTS`
    - customer 1 on EP11: `403 REELS_SELLERS_ONLY`
    - seller 3 (pending) on EP11: `403 ACCOUNT_NOT_IN_GOOD_STANDING`
    - EP11 on another seller's reel: `403 NOT_REEL_OWNER`
  - **Cards in SAR**: signed out and for customer 1, 101's card shows `price "45.00"`, `discountPercentage "10.00"`, `finalPrice "40.50"`, and `currency "SAR"`. 102 shows `available:false`.
  - **Cards in USD (FR-036)**: for customer 2, 101's card shows `price "12.00"`, `finalPrice "10.80"`, and `currency "USD"`. These values follow the provisional R11 rule, so update them if China Parts confirms a different one. With `FX_CACHE_SECONDS=1`, deleting the USD row makes customer 2's cards fall back to SAR.
  - **Outage**: with only 101's card cached and MySQL stopped, EP9 returns 200 with only 101's card, and EP11 returns `503 UPSTREAM_UNAVAILABLE`.
  - **Live updates**: with the card cache TTL at 1 s, changing the price in MySQL updates the card. Setting `status=0` on 101 removes its card, and the reel stays published.
  - **Taps**:
    - EP12 works signed out and signed in, increments `tapsCount`, and writes a `reel_product_taps` row.
    - An unlinked product returns `404 PRODUCT_LINK_NOT_FOUND`.
    - Seller 2 (suspended) gets `403 ACCOUNT_NOT_IN_GOOD_STANDING`.

### Implementation for User Story 4

- [X] T067 [P] [US4] Implement `src/modules/china-parts/products.repository.ts`: `findAttachable(sellerExternalId, ids)` and `getCardRows(ids)`. Use exactly the "Attachable products" and "Product cards" queries in contracts/chinaparts-read-model.md, plus the first image per product from `media` (`CHINAPARTS_PRODUCT_TYPES`, `CHINAPARTS_PRODUCT_IMAGE_COLLECTION`, lowest `order_column`). Add `products.repository.spec.ts`.
- [X] T068 [P] [US4] Implement `src/modules/china-parts/exchange-rates.repository.ts`: `getRates(): Promise<Map<string, string>>` runs the "Exchange rates" query in contracts/chinaparts-read-model.md with the validated, backtick-quoted identifiers from `china-parts.config.ts`. Add `exchange-rates.repository.spec.ts`, asserting the quoting and that no `SELECT *` is issued.
- [X] T069 [US4] Add `productLinks: [{ productId: number, position: number, tapsCount: number }]` to `src/modules/reels/schemas/reel.schema.ts`, with validators for at most 5 entries and a unique `productId` (data-model.md "reels").
- [X] T070 [US4] Implement `src/modules/reels/products/product-links.service.ts` per R11.
  - **`validateAttachable(sellerExternalId, productIds)`**: rejects more than `REEL_MAX_PRODUCTS` with `TOO_MANY_PRODUCTS`, and any non-attachable id with `PRODUCT_NOT_ATTACHABLE`.
  - **`setLinks(reelId, ownerId, productIds)`**: owner only (`403 NOT_REEL_OWNER`).
  - **`getCards(productIds, sellerExternalIds)`**: uses the Redis `product:card:{id}` cache in the base currency, with TTL `PRODUCT_CARD_CACHE_SECONDS`. It leaves out inactive, deleted, or other-seller products. Prices are decimal strings. When China Parts is unreachable, it returns only the cached cards and logs a warning, while `validateAttachable` still throws `503 UPSTREAM_UNAVAILABLE` (R11).
  - **Tests**: `product-links.service.spec.ts`.
- [X] T071 [US4] Implement `src/modules/reels/products/price-conversion.service.ts` per R11.
  - **`convert(cards, viewerCurrency | null)`**: reads rates through `ExchangeRatesRepository`, cached in Redis `fx:rates` for `FX_CACHE_SECONDS`, and applies `CHINAPARTS_FX_RATE_DIRECTION`.
  - **Order of operations**: convert the base price, apply the discount, then round half-up to 2 decimals. Use scaled integer arithmetic (`BigInt` at 10^6), never floating point. `discountPercentage` is not converted.
  - **Fallback**: a missing rate, a null currency, or `UPSTREAM_UNAVAILABLE` returns base-currency cards and logs a warning.
  - **Provisional rule**: the order and rounding stay provisional until the China Parts checklist confirms them (R11). T108 blocks launch on that item.
  - **Tests**: `price-conversion.service.spec.ts` covering both directions, rounding at the half, the missing-rate fallback, and an upstream failure.
- [X] T072 [US4] Accept products on upload and add the edit endpoint in `src/modules/reels/reels.controller.ts`.
  - **Upload**: add optional `productIds` to `src/modules/reels/dto/create-reel.dto.ts`, accepting a JSON array or a comma-separated string transformed to `number[]`. Validate it before any storage write in `reel-upload.service.ts`, and update `reel-upload.service.spec.ts`.
  - **Edit endpoint**: create `src/modules/reels/dto/set-products.dto.ts` (`productIds: number[]`, 0 to 5) and add EP11, `PUT /api/reels/:id/products`, which is `@Access('seller')`.
- [X] T073 [US4] Extend `src/modules/reels/presentation/reel-presenter.service.ts`.
  - **Collect**: gather every reel's `productLinks` on the page.
  - **Never fail the read**: if cards can't be built, the page still returns, with whatever cards `getCards` had cached (R11).
  - **Build**: call `ProductLinksService.getCards` once and `PriceConversionService.convert` once, with `viewer.user?.preferredCurrency ?? null`.
  - **Attach**: add `products: ProductCardDto[]` ordered by `position`, and add `ProductCardDto` to `src/modules/reels/reels.repository.ts` (contracts/rest-api.md).
  - **Tests**: update `reel-presenter.service.spec.ts`.
- [X] T074 [US4] Add the tap schema `src/modules/reels/schemas/reel-product-tap.schema.ts` and its endpoint in `src/modules/reels/reels.controller.ts`.
  - **Schema**: `src/modules/reels/schemas/reel-product-tap.schema.ts` (data-model.md "reel_product_taps", with a 365-day TTL index), registered in the module.
  - **Endpoint**: EP12, `POST /api/reels/:id/products/:productId/tap`, is `@Access('optional')`. It returns `404 PRODUCT_LINK_NOT_FOUND` unless `productId` is in the reel's `productLinks`. A new repository method inserts the tap and runs `$inc productLinks.$.tapsCount`.
  - **Cascade**: add `reel_product_taps` to `deleteReelCascade`.

**Checkpoint**: Reels link to products, priced in the viewer's currency.

---

## Phase 7: User Story 5 - Visit profiles, follow creators, and block accounts (Priority: P5)

**Goal**: Profiles show shop identities and reels, following drives the Following feed, blocking hides content both ways, and owners can edit their handle and bio.

**Independent Test**: Check that:
- customer 1 opens seller 1's profile and sees the Arabic shop name and reels
- following seller 1 fills the Following tab
- blocking seller 1 hides its reels and comments for both sides
- `PATCH /me` with a variant-spelled taken handle returns 409 (spec US5)

### Tests for User Story 5 ⚠️

- [X] T075 [P] [US5] Write `test/e2e/profiles.e2e-spec.ts`.
  - **Seller profile**: EP27 for seller 1 shows `name` = the shop name, `accountType:'seller'`, and published reels newest first. Seller 1 viewing its own profile also sees non-published reels with their status.
  - **Customer profile**: has `videos:[]`.
  - **Follow**:
    - Following updates both counts and creates one `newFollower` event, even after unfollowing and following again.
    - Following yourself gets `400 CANNOT_FOLLOW_SELF`. Following an unknown id gets `404 ACCOUNT_NOT_FOUND`.
  - **Following feed**: EP2 shows only originals from followed accounts.
  - **Blocking**: hides reels and comments both ways, and unblocking restores them.
  - **Profile editing**:
    - `PATCH /api/users/me` with `{username:'احمد'}` returns `409 USERNAME_TAKEN` when `أحمد` exists.
    - A 151-character bio gets `400 VALIDATION_FAILED`.
    - A suspended seller's `PATCH` gets `403 ACCOUNT_NOT_IN_GOOD_STANDING`.

### Implementation for User Story 5

- [X] T076 [US5] Create `src/modules/accounts/dto/update-me.dto.ts` (`username?` matching the R6 pattern, `bio?` up to 150 characters). Add EP25, `PATCH /api/users/me`, to `src/modules/accounts/accounts.controller.ts`. It carries `@Access('signed-in')`, standing applies through the global guard, and it calls `AccountsService.updateMe`.
- [X] T077 [US5] Update `getProfile` in `src/modules/reels/reels-db.repository.ts` and `CreatorProfileDto` in `src/modules/reels/reels.repository.ts`.
  - **Changes**: add `user.accountType`, return `videos:[]` for customer accounts, and give non-owners `404 ACCOUNT_NOT_FOUND` when the profile's account is excluded.
  - **Unchanged**: the ported owner and non-owner status rules stay.
- [X] T078 [US5] Convert `getFollowingFeed` and `getFollowingUsers` (EP2, EP7) in `src/modules/reels/reels-db.repository.ts` to keyset paging, reusing `feed-cursor.ts`. The Following feed filters `creatorId $in followees`, capped at 5,000, and `$nin` the exclusion set.

**Checkpoint**: The social graph works on China Parts identities.

---

## Phase 8: User Story 6 - Search reels and accounts in Arabic and English (Priority: P6)

**Goal**: Hashtag and account search match across Arabic spelling variants, diacritics, and digit styles.

**Independent Test**: A search for `اطار` finds `#إطارات`, a search for `2018` finds `#كامري_٢٠١٨`, and a search for `احمد` finds an account named `أحمد` (spec US6, SC-009).

### Tests for User Story 6 ⚠️

- [X] T079 [P] [US6] Write `test/e2e/search.e2e-spec.ts`.
  - **Reel matches**: `اطار` finds `#إطارات`. `2018` finds `#كامري_٢٠١٨`. `oilfilter` finds `#OilFilter`. `فلتر` finds `#فلتر_زيت`.
  - **Refused and excluded**: a whitespace-only `q` gets `400 VALIDATION_FAILED`. Unpublished reels and reels from blocked or suspended accounts are excluded.
  - **Hashtag feed**: EP1 `?hashtag=اطارات` returns reels tagged `#إطارات` and `#اطارات`, each showing its hashtags as typed.
  - **Account search**: EP26 finds `أحمد` by `احمد` and a shop by part of its Arabic name. An exact handle match ranks first. Paging by cursor returns no duplicates and stops at 200 results.

### Implementation for User Story 6

- [X] T080 [US6] Implement the hashtag dictionary in `src/modules/reels/hashtags/`.
  - **Schema**: `src/modules/reels/hashtags/hashtag-stats.schema.ts` (data-model.md "hashtag_stats").
  - **Repository**: `hashtag-stats.repository.ts`, extending `BaseRepository`.
  - **Service**: `hashtag-stats.service.ts`.
    - `increment(tags: {normalized, display}[])` upserts with `$inc +1`.
    - `decrement(normalizedTags)` runs `$inc -1` and deletes rows that reach 0 or below.
    - `findMatching(normalizedQuery, limit=200)` runs an escaped substring regex on `tag`.
  - **Tests**: `hashtag-stats.service.spec.ts`.
- [X] T081 [US6] Wire `HashtagStatsService` into `src/modules/reels/lifecycle/reel-lifecycle.service.ts`.
  - **Increment**: `onPublished` and `onRestored` increment the reel's tags.
  - **Decrement**: `onUnpublished` and `onDeleted` decrement them, the latter only when the snapshot's status was `published`.
  - **Standing**: standing changes never touch the counts.
  - **Tests**: update `reel-lifecycle.service.spec.ts`.
- [X] T082 [US6] Rewrite `searchReels` (EP6) in `src/modules/reels/reels-db.repository.ts`. `ReelsService` normalizes `q` and gets the matching tags from `HashtagStatsService.findMatching`. It then passes them to the repository, which queries `{status:'published', hashtagsNormalized:{$in: tags}, creatorId:{$nin: excluded}}` with keyset paging. Update `reels.service.spec.ts`.
- [X] T083 [US6] Rewrite `searchUsers` (EP26) in `src/modules/reels/reels-db.repository.ts` per R9.
  - **Match**: the normalized query as an escaped substring of `usernameNormalized` or `nameNormalized`.
  - **Exclude**: excluded and blocked accounts, and the `deleted` standing.
  - **Rank**: exact match first, then `followersCount` descending, capped at 200.
  - **Cursor**: page through the ranked list with an opaque offset cursor in a new `src/modules/reels/feed/offset-cursor.ts`. Invalid values are `400 INVALID_CURSOR`. Add `offset-cursor.spec.ts`.

**Checkpoint**: Arabic-aware search works.

---

## Phase 9: User Story 7 - Report reels and comments and have operators review them (Priority: P7)

**Goal**: Reel and comment reporting with a shared daily limit, auto-hide, and operator queues for hidden reels and reported comments.

**Independent Test**: With the threshold at 3, three accounts report a reel and it hides. An operator restores it, and it is never auto-hidden again. A comment report appears in the comment queue, and removing or dismissing it behaves as specified (spec US7).

### Tests for User Story 7 ⚠️

- [X] T084 [P] [US7] Write `test/e2e/moderation.e2e-spec.ts`.
  - **Reel reports**:
    - `other` without text, or with text over `REEL_REPORT_REASON_MAX_LENGTH`, gets `400 VALIDATION_FAILED`.
    - A duplicate report is a quiet success.
    - The limit is shared: with `REEL_REPORT_DAILY_LIMIT=3`, the fourth report of either kind gets `429 REPORT_DAILY_LIMIT`.
  - **Auto-hide**: reaching the threshold hides the reel, removes its public object, and shows it to the owner as hidden. After a restore through EP30, the public object returns, and more reports never hide it again. Restoring while the creator is suspended keeps the media private.
  - **Access**: EP29 and EP31 refuse a user session with `401 ADMIN_KEY_INVALID` and accept `x-admin-key`.
  - **Comment reports**:
    - A report on EP23 lists the comment in EP31.
    - EP32 `remove` soft-deletes it and decrements the count. EP32 `dismiss` keeps it and drops it from the list.
    - A new reporter re-adds it.
    - Reporting your own comment gets `400 CANNOT_REPORT_OWN_COMMENT`.
  - **Retention (R16)**: when the owner deletes a reported reel, its reel reports and comment reports are deleted too.

### Implementation for User Story 7

- [X] T085 [US7] Create `src/modules/reels/schemas/reel-comment-report.schema.ts` (data-model.md "reel_comment_reports") and `src/modules/reels/comments/comment-reports.repository.ts`, extending `BaseRepository`.
  - **Repository methods**: `countRecent(reporterId, since)`, `listOpenGrouped(cursor, limit)` with keyset paging on `lastReportedAt`, and `dismissOpen(commentId)`.
  - **Wiring**: register the schema. Add `deleteByReel(reelId)` and call it from `ReelsService.deleteReel` after the cascade, so comment reports go with their reel (R16).
- [X] T086 [US7] Implement `src/modules/reels/comments/comment-reports.service.ts` per R16 and R22.
  - **`report(reelId, commentId, user, dto)`**:
    - The reel must be published and visible (`404 REEL_NOT_FOUND`), and the comment must exist and not be deleted (`404 COMMENT_NOT_FOUND`).
    - It must not be the user's own comment (`400 CANNOT_REPORT_OWN_COMMENT`). A duplicate is a quiet no-op.
    - Before writing, enforce the shared limit. If `ReelsDbRepository.countRecentReelReports` plus `CommentReportsRepository.countRecent` over the last 24 hours reaches `REEL_REPORT_DAILY_LIMIT`, return `429 REPORT_DAILY_LIMIT`.
  - **`listQueue(cursor, limit)`**: open reports grouped by comment, excluding deleted comments, sorted by `lastReportedAt` descending.
  - **`remove(commentId)`**: calls `CommentsService.deleteComment` with `{ operator: true }`.
  - **`dismiss(commentId)`**: sets `dismissedAt` on the open reports.
  - **Tests**: `comment-reports.service.spec.ts`.
- [X] T087 [US7] Move the reel-report limit into the service layer in `src/modules/reels/reels.service.ts`.
  - **Repository**: add `countRecentReelReports(reporterId, since)` to `reels-db.repository.ts`, and remove the limit check from its `reportReel`.
  - **Service**: `ReelsService.reportReel` enforces the same shared limit as T086, then calls the repository with the threshold. On a `hidden` outcome, it calls `ReelLifecycleService.onUnpublished`.
  - **Admin restore**: confirm that `adminModerateReel` restore and reject run `onRestored` and `onUnpublished`.
  - **Request**: `dto/report-reel.dto.ts` validates `customReason` with `@MaxLengthFromConfig('REEL_REPORT_REASON_MAX_LENGTH')`. EP19 gets `@RateLimitClass('write')`.
  - **Tests**: update `reels.service.spec.ts`.
- [X] T088 [US7] Add the comment-report routes and DTOs in `src/modules/reels/reels.controller.ts` and `src/modules/reels/reels-admin.controller.ts`.
  - **EP23**: `POST /api/reels/:id/comments/:commentId/report` in `src/modules/reels/reels.controller.ts`, with `@Access('signed-in')` and `@RateLimitClass('write')`, reusing `dto/report-reel.dto.ts`.
  - **EP31 and EP32**: `GET /api/reels/moderation/comments` and `PATCH /api/reels/comments/:commentId/moderation` in `src/modules/reels/reels-admin.controller.ts`, which carries `@Access('admin')`. Add `dto/admin-comment-moderation.dto.ts` (`action: 'remove'|'dismiss'`), and declare the static routes before the `:id` routes.

**Checkpoint**: Community moderation is complete.

---

## Phase 10: User Story 8 - Repost reels to followers (Priority: P8)

**Goal**: Reposts reach followers' For You feeds once per pass, with public Reposts lists, reposter lists, and a viewer-relative badge.

**Independent Test**: Customer 1 follows customer 2. Customer 2 reposts seller 1's reel. Customer 1's first For You page shows it with `repostedBy`, and it doesn't reappear later in the same pass (spec US8).

### Tests for User Story 8 ⚠️

- [X] T089 [P] [US8] Write `test/e2e/reposts.e2e-spec.ts`.
  - **Basics**: a repost appears in the follower's first For You page, and removing it takes it away. Two followed reposters still show the reel once.
  - **Once per pass (FR-017, FR-019)**: with 15 reels and limit 5, a seeded repost of an older reel never reappears on pages 2 and 3 of pass 0. It appears exactly once in pass 1.
  - **Badge (FR-060)**: customer 1 follows customer 2 only. Customer 2 and seller 3 both repost the same reel. Customer 1 sees `repostersCount` 1 and one `topReposters` entry. A guest sees 0 and `[]`.
  - **Exclusions**: reposters exclude blocked accounts, and a suspended reposter's reposts aren't injected.
  - **Signed out**: a guest's EP5 needs `userId`, and guests never get repost injection.

### Implementation for User Story 8

- [X] T090 [US8] Convert `getReposted` (EP5) and `getReposters` (EP18) in `src/modules/reels/reels-db.repository.ts` to keyset paging on the repost's `(createdAt, _id)`, reusing `feed-cursor.ts`.
- [X] T091 [US8] Update `getRepostAttributions` in `src/modules/reels/reels-db.repository.ts`.
  - **Exclusions**: drop reposters and creators in the exclusion set.
  - **Cap**: scan only the 50 most recent followee reposts (R9).
  - **Count**: keep the ported viewer-relative count (followees plus the viewer).
  - **Docs**: document the semantics at the `repostersCount` field in `src/modules/reels/reels.repository.ts` (contracts/rest-api.md "ReelDto").

**Checkpoint**: Reposts work.

---

## Phase 11: User Story 9 - Receive notifications on devices already registered with China Parts (Priority: P9)

**Goal**: Real push delivery to China Parts-registered devices of the exact account and app, in the recipient's language, with payloads limited to FR-073a fields.

**Independent Test**: With a fake sender, a customer liking seller 1's reel targets only seller 1's seller-app tokens. Customer 1's tokens are never targeted despite the shared number, and the payload has only the allowed fields (spec US9).

### Tests for User Story 9 ⚠️

- [X] T092 [P] [US9] Write `test/e2e/notifications.e2e-spec.ts`. Override `FIREBASE_MESSAGING`, the thin Firebase gateway under `FCM_SENDER_CLIENT`, with a capturing fake, so the real queue, worker, device lookup, language and dead-token logic all run.
  - **Targeting**: a like on seller 1's reel targets only seller 1's `seller`-app token.
  - **No notification**: a self-like sends nothing, and unfollowing then following again sends nothing.
  - **Language**: with `Accept-Language: en` on the recipient's last request, the text is English. Otherwise it is Arabic.
  - **Payload (FR-073a)**: every captured message has only `notification.title`, `notification.body`, and `data.{source,type,actorId?,reelId?}`, plus a 24-hour expiry on both platforms.
  - **Dead tokens**: a token reported as unregistered is skipped on the next send.
  - **Failures**: a sender that throws never fails the like (FR-066).

### Implementation for User Story 9

- [X] T093 [P] [US9] Implement `src/modules/china-parts/devices.repository.ts`: `getTokens(accountType, externalId)` runs the "Device tokens" query in contracts/chinaparts-read-model.md, with the type set for the account type and `app` = `customer` or `seller`. Add `devices.repository.spec.ts`.
- [X] T094 [P] [US9] Create `src/modules/push/templates/ar.ts` and `src/modules/push/templates/en.ts`, each exporting `render(type, {actorName})` for `newFollower`, `reelLike`, `reelMention`, and `reelRejected` and returning `{title, body}`. Create `src/modules/push/templates/index.ts`, which picks a template by locale and defaults to `ar`.
- [X] T095 [P] [US9] Implement `src/modules/push/push-payload.builder.ts` per R14, the only place a push message is composed.
  - **`build(job, recipientLocale, actorName?)`**: returns `{ notification: {title, body}, data: {source:'reels', type, actorId?, reelId?}, android: { ttl: 86400000 }, apns: { headers: { 'apns-expiration': <now + 24 h> } } }`.
  - **Tests**: `push-payload.builder.spec.ts` asserts the exact key set for every type and fails on any extra field (SC-015).
- [X] T096 [US9] Implement `src/modules/push/fcm-push.client.ts` (token `FCM_SENDER_CLIENT`) over `src/modules/push/firebase-messaging.ts` (token `FIREBASE_MESSAGING`, the only file that imports `firebase-admin`).
  - **Apps**: create one `firebase-admin` app per non-empty `FCM_CUSTOMER_CREDENTIALS_JSON` and `FCM_SELLER_CREDENTIALS_JSON`. With empty credentials, it logs a warning and sends nothing.
  - **`sendMulticast(app, tokens, message)`**: accepts only a `PushPayloadBuilder` result and skips tokens in `push:dead:{sha256}`. It uses `sendEachForMulticast`, and marks `messaging/registration-token-not-registered` and `invalid-registration-token` as dead for 30 days.
  - **Tests**: `fcm-push.client.spec.ts`.
- [X] T097 [US9] Implement real delivery in `src/modules/push/push.processor.ts` and `src/modules/push/queued-push.sender.ts`.
  - **Queue**: `src/modules/push/push.processor.ts` uses the BullMQ queue `REELS_PUSH` (worker role only). `src/modules/push/queued-push.sender.ts` implements `PUSH_SENDER` by enqueueing a `PushJob` with 3 attempts and exponential backoff.
  - **Job handling**: load the recipient and actor `reels_accounts`, get the devices through `DevicesRepository`, build the message with `PushPayloadBuilder` using the recipient's `locale`, and send it.
  - **Wiring**: replace the no-op sender in `src/modules/push/push.module.ts`.
  - **Tests**: `push.processor.spec.ts`.
- [X] T098 [US9] Implement `src/modules/accounts/locale.interceptor.ts` and register it as `APP_INTERCEPTOR` in `src/modules/accounts/accounts.module.ts`. For signed-in requests, it reads `Accept-Language` and maps it to `ar` or `en`. It calls `AccountsService.recordLocale` only when the value differs from the `locale` in the caller's `auth:acct:` cache entry, which it then updates. Add `locale.interceptor.spec.ts`.

**Checkpoint**: Notifications reach China Parts devices.

---

## Phase 12: User Story 10 - Share a reel link that opens the China Parts customer app (Priority: P10)

**Goal**: Reel links open the customer app, with a safe store fallback page.

**Independent Test**: The `.well-known` files return correct JSON, and an iPhone user agent gets the App Store link. A script-injection id gets 404 (spec US10).

### Tests for User Story 10 ⚠️

- [X] T099 [P] [US10] Write `test/e2e/links.e2e-spec.ts`.
  - **App link files**: `/.well-known/apple-app-site-association` returns `application/json` with the configured app ID and `/reels/*`, without the envelope. `/.well-known/assetlinks.json` returns the package and fingerprints.
  - **Store page**: `/reels/<validId>` with an iPhone user agent contains `IOS_STORE_URL`, with an Android user agent contains `ANDROID_STORE_URL`, and with a desktop user agent contains both (FR-069).
  - **Link previews**: the page has `<link rel="canonical">` and `og:url` equal to `LINKS_PUBLIC_BASE_URL/reels/<validId>`.
  - **Injection**: `/reels/%3Cscript%3E` returns 404, and the body never contains `<script>`.
  - **Deleted reels**: EP9 for a deleted reel returns `404 REEL_NOT_FOUND`.

### Implementation for User Story 10

- [X] T100 [US10] Replace `src/modules/reels/reels-redirect.controller.ts` (and its spec) with `src/modules/reels/links/links.controller.ts` and `links.controller.spec.ts`. All three routes are `@Access('public')` and use `@Res()` to bypass the envelope. They stay under the per-IP limit.
  - **Store page**: `GET /reels/:id` returns 404 unless `Types.ObjectId.isValid(id)`. It HTML-escapes every interpolated value, and the store URLs and title text come from config (customer app listings). iPhones get the App Store link, Android phones get Google Play, and every other user agent gets both (FR-069). The page carries `<link rel="canonical">` and `og:url` built from `LINKS_PUBLIC_BASE_URL`, plus a fixed `og:title` from config (R15).
  - **App link files**: `GET /.well-known/apple-app-site-association` and `GET /.well-known/assetlinks.json` are built from `IOS_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE_NAME`, and `ANDROID_CERT_FINGERPRINTS` (contracts/client-integration.md). They return 404 when unconfigured.

**Checkpoint**: Every user story is complete.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: Account cleanup, launch proofs, operations, and the final gates.

- [ ] T101 Implement `src/modules/reels/lifecycle/account-cleanup.processor.ts` (queue `ACCOUNTS_CLEANUP`, worker role) for FR-010. It lives in the reels module because it deletes reels data, and the reels module already imports the accounts module (plan.md, "Structure Decision"). Extend `src/modules/accounts/standing-sync.processor.ts` to enqueue one cleanup job per id in `newlyDeleted`, by queue name only, without importing the reels module.
  - **Cleanup steps**:
    - delete the account's reels through `ReelsService.deleteReel`'s path, which runs the cascade and `ReelLifecycleService.onDeleted`, so the reels' reports go too (R16)
    - soft-delete the account's comments with role `system`, decrementing counts
    - remove its likes, saves, views, follows, reposts, reel reports, and comment reports, correcting `likesCount`, `totalLikes`, `followersCount`, and `followingCount`
    - `$pull` its id from other accounts' `blockedUsers`, and remove `notification_events` where it is the recipient or actor
    - set `viewerId` to null on its product taps
    - delete the account document
  - **Tests**: add `account-cleanup.processor.spec.ts` and `test/e2e/account-cleanup.e2e-spec.ts`. The e2e test deletes customer 2 in MySQL, runs `runSync()` twice and drains the job, and asserts that nothing remains and the counters are correct.
- [ ] T102 [P] Write `test/e2e/read-only.e2e-spec.ts` for SC-006.
  - **Checksums**: run `CHECKSUM TABLE` over every table in `chinaparts_dev` as `reels_audit` before and after a full scripted flow (sign in, upload, like, comment, report, follow, sync, cleanup), and assert equality.
  - **Grants**: as `reels_ro`, `INSERT INTO customers ...` and `SELECT email FROM customers` both fail with access denied.
- [ ] T103 [P] Write `test/e2e/access-matrix.e2e-spec.ts`.
  - **Matrix**: encode every row of the contracts/rest-api.md endpoint tables (EP1 to EP32) with its access level. For each endpoint, assert the right outcome signed out, with a customer token, with a seller token, with a suspended seller token, and with the admin key.
  - **Standing exemptions**: EP10, EP16, and author-EP22 succeed for the suspended seller.
  - **Explicit levels**: using `DiscoveryService`, assert that every registered route carries an explicit `@Access()`, so nothing relies on the default.
  - This covers constitution V's security review.
- [ ] T104 [P] Create `.github/workflows/deploy.yml` and `.github/workflows/diagnostics.yml`, mirroring Ciro's pattern (memory: deployment pipeline).
  - **`deploy.yml`**: deploys over SSH on push to `main`, running `git fetch origin main && git reset --hard origin/main` and then `docker compose up -d --build api worker`.
  - **`diagnostics.yml`**: a manual `workflow_dispatch` that prints `docker compose ps`, `/health/ready`, and the env variable names only. It never prints container logs, which would copy reels data to GitHub outside the Kingdom (R17).
- [ ] T105 [P] Create `scripts/backup-mongo.sh`, which runs `mongodump --archive --gzip`, uploads to the private bucket under `backups/`, and prunes backups older than 14 days. Create `docs/operations.md` covering:
  - in-Kingdom hosting (R17) and the rule that no logs or error reports leave the Kingdom
  - the residency audit steps for SC-015, including the push payload check
  - the backup schedule, `WORKER_ROLE` scaling, and reading logs over SSH
- [ ] T106 [P] Add latency measurement for SC-004 and SC-010 in `src/modules/reels/reels-moderation.service.ts`, `src/modules/push/push.processor.ts`, and `scripts/metrics/latency-report.sh`.
  - **Logs**: `src/modules/reels/reels-moderation.service.ts` logs a structured `publishLatencyMs` (upload to publish), and `src/modules/push/push.processor.ts` logs `deliveryLatencyMs` (event to send). Both go to in-Kingdom logs only.
  - **Report**: create `scripts/metrics/latency-report.sh`, which computes p95 for each from the logs over SSH, and document it in `docs/operations.md`.
- [ ] T107 [P] Create the load test `scripts/load/feed.k6.js`. 500 virtual users run EP1 paging with mixed signed-in and guest traffic over 5 minutes, with the threshold `http_req_duration{p(95)}<1000` (SC-003). A second scenario runs EP26 account search with the threshold `p(95)<300` (R9). Document how to run it in `docs/operations.md`.
- [ ] T108 [P] Create `docs/launch-gates.md` with sign-off owners for each item:
  - the Sightengine immediate-deletion setting, data processing addendum, and written no-retention confirmation (R13, FR-073)
  - every item of the China Parts verification checklist in contracts/chinaparts-read-model.md, including exchange rates and preferred currency
  - the residency audit, including the push payload audit (SC-015)
  - the load test results (SC-003, R9)
  - the SC-002 first-frame measurement on test devices over a typical 4G profile
  - the SC-004 and SC-010 latency reports (T106)
  - an SC-008 audit of every response and push type for email, phone, national ID, address, and payment data
  - the SC-011 device matrix: iPhone and Android, with the customer app, both apps, and neither, plus a desktop browser
- [ ] T109 Run the final gates: `npm run build`, `npm run lint` (zero `any` and zero suppressed rules), `npm test`, and `npm run test:e2e`. Walk through every row of quickstart.md §5 against `docker-compose.local.yml`, and record any deviations in `docs/launch-gates.md`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies. T001 and T002 come first.
- **Foundational (Phase 2)**: depends on Setup, and blocks every story. Within it:
  - T009 and T010 come first, then T011 to T015 in parallel.
  - T016 comes next, then T017 and T018 in parallel, then T019 to T024 in order (T021 and T023 may run in parallel).
  - T025 needs T013 and T024. T026 and T027 run in parallel with T025. T028 registers all four guards, then T029.
  - T030 to T038 are sequential because they edit the same reels files. T036 needs T035, and T037 needs T035 and T023.
  - T039 to T043 come last.
- **User stories (Phases 3 to 12)**: each depends on Foundational, with these exceptions:
  - US2's media-visibility hook (T060) extends T052's sync from US1.
  - US2 (T057) and US4 (T072) both edit `reel-upload.service.ts`, so do US2 first when one developer owns both.
  - US4's presenter work (T073) extends T036. Its tests rely on standing exclusion from US1.
  - US7's comment reports (T086) need `CommentsService` from US3 (T063).
  - US5 (T078), US3 (T064, T065), and US8 (T090) reuse `feed-cursor.ts` from US1 (T048).
  - US6 (T081) extends the lifecycle service from T037.
- **Polish (Phase 13)**: after the desired stories. T101 needs T052, T059, and T063. T102 and T103 need every story they exercise.

### User story dependencies

| Story | Depends on |
|-------|------------|
| US1 (P1) | Foundational only (MVP) |
| US2 (P2) | Foundational. T060 extends US1's sync (T052) |
| US3 (P3) | Foundational plus T048 |
| US4 (P4) | Foundational. Its upload integration follows US2 |
| US5 (P5) | Foundational plus T048 |
| US6 (P6) | Foundational |
| US7 (P7) | Foundational plus T063 |
| US8 (P8) | Foundational plus T048 and T049 |
| US9 (P9) | Foundational. It replaces the no-op sender from T033 |
| US10 (P10) | Foundational |

### Within each story

The end-to-end test comes first and must fail. Then schemas, repositories, and services with their unit specs, then controllers, then wiring.

## Parallel Opportunities

- **Setup**: T003 to T008 together, after T001 and T002.
- **Foundational**: T011, T012, T013, T014, and T015 together. Then T017 and T018, then T021 and T023, then T026 and T027 beside T025. Finally T041, T042, and T043 together.
- **Stories**: after Foundational, US1, US6, US9, and US10 can proceed in parallel across developers, and US2 and US3 can start once T048 and T052 land. Every story's end-to-end test task is marked [P].
- **Polish**: T102 to T108 together.

### Parallel example: Foundational guards

```bash
# After T024:
Task: "T025 src/common/guards/viewer-auth.guard.ts + access.decorator.ts"
Task: "T026 src/common/guards/{ip,identity}-throttler.guard.ts"
Task: "T027 src/common/guards/good-standing.guard.ts"
# Then T028 registers them in src/app.module.ts in order.
```

### Parallel example: User Story 1

```bash
# Tests first, all in parallel:
Task: "T044 test/e2e/feed.e2e-spec.ts"
Task: "T045 test/e2e/guest.e2e-spec.ts"
Task: "T046 test/e2e/identity-collision.e2e-spec.ts"
Task: "T047 test/e2e/standing.e2e-spec.ts"
# Then, in parallel with each other:
Task: "T048 src/modules/reels/feed/feed-cursor.ts"
Task: "T052 src/modules/accounts/standing-sync.processor.ts"
```

### Parallel example: User Story 4

```bash
Task: "T066 test/e2e/products.e2e-spec.ts"
Task: "T067 src/modules/china-parts/products.repository.ts"
Task: "T068 src/modules/china-parts/exchange-rates.repository.ts"
```

### Parallel example: User Story 9

```bash
Task: "T092 test/e2e/notifications.e2e-spec.ts"
Task: "T093 src/modules/china-parts/devices.repository.ts"
Task: "T094 src/modules/push/templates/{ar,en}.ts"
Task: "T095 src/modules/push/push-payload.builder.ts"
```

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 Setup, then Phase 2 Foundational. The ported regression suite (T041), the auth suite (T042), and the guards suite (T043) must be green.
2. Phase 3 (US1): the feed for signed-in and signed-out viewers, with the full-read standing sync.
3. **Stop and validate**: T044 to T047 are green, and the quickstart.md §5 rows for US1, FR-009 (API visibility), and Health are checked by hand.
4. Deploy to staging in Saudi Arabia with seeded demo content (`SEED_DEMO_CONTENT=true` on staging only, using `assets/seed/` in the image).

### Incremental delivery

US2 (publishing) makes the service useful with real content, and US4 (product links) is the main business value. Then US3, US5, US6, US7, US8, US9, and US10. Each story's checkpoint is a deployable increment. Production launch requires Phase 13, including every item in `docs/launch-gates.md`.

### Parallel team strategy

After Foundational:

| Developer | Stories |
|-----------|---------|
| A | US1, then US5 and US8, since they share the cursor and feed work |
| B | US2, then US4, since they share the upload path and presenter |
| C | US3, then US7, since they share comments |
| D | US6, US9, US10 |

## Notes

- **[P]** means a different file with no incomplete dependency. **[USn]** maps a task to a spec user story.
- **Ciro**: never edit Ciro's repository as part of these tasks. The Ciro spec changes (comment management, Arabic search) are separate Ciro work.
- **Commits**: commit after each task or logical group. Stop at any checkpoint to validate the story on its own.

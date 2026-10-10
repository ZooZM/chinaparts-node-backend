# Quickstart: China Parts Reels Service

**Feature**: `002-chinaparts-reels-service`

This walkthrough takes you from an empty repository to a local stack where every user story can be checked by hand. It also lists the automated checks that gate a release.

## 1. Create the repository from the fork

```bash
# New repository (working name)
mkdir chinaparts-node-backend && cd chinaparts-node-backend && git init

# Copy the reels module and the shared pieces from Ciro at the recorded commit (research R1)
CIRO=/path/to/chat-app-backend
git -C "$CIRO" archive 51f8db5 \
  src/modules/reels \
  src/common/filters src/common/interceptors src/common/repositories src/common/throttler \
  | tar -x
echo "Reels module forked from chat-app-backend@51f8db5" >> README.md

# specs/ and .specify/ are gitignored in Ciro, so copy them from the working tree instead of git
mkdir -p specs .specify/memory
cp -R "$CIRO/specs/002-chinaparts-reels-service" specs/
cp "$CIRO/.specify/memory/constitution.md" .specify/memory/   # then apply the R21 amendment
```

Scaffold the rest with the NestJS CLI using the same versions as Ciro, then follow `tasks.md`. The first tasks remove the `User`, `JwtAuthGuard`, and `NotificationsModule` imports that the fork brings along (research R18).

## 2. Local stack

`docker-compose.local.yml` runs the following:

| Service | Image | Notes |
|---------|-------|-------|
| `mongo` | `mongo:7` | Single-node replica set (`--replSet rs0`) |
| `redis` | `redis:7` | |
| `mysql` | `mysql:8.0` | Loads `test/fixtures/chinaparts-schema.sql`, `chinaparts-seed.sql`, and `grants.sql` |
| `minio` | `minio/minio` | Buckets `reels-private` and `reels-public`, with `reels-public` set to anonymous read |
| `api` | built locally | `WORKER_ROLE=api` |
| `worker` | built locally | `WORKER_ROLE=worker` |

The seed fixture must include:
- customers 1 to 3 and sellers 1 to 3, sharing the same numbers (the SC-005 collision case)
- seller 2 `suspended`, seller 3 `pending`, and customer 3 inactive
- a shop named in Arabic only for seller 1
- active, inactive, and soft-deleted products for seller 1
- one product owned by seller 2
- `device_tokens` rows for both apps
- customer 2 with `preferred_currency = 'USD'`, and every other account with an empty preferred currency
- a stand-in `currencies` table with `SAR` at 1.000000 and `USD` at 0.266667 (see the read-model appendix)

## 3. Environment

Every optional variable in the Joi schema must use `.optional().allow('')`. A present-but-empty value otherwise fails validation and crash-loops the container. This was Ciro deploy gotcha 2.

```dotenv
NODE_ENV=development
PORT=3000
CORS_ORIGINS=                       # comma-separated web origins; empty means none (the apps don't need CORS)
WORKER_ROLE=all                     # api | worker | all
MONGODB_URI=mongodb://localhost:27017/reels?replicaSet=rs0
REDIS_URL=redis://localhost:6379

CHINAPARTS_MYSQL_HOST=localhost
CHINAPARTS_MYSQL_PORT=3306
CHINAPARTS_MYSQL_DATABASE=chinaparts_dev
CHINAPARTS_MYSQL_USER=reels_ro
CHINAPARTS_MYSQL_PASSWORD=reels_ro_local
CHINAPARTS_MYSQL_SSL=false
# Value mappings: see contracts/chinaparts-read-model.md (defaults are fine locally)

STORAGE_DRIVER=s3                   # s3 | local
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minio
S3_SECRET_ACCESS_KEY=minio123
S3_PRIVATE_BUCKET=reels-private
S3_PUBLIC_BUCKET=reels-public
MEDIA_PUBLIC_BASE_URL=http://localhost:9000/reels-public

MODERATION_PROVIDER=stub            # stub | sightengine
SIGHTENGINE_API_USER=
SIGHTENGINE_API_SECRET=
FCM_CUSTOMER_CREDENTIALS_JSON=      # empty = push disabled (logged), never a boot failure
FCM_SELLER_CREDENTIALS_JSON=
ADMIN_API_KEY=local-admin-key

# Limits (FR-070, research R24)
REEL_MAX_VIDEO_BYTES=104857600
REEL_MAX_DURATION_SECONDS=60
REEL_MAX_DESCRIPTION_LENGTH=2200
REEL_COMMENT_MAX_LENGTH=500
REEL_REPORT_REASON_MAX_LENGTH=500
FEED_PAGE_SIZE_DEFAULT=10
FEED_PAGE_SIZE_MAX=25
COMMENTS_PAGE_SIZE_DEFAULT=20
COMMENTS_PAGE_SIZE_MAX=50
REEL_MAX_PRODUCTS=5
REEL_REPORT_DAILY_LIMIT=20
REEL_REPORT_AUTOHIDE_THRESHOLD=25

# Rate limits (research R10)
IP_RATE_LIMIT_PER_MINUTE=1200
USER_RATE_LIMIT_PER_MINUTE=300
GUEST_RATE_LIMIT_PER_MINUTE=120
UPLOAD_RATE_LIMIT_PER_HOUR=20
WRITE_RATE_LIMIT_PER_MINUTE=30

# Sync and caches (research R4, R7, R11)
AUTH_CACHE_TTL_SECONDS=60           # at most 300 (FR-005)
ACCOUNT_SYNC_INTERVAL_MINUTES=5     # at most 10 (FR-009, FR-014)
SYNC_MAX_MISSING_RATIO=0.01         # mass-miss breaker
PRODUCT_CARD_CACHE_SECONDS=60
FX_CACHE_SECONDS=300
CHINAPARTS_FX_TABLE=currencies
CHINAPARTS_FX_CODE_COLUMN=code
CHINAPARTS_FX_RATE_COLUMN=exchange_rate
CHINAPARTS_FX_RATE_DIRECTION=per_base

LINKS_PUBLIC_BASE_URL=http://localhost:3000
IOS_TEAM_ID=
IOS_BUNDLE_ID=
ANDROID_PACKAGE_NAME=
ANDROID_CERT_FINGERPRINTS=
IOS_STORE_URL=https://apps.apple.com/app/id0000000000
ANDROID_STORE_URL=https://play.google.com/store/apps/details?id=placeholder
SEED_DEMO_CONTENT=false             # refused when NODE_ENV=production (FR-071)
```

## 4. Local sign-in tokens

There is no China Parts app locally, so insert Sanctum-format tokens directly into the local MySQL as root. Never do this anywhere but a local or test database.

```sql
-- Token "1|seller-secret" for seller 1, "2|customer-secret" for customer 1, "5|customer2-secret" for customer 2 (USD)
INSERT INTO personal_access_tokens (id, tokenable_type, tokenable_id, name, token, abilities, created_at)
VALUES
 (1, 'App\\Models\\Seller',   1, 'local', SHA2('seller-secret', 256),    '["*"]', NOW()),
 (2, 'App\\Models\\Customer', 1, 'local', SHA2('customer-secret', 256),  '["*"]', NOW()),
 (3, 'App\\Models\\Seller',   2, 'local', SHA2('suspended-secret', 256), '["*"]', NOW()),
 (4, 'App\\Models\\Admin',    1, 'local', SHA2('admin-secret', 256),     '["*"]', NOW()),
 (5, 'App\\Models\\Customer', 2, 'local', SHA2('customer2-secret', 256), '["*"]', NOW());
```

```bash
SELLER='Authorization: Bearer 1|seller-secret'
CUSTOMER='Authorization: Bearer 2|customer-secret'
CUSTOMER2='Authorization: Bearer 5|customer2-secret'
INSTALL="X-Installation-Id: $(uuidgen | tr A-Z a-z)"
API=http://localhost:3000/api
```

## 5. Manual verification by user story

| Story | Check | Expected |
|-------|-------|----------|
| US1 | `curl -H "$INSTALL" $API/reels` | 200, published reels, `viewerLiked: false` |
| US1 | `curl -H 'Authorization: Bearer 9|nope' $API/reels` | 401 `AUTH_INVALID_SESSION` (FR-004a) |
| US1 | `curl -H 'Authorization: Bearer 4|admin-secret' $API/reels` | 401 `AUTH_INVALID_SESSION` (FR-007) |
| US1 | `GET /api/users/me` with `$SELLER`, then with `$CUSTOMER` | Two different accounts, `accountType` seller and customer (SC-005) |
| US2 | `curl -H "$SELLER" -F video=@clip.mp4 -F 'description=فلتر #فلتر_زيت' -F 'productIds=[101]' $API/reels` | 200 `pending_moderation`. After the stub verdict, status is `published` and the video is in `reels-public` |
| US2 | The same upload with `$CUSTOMER` | 403 `REELS_SELLERS_ONLY` |
| US2 | The same upload with `Bearer 3|suspended-secret` | 403 `ACCOUNT_NOT_IN_GOOD_STANDING` |
| US3 | Like, comment, then `DELETE …/comments/:id` with `$CUSTOMER` | The count goes up, then drops by one |
| US4 | `GET /api/reels/:id` | `products[0].finalPrice` matches the fixture. Deactivating product 101 in MySQL removes the card within 60 seconds |
| US4 | `GET /api/reels/:id` signed out, then with `$CUSTOMER2` | `currency: "SAR"` signed out. `currency: "USD"` for customer 2, with `price` 12.00 and `finalPrice` 10.80 (FR-036) |
| US5 | `POST /api/users/:sellerAccountId/follow` with `$CUSTOMER`, then `GET /api/reels/following` | The seller's reel appears |
| US6 | `GET /api/reels/search?q=اطار` with `$CUSTOMER`, for a reel tagged `#إطارات` | Found (FR-049a) |
| US7 | `POST …/comments/:id/report`, then `GET /api/reels/moderation/comments` with `x-admin-key: local-admin-key` | The comment is listed. `dismiss` takes it off the list |
| US7 | Lower `REEL_REPORT_AUTOHIDE_THRESHOLD` to 3 and report from three accounts | The reel is hidden and its public object is removed |
| US8 | Repost with a second customer that the first customer follows | The first customer's For You page 1 shows it with `repostedBy` |
| US9 | With FCM credentials set, a customer likes a reel | Only seller 1's seller-app devices are targeted |
| US10 | `curl localhost:3000/.well-known/assetlinks.json` and `curl -A iPhone localhost:3000/reels/<id>` | Valid JSON, and an HTML page with the App Store link. `curl localhost:3000/reels/%3Cscript%3E` returns 404, never echoed. A desktop user agent gets both store links |
| FR-009 | Copy a published reel's `videoUrl`. Set seller 1 to `suspended` in MySQL and wait for one sync cycle | Seller 1's reels vanish for others and remain visible to seller 1. The copied `videoUrl` no longer downloads. Reinstating seller 1 brings both back |
| FR-008 | While seller 1 is suspended, `DELETE /api/reels/:id` on one of its reels, then `POST /api/reels/:id/like` with `$SELLER` | The delete succeeds. The like gets 403 `ACCOUNT_NOT_IN_GOOD_STANDING` |
| Health | `curl localhost:3000/health/ready`, then stop MySQL and repeat | 200 envelope with each dependency's status, then 503 `NOT_READY` naming MySQL. With MySQL stopped, `curl -H "$CUSTOMER" $API/reels` returns 503 `UPSTREAM_UNAVAILABLE`, not 401 |

## 6. Automated gates

```bash
npm run build && npm run lint && npm test && npm run test:e2e
```

`test:e2e` starts MySQL and Redis with Testcontainers. It must include:

- **Identity collision suite (SC-005)**: every endpoint exercised with customer N and seller N.
- **Read-only proof (SC-006)**: `CHECKSUM TABLE` over every China Parts table before and after the full suite, run as `reels_audit`. The suite also checks that an `INSERT` as `reels_ro` fails.
- **Arabic matching table (SC-009)**: `normalizeForMatch` cases for alef, yaa, and taa marbuta variants, diacritics, the stretching character, and both digit styles.
- **Guest suite (SC-014)**: every Optional route signed out, and every Signed-in route signed out returning `AUTH_REQUIRED`.

Before production:
- a load test of `GET /api/reels` at 500 concurrent viewers, which must meet SC-003
- a residency audit, including a check that every push type carries only the FR-073a fields (SC-015)
- the Sightengine deletion-policy confirmation (research R13)
- every item on the China Parts verification checklist in [contracts/chinaparts-read-model.md](contracts/chinaparts-read-model.md)

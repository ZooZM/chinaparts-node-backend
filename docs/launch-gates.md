# Launch gates

Nothing in this list can be proven from the code alone. Each item needs a named owner, evidence, and
a date. The service **does not go to production** until every row is signed.

Fill in **Owner** when the work is assigned, and **Evidence** with a link or a file name, never the
data itself. Status is `open`, `done` or `waived` (a waiver needs the reason and who agreed).

| # | Gate | Source | Owner | Status | Evidence | Date |
|---|------|--------|-------|--------|----------|------|
| G1 | Screening provider: immediate deletion on, data processing addendum signed, written no-retention confirmation | R13, FR-073, SC-015 | _to assign_ | open | | |
| G2 | China Parts verification checklist, every item (G2a to G2i below) | [chinaparts-read-model.md](../specs/002-chinaparts-reels-service/contracts/chinaparts-read-model.md) | China Parts team | open | | |
| G3 | Residency audit, including the push payload audit | SC-015, [operations.md](operations.md#residency-audit-sc-015) | _to assign_ | open | | |
| G4 | Load test: p95 under 1000 ms at 500 viewers; search p95 under 300 ms | SC-003, R9 | _to assign_ | open | | |
| G5 | First frame within 2 s for 95% of sessions, on test devices over a typical 4G profile | SC-002 | _to assign_ | open | | |
| G6 | Latency reports: upload to published p95 under 120 s; notification to sent p95 under 30 s | SC-004, SC-010 | _to assign_ | open | | |
| G7 | Data audit of every response and every push type for email, phone, national ID, address and payment data | SC-008 | _to assign_ | open | | |
| G8 | Device matrix for reel links | SC-011 | _to assign_ | open | | |
| G9 | Backup restored into a scratch database and checked | [operations.md](operations.md#backups) | _to assign_ | open | | |
| G10 | Server secrets and the production `.env` reviewed: strong admin key, read-only MySQL user with column-level grants only | constitution, R1 | _to assign_ | open | | |

## G1. Screening provider (Sightengine)

All three, in writing, before any real upload is screened:

- [ ] The account is set to **delete submissions immediately** after the verdict.
- [ ] The **data processing addendum** is signed.
- [ ] Sightengine has **confirmed in writing** that it keeps no copy of a submitted video or
      description.

Until then the provider stays on the stub (`stub.provider.ts`) and uploads are not screened by a real
service. Do not enable real screening on production data without this.

## G2. China Parts verification checklist

Copied from the contract; each answer goes in `.env` or into the read-model contract, and where one
differs from the default the matching test fixture is updated.

- [ ] **G2a** The actual `tokenable_type` and `media.model_type` strings for customers, sellers, shops, products and admins (`CHINAPARTS_*_TYPES`)
- [ ] **G2b** Whether `sanctum.expiration` and `sanctum.token_prefix` are configured (`CHINAPARTS_TOKEN_EXPIRATION_MINUTES`)
- [ ] **G2c** The actual `sellers.status` values for approved, pending, rejected and suspended (`CHINAPARTS_SELLER_APPROVED_VALUES`)
- [ ] **G2d** The media collection names, disks and public URL layout for product, shop and seller images, and the `customers.image` format (`CHINAPARTS_*_IMAGE_COLLECTION`, `CHINAPARTS_MEDIA_URL_TEMPLATE`, `CHINAPARTS_DISK_URLS`)
- [ ] **G2e** Whether storefront prices apply anything beyond `products.discount_percentage`, such as offers or big sales, so cards match product pages
- [ ] **G2f** The table and columns holding **exchange rates**, the direction of a rate, and how and when China Parts rounds converted prices (FR-036). **The service's conversion order and rounding are provisional until this is answered** (R11): confirm a converted card price equals the product page's price for a sample of products in each currency, and fix `price-conversion.service.ts` if not.
- [ ] **G2g** The values `customers.preferred_currency` and `sellers.preferred_currency` hold, and what an empty value means
- [ ] **G2h** The `device_tokens.app` values, and whether the customer and seller apps share one Firebase project
- [ ] **G2i** Whether a read replica is available, and the network path from the reels hosting in Saudi Arabia to it

## G3. Residency audit

Follow [operations.md, "Residency audit (SC-015)"](operations.md#residency-audit-sc-015) and attach
the five findings: storage locations, outbound allow-list, no foreign monitoring, the screening
provider's confirmation (G1), and the push payload proof.

## G4. Load test

Run [`scripts/load/feed.k6.js`](../scripts/load/feed.k6.js) as described in
[operations.md](operations.md#load-test-sc-003-r9) on a staging stack with production-sized data.
Attach the k6 summary. Both thresholds must show as passed.

## G5. First frame (SC-002)

On at least one mid-range Android phone and one iPhone, with the network throttled to a typical 4G
profile, open Reels 20 times from cold and record the time to the first frame of the first reel.
95% (19 of 20 or better) must be within 2 seconds. Record the devices, the profile and the numbers.

## G6. Latency (SC-004, SC-010)

After a week of staging use with realistic traffic, run
[`scripts/metrics/latency-report.sh`](../scripts/metrics/latency-report.sh) and attach the table.
SC-004 p95 under 120 000 ms. SC-010 p95 under 30 000 ms. Repeat in the first week of production.

## G7. Data audit (SC-008)

For every response shape (reel, comment, account card, followed user, product card, hashtag,
notification-related answers, errors) and the four push types, read a real staging response and
confirm there is no email, phone number, national ID, address or payment detail. The automated
checks pin the shapes; this is the human pass that looks for what the tests did not think of.

## G8. Device matrix for reel links (SC-011)

A shared reel link must open the right reel in the customer app, or lead to its store listing.
Cover all of these, on iPhone and on Android, and a desktop browser:

| Device state | Expected |
|--------------|----------|
| Customer app installed | Opens the reel in the customer app |
| Both customer and seller apps installed | Opens the reel in the **customer** app |
| Seller app only | Store listing of the customer app |
| Neither | Store listing of the customer app |
| Desktop browser | A page offering both store links |

## Final gates (T109), run 2026-10-10

| Gate | Result |
|------|--------|
| `npm run build` | Passes |
| `npm run lint` (`--max-warnings=0`, zero `any`, zero suppressed rules) | Passes |
| `npx tsc --noEmit` | Passes |
| `npm test` | 60 suites, 940 tests pass |
| `npm run test:e2e` | 20 suites, 548 tests pass |

### What differs from the plan

These are the places where what was run is not what [quickstart.md](../specs/002-chinaparts-reels-service/quickstart.md)
describes. None changes a requirement, but each one is a thing to prove on staging before launch.

1. **The Docker stack was never started.** There was no Docker daemon in the environment that built
   this. `Dockerfile`, `docker-compose.yml` and `docker-compose.local.yml` are written but have
   **not been built or run**, and the GitHub workflows have never executed. First deploy to staging is
   the first time they are exercised: expect to fix small things there (a missing package in the image,
   a healthcheck, a path).
2. **Quickstart §5 was not walked by hand with `curl` against `docker-compose.local.yml`.** Every row
   is covered by an automated end-to-end test instead, which drives the real app over HTTP against a
   real MySQL 8.4, Redis and MongoDB (replica set, with transactions), started as plain processes
   rather than containers. The rows and the tests that cover them:

   | Quickstart row | Covered by |
   |----------------|-----------|
   | US1: guest feed, bad token 401, admin key 401, customer 1 vs seller 1 | `auth`, `guest`, `identity-collision` |
   | US2: upload, `pending_moderation` to `published`, sellers only, suspended | `upload`, `moderation`, `standing` |
   | US3: like, comment, delete comment | `engagement`, `reels-regression` |
   | US4: product cards, deactivated product, currency per viewer | `products` |
   | US5: follow and Following feed | `profiles`, `feed` |
   | US6: Arabic-aware search | `search` |
   | US7: comment reports, auto-hide threshold, admin review | `moderation` |
   | US8: reposts in For You | `reposts` |
   | US9: push to the right device only | `notifications` |
   | US10: `assetlinks.json`, store page, unsafe id 404 | `links` |
   | FR-009 and FR-008: suspension hides and restores, owner may still delete | `standing` |
   | Health | `guards` (200), `health.controller.spec.ts` (503 `NOT_READY`) |

3. **Real object storage was not exercised.** The end-to-end suite uses the local-disk storage driver.
   The S3 driver has unit tests with a stand-in client (`s3.driver.spec.ts`) but has never talked to
   MinIO or the Saudi bucket. Check on staging: an upload ends up in the private bucket, publishing
   copies it to the public one, suspending removes the public copy, and the public URL plays.
4. **Real Firebase was not exercised.** Notifications are tested with a stand-in that records what
   would be sent. Check on staging with the real credentials for both apps (G3 point 5).
5. **The screening provider is the stub.** `MODERATION_PROVIDER=stub` everywhere until G1 is done.
6. **`/health/ready` returning 503 with MySQL stopped** is covered by the unit test only. Stopping the
   throwaway MySQL in the middle of the end-to-end suite would break every test after it, so this one is
   worth doing by hand on staging: stop the read replica's route and check the 503 and the 503
   `UPSTREAM_UNAVAILABLE` for a signed-in request.
7. **The standing sync is triggered directly in tests** instead of waiting for its schedule. The
   15-minute bound of SC-007 therefore rests on `ACCOUNT_SYNC_INTERVAL_MINUTES` (5 by default) plus the
   media job that follows it. Confirm on staging: suspend a seller in China Parts and time how long
   until the copied video link stops working, then reinstate and time the return.
8. **The price conversion rule is provisional** until G2f is answered.
9. **`<` in JSON text is stored as `&lt;`.** The input sanitiser (`xss-clean`) encodes `<` in JSON
   bodies and query strings, such as comments and report reasons, so a comment reading "price < 100" is
   stored escaped. Upload descriptions are multipart, so they are not touched by it and are escaped where
   they are rendered instead. This is the safe side of the trade-off; the product owner should decide
   whether it is acceptable.

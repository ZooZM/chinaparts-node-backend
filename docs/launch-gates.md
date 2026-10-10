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

## Deviations recorded at the final gates (T109)

The final run (`npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`) and the walk through
[quickstart.md §5](../specs/002-chinaparts-reels-service/quickstart.md) are recorded here, with
anything that differed from the expected result.

_To be filled in by the final-gates step._

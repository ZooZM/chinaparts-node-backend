# Contract: Client Integration

**Feature**: `002-chinaparts-reels-service`

This file covers what the China Parts customer and seller apps must do to use the service. Building the screens is a separate effort, but these rules are binding on both sides.

## Request headers

| Header | When | Rule |
|--------|------|------|
| `Authorization: Bearer <token>` | Signed in | The exact Sanctum token the app already sends to China Parts. Omit the header entirely when signed out. Never send an empty or stale header, because an invalid header gets 401 even on routes open to signed-out visitors |
| `X-Installation-Id` | Every request | A UUID v4 generated once per app install and stored locally. It is not tied to the account and is not reset at sign-out |
| `Accept-Language` | Every request | `ar` or `en`, matching the app's current language. It sets the language of that account's push notifications |

**Handling session and availability errors**:
- `401 AUTH_INVALID_SESSION`: the China Parts session is gone. Run the app's normal sign-out or refresh flow, then retry signed out or signed in.
- `401 AUTH_REQUIRED`: show the sign-in prompt (FR-004).
- `503 UPSTREAM_UNAVAILABLE`: China Parts can't be reached right now. Show "temporarily unavailable" and retry later. Never sign the user out for this.
- `429 RATE_LIMITED`: back off and retry later.
- `403 ACCOUNT_NOT_IN_GOOD_STANDING`: the account is suspended or not yet approved. Explain this instead of retrying. The account can still delete its own reels and its own comments (FR-008).

## Which app does what

| Capability | Customer app | Seller app |
|------------|--------------|------------|
| For You, Following, and hashtag feeds; search; profiles | Yes | Yes |
| Like, comment, save, share, repost, follow, block, report | Yes | Yes |
| Delete own comments; delete any comment on own reels | Own comments only | Yes |
| Upload, attach products, delete own reels, see Processing, Removed, and Under review states | No | Yes |
| Watch while signed out | Yes | No (the seller app needs sign-in) |
| Opens from reel links | Yes | No |

## Reel links

- **Link format**: `https://reels.<china-parts-domain>/reels/<reelId>`. Copy Link and every share target use this link (FR-067).
- **iOS**: the customer app adds `applinks:reels.<china-parts-domain>` to its Associated Domains. The service serves:

```json
{
  "applinks": {
    "details": [
      { "appIDs": ["<TEAM_ID>.<customer.bundle.id>"], "components": [{ "/": "/reels/*" }] }
    ]
  }
}
```

- **Android**: the customer app declares an `autoVerify` intent filter for `https://reels.<china-parts-domain>/reels/*`. The service serves:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "<customer.package.name>",
    "sha256_cert_fingerprints": ["<release-cert-sha256>", "<play-signing-cert-sha256>"]
  }
}]
```

- **Without the app**: the link serves a small page that redirects iOS users to the customer app on the App Store and Android users to Google Play. On any other device, such as a desktop browser, it shows both links (FR-069).
- **Opening a link in the app**: the app reads the reel id from the path, calls `GET /api/reels/<id>` signed in or signed out, and starts the feed at that reel. A 404 shows "no longer available".

## Product cards

- `products[]` on each reel is already filtered and ordered (FR-037).
- Tapping a card does two things. It calls `POST /api/reels/<id>/products/<productId>/tap` in the background and ignores the result, and then it opens the app's existing product page for `productId`, or for `slug` if that is how the app routes.
- The seller app opens its own product view if it has one. Otherwise it shows the card read-only.
- Price shown: `finalPrice` with `currency`. When `finalPrice` differs from `price`, show `price` struck through. This follows research R11 until China Parts confirms its pricing rules.
- `currency` is already the signed-in viewer's preferred China Parts currency, or the base currency when signed out (FR-036). Display it as given and never convert on the device.

## Repost badge

- `repostedBy` names the most recent relevant reposter on reels injected into For You, and on items in a Reposts list.
- `repostersCount` and `topReposters` count only the reposters the viewer follows, plus the viewer, for the stacked-avatar badge. They are never a total, and they are always `0` and `[]` when signed out (FR-060). Tapping the badge opens `GET /api/reels/<id>/reposters`.

## Push notifications

They are sent with Firebase Cloud Messaging to the devices China Parts has registered for the account, in the matching app (FR-063). The `notification` title and body are already in the recipient's language.

Messages relayed through FCM and Apple's push service leave Saudi Arabia, which FR-073a permits for this content only. A message carries:
- the `notification` title and body, which may contain the actor's public name
- the `data` fields below

It carries nothing else. Messages expire after 24 hours. The app must not expect any other field, such as a description, comment text, or price.

| `data.type` | Recipient | Extra `data` | Tap action |
|-------------|-----------|--------------|------------|
| `newFollower` | Any account | `actorId` | Open the follower's reels profile |
| `reelLike` | Seller | `actorId`, `reelId` | Open the reel |
| `reelMention` | Any account | `actorId`, `reelId` | Open the reel |
| `reelRejected` | Seller | `reelId` | Open the seller's own profile, where the reel shows as Removed |

Every notification also carries `data.source = "reels"`, so the apps can route it apart from China Parts' own notifications.

## Uploads (seller app)

- **Request**: `multipart/form-data` to `POST /api/reels` with `video` (MP4, MOV, or WebM, at most 100 MB, at most 60 seconds), plus optional `thumbnail` (JPEG or PNG), `description`, and `productIds`.
- **Fast start**: the app should still re-encode with fast start, as Ciro's app does. The server remuxes as a safety net.
- **After upload**: the response comes back immediately with status `pending_moderation`. The app shows "Processing" and refreshes the owner's profile to see the outcome.

# Feature Specification: China Parts Reels Service

**Feature Branch**: `002-chinaparts-reels-service`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "i will reuse reels module in another project the project called china parts that have laravle backend and has own database that provided i need you planning to create a new project that have reels module and chatbot module but we dont touch that in this spec"

**Reference material**: the China Parts database schema export (`chinaparts_dev.sql`, supplied with the request) and the existing Ciro Chat reels capability (feature `021-reels-video-feed` in the Ciro Chat app repository, implemented by the Ciro Chat backend's reels module).

**Scope of this spec**: the new standalone project will eventually host two capabilities, reels and a chatbot. This spec covers **only the reels capability** and the project foundation it needs. The chatbot is excluded and will get its own spec.

## Clarifications

### Session 2026-10-09

- Q: Who may publish reels? → A: Approved sellers only. Customers watch, like, comment, save, follow, repost, report, and block, but cannot upload.
- Q: Are product links part of v1? → A: Yes. Sellers attach up to 5 of their own active products to a reel, and viewers tap a product card to open that product in the China Parts app. Adding to cart or buying from a reel is not offered.
- Q: Can signed-out visitors watch reels? → A: Yes, read-only. Signed-out visitors can watch the For You and hashtag feeds, open shared reel links, view profiles, and read comments. Every interaction requires sign-in.
- Decision (derived from the answers above, 2026-10-09): Customers stay followable like sellers, so a customer's reposts still reach their followers. Search and the Following feed require sign-in. A signed-out view is counted once per app installation per reel, and a Copy Link by a signed-out visitor is not counted. A request carrying an expired or signed-out session is refused rather than treated as a signed-out visitor.
- Q: Where may reels data be stored and processed? → A: All reels data is stored in Saudi Arabia. Videos and descriptions may be sent abroad only for automatic screening, and the screening provider keeps no copy. (Extended on 2026-10-10 to allow push notifications, see FR-073a.)
- Q: Which seller approval is required to publish? → A: The seller's China Parts account status must be approved. The separate identity review status is not considered.
- Q: How are comments managed? → A: Authors can delete their own comments. A reel's seller can delete any comment on their own reels. Any signed-in account can report a comment, and reported comments appear in the operator review list, where operators remove them or dismiss the reports.
- Q: Which China Parts app carries which reels features? → A: Both the customer app and the seller app carry the full feed and all engagement. The seller app also publishes reels and manages the seller's own reels. Reel links always open the customer app.
- Q: How forgiving is Arabic search matching? → A: Matching ignores common Arabic spelling variants (أ, إ, and آ match ا; ى matches ي; ة matches ه), ignores diacritics and the stretching character, and treats Arabic-Indic digits ٠ to ٩ as 0 to 9.

### Session 2026-10-10

- Q: May reels push notifications pass through FCM/APNs outside Saudi Arabia, and with what content? → A: Yes, with public data only. A push may pass through Firebase Cloud Messaging and Apple's push service carrying the text in the recipient's language, the actor's public name, and reel and account identifiers. Nothing else leaves the Kingdom.
- Q: Which reels actions require the account to be in good standing? → A: Every action that writes data, except deleting one's own reels or one's own comments and recording a view.
- Q: What repost count, if any, may a reel show? → A: Only a viewer-relative count: how many of the accounts the viewer follows, plus the viewer, reposted it, with up to 3 of their pictures. No total is ever shown, and signed-out visitors see no count.
- Q: When an account leaves good standing, should direct links to its reel videos and covers stop working? → A: Yes. They stop working within the same 15 minutes as the rest of its content and work again when the account regains good standing.
- Q: Which currency should reel product cards show? → A: The signed-in viewer's preferred China Parts currency, converted the same way China Parts converts it. Signed-out visitors, and viewers with no preferred currency, see China Parts' base currency.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Watch reels with an existing China Parts account (Priority: P1)

A China Parts shopper who is already signed in to the China Parts customer app opens the new Reels section. They are not asked to register or sign in again. A visitor who is not signed in can open Reels too and watch, but is asked to sign in as soon as they try to like, comment, save, follow, or repost. A full-screen vertical feed of published reels starts playing, and more reels keep loading as they swipe. Each reel shows the creator's public name and picture, the description, and counts for views, likes, comments, and shares.

**Why this priority**: Without single sign-on through China Parts and a working feed there is no reels experience at all. This is the smallest slice that proves the new service is correctly connected to China Parts accounts.

**Independent Test**: Pre-load published reels for test sellers. Sign in as a customer in the customer app and, separately, as a seller in the seller app. Open Reels in each and confirm the feed plays without a second sign-in, pages load without duplicates or gaps, and each account sees only its own private data. Then open Reels signed out and confirm the feed plays and that liking asks for sign-in.

**Acceptance Scenarios**:

1. **Given** a user signed in to China Parts, **When** they open Reels, **Then** the feed loads with no reels-specific registration, password, or sign-in step.
2. **Given** a request carrying a session that has expired or was signed out in China Parts, **When** it reaches the reels service, **Then** it is refused so the app can ask the user to sign in again.
3. **Given** a visitor who is not signed in, **When** they open Reels, **Then** the For You feed plays, and any attempt to like, comment, save, follow, repost, report, search, or open the Following tab asks them to sign in.
4. **Given** customer number 42 and seller number 42 both exist in China Parts, **When** each opens their own reels profile, **Then** each sees only their own identity, reels, likes, and saves.
5. **Given** reels exist in processing, removed, and hidden states, **When** a non-owner browses any surface, **Then** only published reels appear.
6. **Given** the viewer has scrolled past every available reel, **When** the next page is requested, **Then** the feed keeps going by cycling back through the catalog instead of ending.
7. **Given** a signed-in viewer watches the same reel several times, **When** views are counted, **Then** the reel's view count rises by exactly one for that viewer.

---

### User Story 2 - Seller publishes a reel that passes automatic content review (Priority: P2)

In the seller app, an approved seller records or picks a short video of up to 60 seconds, optionally adds a cover image, writes a description with #hashtags and @mentions, and posts it. The upload is confirmed immediately. The reel shows as "Processing" on the creator's own profile while the video and the description are screened automatically. A clean result publishes the reel and notifies every mentioned account. A flagged result keeps the reel off every public surface, shows it to the owner as "Removed due to policy violations", and notifies the owner.

**Why this priority**: Reels are worthless without content, and automatic screening is what makes user-generated video safe to show inside a commercial marketplace and acceptable to the app stores.

**Independent Test**: As an approved seller, upload one clean test video and one test video that the screening service is known to flag. Confirm the first becomes visible to other users, the second never does, and the owner receives a removal notification.

**Acceptance Scenarios**:

1. **Given** an approved seller, **When** they upload a video of 60 seconds or less with a description, **Then** the upload is accepted at once and the reel is visible only to its owner, labeled "Processing".
2. **Given** a processing reel whose video and description both pass screening, **When** screening completes, **Then** the reel appears on public surfaces and each mentioned account is notified.
3. **Given** a processing reel whose video or description is flagged, **When** screening completes, **Then** the reel never appears publicly, its owner sees it as removed, and the owner is notified.
4. **Given** a video longer than 60 seconds, larger than 100 MB, or in an unsupported format, **When** it is uploaded, **Then** the upload is refused with a clear reason and no partial reel or file is left behind.
5. **Given** a customer account, or a seller that is pending approval, rejected, or suspended, **When** it attempts an upload, **Then** the upload is refused with a clear reason.
6. **Given** the screening service is temporarily unavailable, **When** a reel is uploaded, **Then** the reel stays "Processing" and is screened automatically once the service recovers. It is never published unscreened.
7. **Given** an owner deletes one of their reels in any state, **When** anyone later opens that reel or its link, **Then** it is gone from every surface and the link shows that the reel is no longer available.

---

### User Story 3 - Like, comment, save, and share reels (Priority: P3)

A viewer likes a reel, reads and writes comments, saves the reel privately for later, and copies the reel's link or shares it through the phone's share options. Their own profile lists the reels they liked and the reels they saved.

**Why this priority**: Engagement is what turns passive watching into a returning audience and gives creators feedback. It depends on the feed (US1) and on content (US2).

**Independent Test**: As a customer, like, comment on, save, and copy the link of a published reel. Confirm counters change correctly, the reel appears in the Liked and Saved lists, and nobody else can see the save.

**Acceptance Scenarios**:

1. **Given** a published reel, **When** a viewer likes it and then unlikes it, **Then** the like count goes up by one and back down by one, and liking it again does not notify the creator a second time.
2. **Given** a published reel, **When** a viewer opens its comments, **Then** comments appear newest first with each author's public name and picture.
3. **Given** a comment that is empty, whitespace only, or longer than 500 characters, **When** it is submitted, **Then** it is refused.
4. **Given** a viewer saves a reel, **When** any other account looks at that reel, **Then** nothing reveals that it was saved or how many times it was saved.
5. **Given** a viewer taps Copy Link, **When** the action completes, **Then** the reel's share count rises by one. Opening the share options or sharing through another app does not change the count.
6. **Given** a viewer has liked and saved reels, **When** they open their Liked or Saved list, **Then** the reels appear most recent first and exclude reels that are no longer visible to them.
7. **Given** a viewer wrote a comment, **When** they delete it, **Then** it disappears for everyone and the reel's comment count drops by one.
8. **Given** a seller's reel has a comment by someone else, **When** the seller deletes it, **Then** it disappears for everyone. The seller cannot delete comments on other sellers' reels.

---

### User Story 4 - Go from a reel to the product being shown (Priority: P4)

When posting, a seller attaches one or more of their own China Parts products to the reel. Viewers see a product card on the reel with the product's name, image, current price, and availability. Tapping the card opens that product's page in the China Parts app.

**Why this priority**: This is what makes reels worth having in a parts marketplace: a video of an oil filter or brake kit leads straight to buying it. It builds on publishing (US2) and the feed (US1).

**Independent Test**: As a seller, post a reel with two of your active products attached. As a customer, confirm both cards show current product details and open the right product pages. Deactivate one product in China Parts and confirm its card disappears while the reel stays up.

**Acceptance Scenarios**:

1. **Given** a seller is posting a reel, **When** they attach products, **Then** only that seller's own active products can be attached, up to 5 per reel.
2. **Given** a reel with an attached product whose price later changes in China Parts, **When** a viewer sees the card, **Then** it shows the current price, not the price at posting time.
3. **Given** an attached product is later deactivated or deleted in China Parts, **When** viewers watch the reel, **Then** that product's card no longer appears and the reel itself stays published.
4. **Given** an attached product is out of stock, **When** viewers watch the reel, **Then** the card is still shown and marked as unavailable.
5. **Given** a viewer taps a product card, **When** the tap is handled, **Then** the China Parts app opens that product's page and the tap is recorded against the reel.
6. **Given** a signed-in viewer whose preferred China Parts currency differs from the base currency, **When** they see a product card, **Then** the price is shown in their preferred currency, matching China Parts' conversion. A signed-out visitor sees the base currency.

---

### User Story 5 - Visit profiles, follow creators, and block accounts (Priority: P5)

A viewer taps a creator's name to open their reels profile: public name, picture, handle, bio, follower and following counts, total likes, and a grid of their reels. The viewer follows the creator and later watches only followed creators in the Following tab. A viewer who no longer wants to see an account blocks it.

**Why this priority**: Following is what brings shoppers back to the same sellers, but the feed, publishing, and engagement deliver value without it.

**Independent Test**: As a customer, follow a seller, confirm the counts and Following tab update and the seller is notified. Block a second seller and confirm their reels vanish everywhere for the customer, and the customer's activity vanishes for them.

**Acceptance Scenarios**:

1. **Given** a viewer opens a seller's profile, **When** it loads, **Then** it shows the seller's shop name as the public name, the handle, bio, counts, and that seller's published reels newest first.
2. **Given** an owner opens their own profile, **When** it loads, **Then** it also shows their processing, removed, and hidden reels with a clear label on each.
3. **Given** a viewer follows a creator, **When** the follow completes, **Then** the counts update and the creator is notified once. Unfollowing and following again does not notify again.
4. **Given** a viewer tries to follow themselves, **When** the request is made, **Then** it is refused.
5. **Given** a viewer follows some creators, **When** they open the Following tab, **Then** it shows only original reels by those creators, newest first, with no reposts.
6. **Given** account A blocks account B, **When** either browses any surface, **Then** neither sees the other's reels or comments. Unblocking restores visibility.
7. **Given** a customer blocks a seller in reels, **When** the customer shops in China Parts, **Then** they can still find, buy from, and message that seller. Reels blocking affects reels only.
8. **Given** a viewer opens a customer's profile, **When** it loads, **Then** it shows the customer's public name, picture, handle, bio, counts, and Reposts list, with no reel grid.

---

### User Story 6 - Search reels and accounts in Arabic and English (Priority: P6)

A viewer searches for "فلتر" or "brake" and gets two groups: reels whose hashtags contain the text and accounts whose handle or public name contains it. Tapping a hashtag opens a feed of reels with that hashtag. Tapping an @mention opens that account's profile.

**Why this priority**: Search helps shoppers find content for a specific part or vehicle. It matters more as the catalog grows, so it follows the core loop.

**Independent Test**: Publish reels with Arabic and English hashtags, then search for parts of each. Confirm the matching reels and accounts are returned and blocked or unpublished content is not.

**Acceptance Scenarios**:

1. **Given** a published reel with the hashtag #فلتر_زيت, **When** a viewer searches for "فلتر", **Then** the reel is returned.
2. **Given** a published reel with the hashtag #OilFilter, **When** a viewer searches for "oilfilter", **Then** the reel is returned regardless of letter case.
3. **Given** a published reel with the hashtag #إطارات, **When** a viewer searches for "اطار", **Then** the reel is returned.
4. **Given** a published reel with the hashtag #كامري_٢٠١٨, **When** a viewer searches for "2018", **Then** the reel is returned.
5. **Given** a search made only of spaces, **When** it is submitted, **Then** it is refused.
6. **Given** matching reels that are unpublished or from blocked accounts, **When** a viewer searches, **Then** those reels are excluded.
7. **Given** a description mentioning an existing handle and an unknown handle, **When** the reel is published, **Then** only the existing handle becomes a tappable mention.

---

### User Story 7 - Report reels and comments and have operators review them (Priority: P7)

A viewer reports a reel or a comment for spam, nudity, violence, hate speech, or another reason they type in. When enough different accounts report the same reel, it is hidden automatically until an operator looks at it. Operators list hidden reels with their report reasons and either restore or remove each one. Operators also list reported comments and either remove each one or dismiss its reports.

**Why this priority**: Automatic screening catches most problems at upload. Community reporting is the safety net for what slips through, and is required for app store compliance on user-generated content.

**Independent Test**: With the auto-hide threshold set to 3 in a test environment, have three accounts report one reel. Confirm it disappears from public surfaces, appears in the operator list, and can be restored. Confirm a restored reel is never auto-hidden again.

**Acceptance Scenarios**:

1. **Given** a viewer reports a reel with reason "other", **When** they submit without typing a reason, **Then** the report is refused.
2. **Given** a viewer has already reported a reel, **When** they report it again, **Then** nothing changes and no error is shown.
3. **Given** a viewer has reached the daily report limit, **When** they report another reel, **Then** the report is refused until fewer than the limit of their reports fall within the last 24 hours.
4. **Given** a published reel reaches the configured number of distinct reporters, **When** the last report lands, **Then** the reel is hidden from all public surfaces and its owner sees it as "Under review".
5. **Given** an operator restores a hidden reel, **When** it receives further reports, **Then** the reports are kept for audit but never hide it automatically again.
6. **Given** a regular China Parts user session, **When** it is used on the operator review surface, **Then** access is refused.
7. **Given** a signed-in viewer reports a comment, **When** an operator opens the reported-comments list, **Then** the comment appears with its report reasons and count.
8. **Given** an operator removes a reported comment, **When** anyone views the reel, **Then** the comment is gone and the comment count drops by one. If the operator dismisses the reports instead, the comment stays and leaves the list.

---

### User Story 8 - Repost reels to followers (Priority: P8)

A viewer reposts a reel they like. Their followers then see it in their For You feed with a "reposted by" label. The reposting account's profile has a public Reposts list.

**Why this priority**: Reposts widen a seller's reach through customers' networks. It is an amplifier on top of the core loop, not part of it.

**Independent Test**: Account A follows account B. B reposts a seller's reel. Confirm A's For You feed shows the reel once with B named in the label, and B's Reposts list includes it.

**Acceptance Scenarios**:

1. **Given** a viewer reposts a reel and then removes the repost, **When** their followers refresh For You, **Then** the injected reel appears and then disappears.
2. **Given** two followed accounts repost the same reel, **When** a follower browses For You, **Then** the reel appears once, labeled with the reposters.
3. **Given** a reel that is reposted, **When** viewers look at the reel, **Then** no total repost count is shown. A signed-in viewer sees only how many of the accounts they follow, plus themselves, reposted it.
4. **Given** anyone opens the list of who reposted a reel, **When** it loads, **Then** it excludes accounts the viewer has blocked or been blocked by.

---

### User Story 9 - Receive notifications on devices already registered with China Parts (Priority: P9)

A seller gets a push notification on their seller-app phone when someone follows them, likes one of their reels, mentions them, or when one of their reels is removed. They never registered anything new for reels: notifications go to the devices China Parts already knows for that exact account.

**Why this priority**: Notifications bring creators back, but every earlier story works without them.

**Independent Test**: Register a seller device and a customer device in China Parts for accounts that share the same number. Trigger each notification type for the seller and confirm only the seller's device receives it.

**Acceptance Scenarios**:

1. **Given** a seller with two registered devices, **When** a customer likes the seller's reel, **Then** both seller devices receive one notification.
2. **Given** customer 42 and seller 42 each have a registered device, **When** seller 42 gains a follower, **Then** only seller 42's device is notified.
3. **Given** a user likes their own reel, **When** the like is recorded, **Then** no notification is sent.
4. **Given** the push service is unavailable, **When** a like happens, **Then** the like still succeeds and the failure does not affect the user.

---

### User Story 10 - Share a reel link that opens the China Parts customer app (Priority: P10)

A viewer copies a reel's link and sends it to a friend on another messaging app. The friend taps it and the China Parts customer app opens straight to that reel. If the friend does not have the customer app, they land on a simple page that sends them to the customer app in the right app store.

**Why this priority**: Shared links bring in new shoppers, but the experience inside the app comes first.

**Independent Test**: Open a reel link on an iPhone and an Android phone with the customer app installed, with both apps installed, with neither, and on a desktop browser.

**Acceptance Scenarios**:

1. **Given** the China Parts customer app is installed, **When** a reel link is tapped, **Then** the app opens to that reel whether or not the user is signed in, and swiping continues into the feed.
2. **Given** the customer app is not installed, **When** the link is opened on iPhone or Android, **Then** the page sends the user to the customer app's listing in the matching app store.
3. **Given** both the customer app and the seller app are installed, **When** a reel link is tapped, **Then** the customer app opens.
4. **Given** the link points to a deleted, removed, or hidden reel, **When** it is opened in the app, **Then** a "no longer available" message is shown.
5. **Given** a desktop browser, **When** a reel link is opened, **Then** the page shows links to the customer app on both the App Store and Google Play.

---

### Edge Cases

- **Same number, two account types**: China Parts numbers customers and sellers separately, so customer 5 and seller 5 are different people. Every reels record, notification, and permission check must tell them apart.
- **One person, two accounts**: someone who is both a customer and a seller has two separate reels identities. Following one does not follow the other, and blocking applies only to the identity blocked.
- **Identity review still pending**: a seller whose account is approved but whose identity review is pending or rejected can still publish, because only account status counts.
- **Seller loses good standing**: when a seller is suspended, rejected, or otherwise no longer approved, their reels and comments disappear from public surfaces. When the seller is approved again, the content comes back without any manual step.
- **Account out of good standing cleans up**: it can still delete its own reels and its own comments. Every other action that writes data is refused.
- **Standing changes while a reel is processing**: the reel is screened as usual but stays off public surfaces until its owner is back in good standing.
- **Account removed from China Parts**: the account's reels, comments, likes, saves, follows, and reposts disappear from all surfaces, and affected counters are corrected.
- **Customer tries to publish**: the upload is refused with a reason that explains reels are for sellers.
- **Signed-out visitor signs in**: their liked, saved, and followed state appears as soon as they sign in, and the reel they are watching keeps playing.
- **Bulk copying by signed-out visitors**: signed-out browsing is rate-limited, so a single visitor cannot download the catalog in bulk.
- **Signed out mid-session**: an action made with a session that China Parts has since signed out is refused, even if earlier actions in the same session succeeded.
- **China Parts data temporarily unreachable**: the service does not grant access it cannot verify. Users get a clear "temporarily unavailable" response and no reels data is lost or corrupted.
- **Arabic-only names**: a seller whose shop name is entirely in Arabic still gets a valid, unique handle automatically.
- **Handle collisions**: two shops with the same name get distinct handles.
- **Hashtags that differ only by spelling variant**: #إطارات and #اطارات are the same hashtag, so either one opens a hashtag feed containing both. Each reel still displays the hashtag exactly as its creator typed it.
- **Mixed-language descriptions**: descriptions that mix Arabic, English, digits, and emoji keep every hashtag and mention intact.
- **Interrupted upload**: a dropped connection mid-upload leaves no partial reel and no orphaned files.
- **Description-only violation**: a clean video with an offensive description is removed like a flagged video.
- **Linked product reassigned or deleted**: any card for a product that no longer belongs to the reel's seller, or no longer exists, is not shown.
- **Phone with only the seller app**: a reel link opened there goes to the store page for the customer app, because links always open the customer app. Sellers reach their own reels through the seller app instead.
- **Device registered for the wrong app**: a token registered to the customer app never receives notifications meant for a seller account, and the reverse.
- **Reported comment deleted first**: when a comment's author or the reel's seller deletes a reported comment, it leaves the operator list and its reports are kept for audit.
- **Dismissed comment reported again**: a comment whose reports were dismissed returns to the operator list only when an account that has not reported it before reports it.
- **Reporting abuse**: a single account cannot hide a reel alone. Coordinated reports from many accounts are handled by operator restore.

## Requirements *(mandatory)*

### Functional Requirements

#### Service boundary and China Parts integration

- **FR-001**: The reels capability MUST run as a new, independent service that can be deployed, scaled, and restarted without changing or redeploying China Parts' existing backend.
- **FR-002**: The reels service MUST NOT create, modify, or delete any China Parts record, and MUST NOT require changes to the China Parts data structure. China Parts stays the single source of truth for accounts, account standing, shops, products, and device registrations.
- **FR-003**: Users MUST use reels with their existing China Parts session. There MUST be no separate reels registration, password, or sign-in.
- **FR-004**: Visitors with no China Parts session MUST be able to watch the For You feed and hashtag feeds, open a single reel by its link, view profiles, and read comments. Every other action MUST require a valid China Parts session. This includes the Following feed, search, liking, commenting, saving, following, blocking, reporting, reposting, publishing, and the Liked, Saved, and followed-accounts lists.
- **FR-004a**: A request carrying an expired, invalid, or signed-out session MUST be refused rather than treated as a signed-out visitor, so the app can prompt the user to sign in again.
- **FR-004b**: Signed-out browsing MUST be limited to a configurable number of requests per visitor per minute.
- **FR-005**: A session signed out or revoked in China Parts MUST stop working for reels within 5 minutes.
- **FR-006**: Each reels identity MUST be keyed by both account type (customer or seller) and the China Parts account number. A customer and a seller with the same number MUST never share data, permissions, or notifications.
- **FR-007**: China Parts administrator accounts MUST NOT be able to act as reels users.
- **FR-008**: Every reels action that writes data MUST require good standing, including commenting, liking, saving, following, blocking, reporting, reposting, sharing, and editing one's profile. Only two kinds of action are exempt: deleting one's own reels or one's own comments, and recording a view. Good standing means an active customer or a seller whose China Parts account status is approved. A seller's identity review status MUST NOT affect standing.
- **FR-009**: Reels and comments by an account that leaves good standing MUST disappear from every public surface within 15 minutes, and MUST reappear automatically within 15 minutes of the account regaining good standing. Direct links to that account's reel videos and cover images count as a public surface: they MUST stop working and work again on the same schedule.
- **FR-010**: Reels data belonging to an account that no longer exists in China Parts MUST be removed from all surfaces within 24 hours, with affected counters corrected.

#### Public identity and privacy

- **FR-011**: A seller's public name MUST be their China Parts shop name, falling back to the seller's first name and last-name initial when no shop exists.
- **FR-012**: A customer's public name MUST be their first name and last-name initial.
- **FR-013**: A creator's picture MUST be their China Parts profile picture where one exists, otherwise a default placeholder.
- **FR-014**: Changes to names, shop names, or pictures in China Parts MUST appear in reels within 15 minutes.
- **FR-015**: Each reels identity MUST receive a unique handle automatically on first use, including when the source name is entirely in Arabic. The owner MUST be able to change the handle to any unused one, and to set a bio of up to 150 characters.
- **FR-016**: Reels responses and notifications MUST NOT expose an account's email address, phone number, national ID, street address, wallet or payment data, or order history.

#### Feed and playback

- **FR-017**: The service MUST provide a For You feed (the default) of published reels, newest first, plus reels reposted by accounts the viewer follows, merged by repost time and shown once each. Signed-out visitors see published reels only, without reposts.
- **FR-018**: The service MUST provide a Following feed of original reels by followed accounts only, newest first, with no reposts.
- **FR-019**: Feeds MUST be paged so that scrolling never shows a reel twice or skips one, even while new reels are being published. Page size MUST default to 10 and never exceed 25.
- **FR-020**: When the For You feed runs out of reels, it MUST continue by cycling through the catalog again.
- **FR-021**: Non-owners MUST only ever see published reels. Owners MUST see their own reels in every state, each clearly labeled.
- **FR-022**: Any single reel MUST be retrievable by its identifier, subject to the same visibility rules.
- **FR-023**: Uploaded videos MUST be served so that playback can begin before the whole file has downloaded.
- **FR-024**: A view MUST be counted once per account per reel when playback starts. A signed-out visitor's view MUST be counted once per app installation per reel.

#### Publishing and automatic screening

- **FR-025**: Publishing MUST be limited to approved sellers in good standing. Upload attempts by customers, or by sellers that are pending, rejected, or suspended, MUST be refused with a clear reason.
- **FR-063a**: The customer app and the seller app MUST both offer the full feed and all engagement to their signed-in users. Publishing and managing one's own reels MUST be available only through the seller app.
- **FR-026**: An upload MUST contain exactly one video of at most 60 seconds and 100 MB, in MP4, MOV, or WebM format. The 60-second limit MUST be enforced by the service regardless of what the app checks. The service measures duration itself and allows up to 1 second of measurement tolerance.
- **FR-027**: An upload MAY include one JPEG or PNG cover image and a description of up to 2,200 characters.
- **FR-028**: Hashtags and @mentions MUST be recognized in Arabic script, Latin script, digits, and underscores. Hashtags MUST be compared without the "#", without regard to letter case, and with the normalization in FR-049a, while each reel displays its hashtags exactly as typed. Only mentions of existing handles become tappable mentions.
- **FR-029**: A new reel MUST start in a "processing" state that is invisible to everyone but its owner. The upload confirmation MUST NOT wait for screening.
- **FR-030**: Each reel's video and description MUST be screened automatically. A clean result on both MUST publish the reel and notify mentioned accounts. A flag on either MUST mark the reel removed, keep it off every public surface, and notify the owner.
- **FR-031**: If screening cannot run, the reel MUST stay in processing and MUST be retried automatically until screening succeeds. A reel MUST never be published without a clean result.
- **FR-032**: Owners MUST be able to delete their own reels in any state. A deleted reel MUST disappear from every surface along with its likes, saves, comments, reposts, reports, and product links.
- **FR-033**: A failed upload of any kind MUST leave no partial reel and no stored files behind.

#### Product links

- **FR-034**: Sellers MUST be able to link reels to China Parts products. Opening a linked product is covered by FR-038. Adding to cart or buying from a reel MUST NOT be offered.
- **FR-035**: A seller MUST only be able to attach their own products that are active and not deleted, up to 5 per reel. Attachments MUST be set at posting time and MAY be edited by the owner afterwards.
- **FR-036**: Product cards MUST show the product's current name, main image, current price, and availability as held in China Parts at the time of viewing. The price MUST be shown in the signed-in viewer's preferred China Parts currency, converted the same way China Parts converts it. Signed-out visitors, viewers with no preferred currency, and viewers whose currency has no exchange rate in China Parts MUST see China Parts' base currency. A card MUST always state its currency.
- **FR-037**: A product that becomes inactive, deleted, or no longer owned by the reel's seller MUST stop appearing on the reel without affecting the reel's own status. An out-of-stock product MUST stay visible and be marked unavailable.
- **FR-038**: Tapping a product card MUST open that product in the China Parts app, and each tap MUST be recorded against the reel and product.

#### Engagement

- **FR-039**: Viewers MUST be able to like and unlike published reels. The like count MUST reflect the current number of likes.
- **FR-040**: Viewers MUST be able to post comments of 1 to 500 characters after trimming spaces, and read comments newest first, 20 per page by default and up to 50.
- **FR-040a**: Comment authors MUST be able to delete their own comments. A reel's seller MUST be able to delete any comment on their own reels, and no one else's.
- **FR-040b**: A deleted comment MUST disappear from every surface, and the reel's comment count MUST drop by one.
- **FR-041**: Viewers MUST be able to save and unsave reels. Saves MUST be private: no count and no indication to anyone but the saver.
- **FR-042**: The share count MUST rise only when a signed-in viewer uses Copy Link. Opening share options, dismissing them, sharing through another app, or copying a link while signed out MUST NOT change it.
- **FR-043**: Each account MUST have a Liked list and a Saved list, both visible only to the account owner, newest first, excluding reels no longer visible to them.

#### Profiles, following, and blocking

- **FR-044**: Each reels profile MUST show public name, picture, handle, bio, follower count, following count, and the account's Reposts list (FR-061). Seller profiles MUST also show total likes across the seller's reels and the seller's reels newest first.
- **FR-045**: Accounts MUST be able to follow and unfollow other reels identities. Following oneself MUST be refused.
- **FR-046**: Accounts MUST be able to list the identities they follow, to support mention suggestions while writing a description.
- **FR-047**: Accounts MUST be able to block and unblock other reels identities. A block MUST hide each party's reels and comments from the other on every reels surface.
- **FR-048**: Blocking in reels MUST NOT affect shopping, ordering, or messaging in China Parts.

#### Search and hashtags

- **FR-049**: Search MUST return reels whose hashtags contain the search text and accounts whose handle or public name contains it, in Arabic or English, without regard to letter case.
- **FR-049a**: Search, hashtag feeds, and hashtag matching MUST treat أ, إ, and آ as ا, ى as ي, and ة as ه. They MUST ignore Arabic diacritics and the stretching character, and MUST treat the Arabic-Indic digits ٠ to ٩ as the digits 0 to 9.
- **FR-050**: Searches that are empty or only spaces MUST be refused.
- **FR-051**: Viewers MUST be able to open a feed of published reels for a single hashtag, newest first.
- **FR-052**: Search results and hashtag feeds MUST exclude unpublished reels and apply the block rule in FR-047.

#### Reporting and operator review

- **FR-053**: Viewers MUST be able to report a reel for spam, nudity, violence, hate speech, or "other". "Other" MUST require a typed reason of up to 500 characters.
- **FR-053a**: Signed-in viewers MUST be able to report a comment using the same reasons as FR-053.
- **FR-054**: Each account MUST be able to report a given reel or comment at most once. Repeat reports MUST be accepted silently with no effect.
- **FR-055**: Each account MUST be limited to a configurable number of reports in any rolling 24-hour period, defaulting to 20. Reel and comment reports share this limit.
- **FR-056**: A published reel MUST be hidden automatically when its number of distinct reporters reaches a configurable threshold, defaulting to 25. Its owner MUST see it as "Under review".
- **FR-057**: Operators MUST be able to list hidden reels newest first, with each reel's report reasons and counts.
- **FR-057a**: Operators MUST be able to list reported comments, most recently reported first, with each comment's text, reel, author, report reasons, and counts. Operators MUST be able to remove a reported comment or dismiss its reports, which takes it off the list.
- **FR-058**: Operators MUST be able to restore a hidden reel to published or confirm it as removed. A restored reel MUST keep recording reports but MUST never be hidden automatically again.
- **FR-059**: The operator surface MUST be reachable only with a dedicated operator credential. A China Parts user session MUST NOT grant access to it.

#### Reposts

- **FR-060**: Accounts MUST be able to repost and remove a repost of published reels. Reposting MUST NOT create a copy of the reel. A reel MUST NOT show a total repost count. It MAY show how many of the accounts the viewer follows, plus the viewer, reposted it, with up to 3 of their pictures. Signed-out visitors MUST see no repost count.
- **FR-061**: Each account MUST have a public Reposts list. Anyone MUST be able to see who reposted a reel, excluding blocked accounts.

#### Notifications

- **FR-062**: The service MUST send a push notification for a new follower, a like on the recipient's reel, a mention in a newly published reel, and the removal of the recipient's reel by screening.
- **FR-063**: Notifications MUST go to every device China Parts has registered for the recipient's exact account, and only to devices registered for the matching app: the customer app for customer accounts, the seller app for seller accounts.
- **FR-064**: Users MUST NOT be notified about their own actions. Repeating an action after undoing it MUST NOT notify again.
- **FR-065**: Notification text MUST be available in Arabic and English.
- **FR-066**: A notification failure MUST NOT cause the triggering action to fail.

#### Share links

- **FR-067**: Every reel MUST have a unique, permanent web link on a China Parts-controlled domain. Copy Link and every external share MUST use that link.
- **FR-068**: Opening a reel link on a phone with the China Parts customer app installed MUST open the customer app to that reel, even when the seller app is also installed.
- **FR-069**: Opening a reel link without the customer app MUST show a simple page that sends iPhone users to the customer app on the App Store and Android users to the customer app on Google Play, using configurable store addresses. On any other device, such as a desktop browser, the page MUST show links to both store listings.

#### Operations

- **FR-070**: All limits and thresholds in this spec MUST be configurable without a code change. This covers video length and size, description and comment lengths, page sizes, products per reel, the report limit, the auto-hide threshold, and the signed-out request rate.
- **FR-071**: Demo or seed content MUST be available for development and test environments only, and MUST never be loaded into production.

#### Data residency

- **FR-072**: All reels data MUST be stored in Saudi Arabia. This covers videos, cover images, descriptions, comments, account links, engagement records, reports, and notification records.
- **FR-073**: Videos and descriptions MAY be sent to a screening provider outside Saudi Arabia solely for automatic screening. The provider MUST NOT keep any copy after returning its result.
- **FR-073a**: Push notifications MAY pass through Firebase Cloud Messaging and Apple's push service outside Saudi Arabia. A push MUST carry only the notification text in the recipient's language, the actor's public name, and reel and account identifiers. FR-073 and this requirement are the only cases where reels data leaves Saudi Arabia.

### Key Entities *(include if feature involves data)*

- **Reels Identity**: one per China Parts account that uses reels. Keyed by account type (customer or seller) and China Parts account number. Owns the handle, bio, follower and following counts, and total likes. Public name, picture, and good standing are always read from China Parts, never stored as the authority.
- **Reel**: a short video published by one seller's reels identity. Holds the video, optional cover image, description, recognized hashtags, recognized mentions, state (processing, published, removed, hidden), screening result, view, like, comment, and share counts, publish time, distinct reporter count, and whether an operator restored it.
- **Product Link**: connects a reel to a China Parts product in display order. Holds only the reference. Product name, image, price, stock, and status are always read live from China Parts.
- **Product Tap**: a record that a viewer tapped a product card on a reel.
- **Like and Save**: one per identity per reel. Saves are private.
- **View**: one per identity per reel, or one per app installation per reel for signed-out visitors.
- **Share Event**: a record of one Copy Link action on a reel. Many per identity are allowed.
- **Comment**: text of 1 to 500 characters by one identity on one reel.
- **Follow**: one identity following another.
- **Block**: one identity blocking another. Applies in both directions for visibility.
- **Repost**: one identity redistributing one reel to its followers.
- **Report**: one identity's report on one reel or one comment, with reason and optional typed reason. Kept for audit. Comment reports also record whether an operator dismissed them.
- **Notification Event**: a durable record of a notification-worthy action, used to stop duplicate notifications.
- **China Parts references** (read-only, owned by China Parts): customer accounts, seller accounts and their approval state, each account's preferred currency, shops, products with their variants and prices, exchange rates, sign-in sessions, and registered devices per app.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of signed-in China Parts customers and sellers in acceptance testing reach a playing reel without any extra sign-in step.
- **SC-002**: For 95% of sessions on a typical mobile connection, the first reel starts playing within 2 seconds of opening Reels.
- **SC-003**: With 500 people browsing at the same time, 95% of feed pages load within 1 second.
- **SC-004**: 95% of clean uploads become visible to other users within 2 minutes of upload, and no flagged reel is ever visible to a non-owner.
- **SC-005**: In a test data set where every account number exists as both a customer and a seller, zero data, permission, or notification crossovers occur between the two.
- **SC-006**: A before-and-after comparison of China Parts data over a full acceptance run shows zero records created, changed, or deleted by the reels service.
- **SC-007**: In 100% of test cases, a suspended seller's reels leave public surfaces and their direct video and cover links stop working within 15 minutes, and both come back within 15 minutes of reinstatement.
- **SC-008**: An audit of every reels response and notification type finds zero email addresses, phone numbers, national IDs, addresses, or payment details.
- **SC-009**: 100% of Arabic, English, and mixed-language hashtags in the test set can be found by searching any part of them, including when the search uses a different Arabic spelling variant or a different digit style.
- **SC-010**: 95% of notifications reach the recipient's registered devices within 30 seconds of the triggering action.
- **SC-011**: Reel links open the correct reel in the customer app on iPhone and Android in 100% of test cases, including phones that also have the seller app, and lead to the customer app's store listing when it is absent.
- **SC-012**: Every Ciro Chat reels capability marked "carried over" in the capability table below passes its acceptance scenario on China Parts accounts.
- **SC-013**: A viewer reaches a product page from a reel in one tap, and product taps per reel can be counted for every published reel.
- **SC-014**: In 100% of test cases, a signed-out visitor can watch the feed and a shared reel without signing in, and every attempt to interact asks them to sign in.
- **SC-015**: An infrastructure audit finds 100% of stored reels data in Saudi Arabia, the screening provider's terms confirm it keeps no copy of submitted content, and every push notification type carries only the fields FR-073a allows.

## Assumptions

### Capability carry-over from Ciro Chat reels

| Capability | China Parts reels |
|------------|-------------------|
| For You and Following feeds, looping catalog | Carried over |
| Upload of up to 60 seconds with automatic video and description screening | Carried over, approved sellers only |
| Like, comment, save, view, Liked and Saved lists | Carried over |
| Copy Link and phone share options | Carried over, links on a China Parts domain |
| Store fallback page for links | Carried over, pointing to China Parts store listings |
| Profiles, follow, block | Carried over, identity taken from China Parts accounts |
| Hashtag and account search, hashtag feed, mentions | Carried over, extended to Arabic script |
| Reporting, auto-hide, operator review | Carried over |
| Deleting and reporting comments | New, also added to the Ciro Chat reels spec |
| Reposts and the reposters list | Carried over |
| Push notifications | Carried over, delivered to devices registered in China Parts |
| Send reel to a recent chat inside the app | Dropped, because China Parts conversations are outside this service |
| Demo content seeding | Development and test only |
| Product links and product taps | New |
| Watching while signed out | New: feeds, profiles, comments, and shared links |
| Following China Parts account standing | New |

### Interpretation and scope

- "We don't touch that in this spec" is read as excluding the chatbot module. The new project will host the chatbot later, and this spec covers the reels capability only.
- The new project is separate from the Ciro Chat backend. Ciro Chat's own reels capability is unchanged, and no Ciro Chat users or content move to China Parts.
- This spec covers the service that China Parts apps use. Building the reels screens inside the China Parts customer and seller apps is a separate effort that depends on this service. Both apps carry the full feed and engagement, and the seller app adds publishing and management of the seller's own reels.
- The reels service does not modify China Parts. It reads China Parts data, such as accounts, sessions, standing, shops, products, and devices, as the authority. How it reads that data is decided during planning.

### Market and product defaults

- China Parts serves a Saudi market in Arabic and English, based on the Arabic name fields and the default currency in the supplied database. Product card prices follow FR-036: the viewer's preferred currency, or the base currency for signed-out visitors.
- Feeds are ordered by time. No recommendation or personalization algorithm is included.
- Customer public names use first name plus last-name initial to protect shopper privacy.
- Customers can be followed like sellers, so a customer's reposts reach their followers. Customer profiles have no reel grid because customers cannot publish.
- Signed-out visitors can open product pages from reels, as China Parts already lets signed-out visitors browse products.
- Comment text is not screened automatically, matching Ciro Chat. Offensive comments are handled by deletion and reporting instead (FR-040a, FR-053a).
- Each reel removed by screening stands alone. There are no strikes, suspensions, or appeals for reels in v1.

### Dependencies

- An anonymous installation identifier supplied by the China Parts apps, used to count signed-out views.
- Read access to China Parts accounts, sign-in sessions, seller approval state, shops, products, prices, registered devices, each account's preferred currency, and the exchange rates China Parts uses to convert prices.
- Permission to send push notifications to devices registered with the China Parts apps.
- A China Parts-controlled web domain for reel links, configured to open the China Parts customer app, plus the customer app's App Store and Google Play listing addresses.
- An automatic video and text screening provider that keeps no copy of submitted content (FR-073).
- Storage and delivery for uploaded videos and cover images in Saudi Arabia, separate from China Parts' own media storage. Planning confirms whether any content delivery network used for playback satisfies FR-072.

### Out of scope

- The chatbot module.
- Any change to China Parts' existing backend, database structure, or admin panel.
- Sending reels into China Parts customer–seller conversations.
- Adding reels activity to China Parts' in-app notification list.
- Adding products to the cart or buying directly from a reel.
- Customer-published reels, including video product reviews.
- Seller analytics dashboards, paid promotion of reels, and live streaming.
- An operator user interface. Operators use the secured operator surface directly.
- Moving any Ciro Chat data.

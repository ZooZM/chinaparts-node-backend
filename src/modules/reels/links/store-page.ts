import { escapeHtml } from './html.util';

/** A reel id is exactly 24 hex digits. Anything else is not a reel link (and is never put in a page). */
const REEL_ID = /^[0-9a-f]{24}$/i;

export function isReelId(value: string): boolean {
  return REEL_ID.test(value);
}

export interface StorePageConfig {
  /** Where the page is served, with no trailing slash: `LINKS_PUBLIC_BASE_URL`. */
  baseUrl: string;
  /** The page title and the link preview title: `LINKS_PAGE_TITLE`. */
  title: string;
  iosStoreUrl: string;
  androidStoreUrl: string;
}

type Platform = 'ios' | 'android' | 'other';

export function platformOf(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'other';
}

/** Only web addresses are followed: a store setting is a link, never a script. */
function safeUrl(value: string): string | null {
  return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * The page a shared reel link shows to someone who does not have the customer app (FR-067 to
 * FR-069, research R15): iPhones go to the App Store, Android phones to Google Play, and any
 * other device, such as a desktop browser, sees both links. It never looks the reel up, so it
 * shows and reveals nothing about it.
 *
 * Every value that reaches the HTML is escaped, and the id is checked to be a reel id first: the
 * page this replaces put the raw id into the HTML, which was a cross-site scripting hole.
 */
export function renderStorePage(
  reelId: string,
  userAgent: string,
  config: StorePageConfig,
): { html: string; redirectTo: string | null } {
  const platform = platformOf(userAgent);
  const ios = safeUrl(config.iosStoreUrl);
  const android = safeUrl(config.androidStoreUrl);
  const redirectTo =
    platform === 'ios' ? ios : platform === 'android' ? android : null;

  const url = escapeHtml(`${config.baseUrl}/reels/${reelId}`);
  const title = escapeHtml(config.title);
  const links = [
    platform !== 'android' && ios
      ? `<p><a href="${escapeHtml(ios)}">Download on the App Store</a></p>`
      : '',
    platform !== 'ios' && android
      ? `<p><a href="${escapeHtml(android)}">Get it on Google Play</a></p>`
      : '',
  ]
    .filter(Boolean)
    .join('\n  ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:url" content="${url}" />
  ${redirectTo ? `<meta http-equiv="refresh" content="0; url=${escapeHtml(redirectTo)}" />` : ''}
</head>
<body>
  <p>${title}</p>
  ${links}
</body>
</html>
`;
  return { html, redirectTo };
}

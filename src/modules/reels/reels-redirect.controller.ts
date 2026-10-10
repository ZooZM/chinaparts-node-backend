import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Access } from '../../common/guards/access.decorator';

/**
 * Public (unauthenticated) browser-facing fallback for reel deep links
 * opened without the CiroChat app installed (FR-039a). NOT under `/api` —
 * outside the JSON response envelope, and `@Access('public')` so the global
 * guard does not ask for a session (a route without a level is signed-in).
 *
 * Store URLs are placeholders until the app is published; override via env.
 */
const IOS_STORE_URL =
  process.env.REELS_IOS_STORE_URL || 'https://apps.apple.com/app/cirochat';
const ANDROID_STORE_URL =
  process.env.REELS_ANDROID_STORE_URL ||
  'https://play.google.com/store/apps/details?id=com.cirochat.app';

export function renderRedirectPage(
  reelId: string,
  userAgent: string,
): { url: string | null; html: string } {
  const ua = userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const target = isIOS ? IOS_STORE_URL : isAndroid ? ANDROID_STORE_URL : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Watch this reel on CiroChat</title>
  ${target ? `<meta http-equiv="refresh" content="0; url=${target}" />` : ''}
</head>
<body>
  <p>Watch reel ${reelId} in the CiroChat app.</p>
  <p><a href="${IOS_STORE_URL}">Download on the App Store</a></p>
  <p><a href="${ANDROID_STORE_URL}">Get it on Google Play</a></p>
</body>
</html>`;

  return { url: target, html };
}

@Controller('reels')
@Access('public')
export class ReelsRedirectController {
  @Get(':id')
  redirect(@Param('id') id: string, @Res() res: Response) {
    const userAgent = res.req.headers['user-agent']?.toString() ?? '';
    const { html } = renderRedirectPage(id, userAgent);
    res.type('html').send(html);
  }
}

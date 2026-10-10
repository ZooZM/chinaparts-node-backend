import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ErrorCode } from '../../../common/errors/error-codes';
import { Access } from '../../../common/guards/access.decorator';
import {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
  parseFingerprints,
} from './app-links';
import { isReelId, renderStorePage } from './store-page';

/**
 * Reel links that open the customer app, and the page for anyone who does not have it (FR-067 to
 * FR-069, research R15). Public, outside the `/api` prefix and the JSON envelope: browsers and the
 * app-link checkers of iOS and Android read these, not the apps. They still count against the
 * per-IP limit, like any other request.
 */
@Controller()
@Access('public')
export class LinksController {
  constructor(private readonly config: ConfigService) {}

  // The store fallback (#33). An id that is not a reel id is a 404 that says nothing about it.
  @Get('reels/:id')
  storePage(@Param('id') id: string, @Res() res: Response): void {
    if (!isReelId(id)) throw this.notFound();
    const { html } = renderStorePage(
      id,
      res.req.headers['user-agent']?.toString() ?? '',
      {
        baseUrl: this.config
          .getOrThrow<string>('LINKS_PUBLIC_BASE_URL')
          .replace(/\/+$/, ''),
        title: this.config.getOrThrow<string>('LINKS_PAGE_TITLE'),
        iosStoreUrl: this.config.getOrThrow<string>('IOS_STORE_URL'),
        androidStoreUrl: this.config.getOrThrow<string>('ANDROID_STORE_URL'),
      },
    );
    res.type('html').set('Cache-Control', 'public, max-age=300').send(html);
  }

  // #34. JSON with no extension and no redirect, which is what Apple requires.
  @Get('.well-known/apple-app-site-association')
  appleAppSiteAssociation(@Res() res: Response): void {
    const teamId = this.config.get<string>('IOS_TEAM_ID');
    const bundleId = this.config.get<string>('IOS_BUNDLE_ID');
    if (!teamId || !bundleId) throw this.notFound();
    res
      .type('application/json')
      .send(JSON.stringify(buildAppleAppSiteAssociation({ teamId, bundleId })));
  }

  // #35.
  @Get('.well-known/assetlinks.json')
  assetLinks(@Res() res: Response): void {
    const packageName = this.config.get<string>('ANDROID_PACKAGE_NAME');
    const fingerprints = parseFingerprints(
      this.config.get<string>('ANDROID_CERT_FINGERPRINTS'),
    );
    if (!packageName || fingerprints.length === 0) throw this.notFound();
    res
      .type('application/json')
      .send(JSON.stringify(buildAssetLinks({ packageName, fingerprints })));
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.NOT_FOUND,
      message: 'Not found',
    });
  }
}

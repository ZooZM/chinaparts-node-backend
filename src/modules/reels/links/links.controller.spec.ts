import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ACCESS_KEY } from '../../../common/guards/access.decorator';
import { escapeHtml } from './html.util';
import { LinksController } from './links.controller';
import {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
  parseFingerprints,
} from './app-links';
import { isReelId, platformOf, renderStorePage } from './store-page';

const ID = '650000000000000000000001';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8)';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const config = {
  baseUrl: 'https://reels.example.test',
  title: 'China Parts Reels',
  iosStoreUrl: 'https://apps.apple.com/app/id123',
  androidStoreUrl:
    'https://play.google.com/store/apps/details?id=sa.chinaparts',
};

describe('escapeHtml', () => {
  it('escapes everything that can end text or an attribute', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('leaves ordinary text, Arabic included, alone', () => {
    expect(escapeHtml('ريلز China Parts 2018')).toBe('ريلز China Parts 2018');
  });
});

describe('isReelId', () => {
  it.each([ID, ID.toUpperCase(), 'abcdef0123456789abcdef01'])(
    'accepts %s',
    (id) => {
      expect(isReelId(id)).toBe(true);
    },
  );

  it.each([
    '',
    'some-id',
    '<script>',
    'abcdefghijkl', // 12 characters: ObjectId.isValid would call it valid
    `${ID}0`,
    ID.slice(1),
    'g'.repeat(24),
    `${ID}\n`,
  ])('refuses %p', (id) => {
    expect(isReelId(id)).toBe(false);
  });
});

describe('renderStorePage (FR-067 to FR-069)', () => {
  it('sends an iPhone to the App Store, and shows only that link', () => {
    const { html, redirectTo } = renderStorePage(ID, IPHONE, config);

    expect(redirectTo).toBe(config.iosStoreUrl);
    expect(html).toContain(config.iosStoreUrl);
    expect(html).toContain('http-equiv="refresh"');
    expect(html).not.toContain('play.google.com');
  });

  it('sends an Android phone to Google Play, and shows only that link', () => {
    const { html, redirectTo } = renderStorePage(ID, ANDROID, config);

    expect(redirectTo).toBe(config.androidStoreUrl);
    expect(html).toContain('play.google.com');
    expect(html).not.toContain('apps.apple.com');
  });

  it.each([DESKTOP, '', 'curl/8.0'])(
    'shows both links and does not redirect for %p',
    (agent) => {
      const { html, redirectTo } = renderStorePage(ID, agent, config);

      expect(redirectTo).toBeNull();
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).toContain(config.iosStoreUrl);
      expect(html).toContain('play.google.com');
    },
  );

  it('carries the canonical link and og:url built from the public base URL', () => {
    const { html } = renderStorePage(ID, DESKTOP, config);

    expect(html).toContain(
      `<link rel="canonical" href="https://reels.example.test/reels/${ID}" />`,
    );
    expect(html).toContain(
      `<meta property="og:url" content="https://reels.example.test/reels/${ID}" />`,
    );
    expect(html).toContain(
      '<meta property="og:title" content="China Parts Reels" />',
    );
  });

  it('escapes the title and every address that comes from configuration', () => {
    const { html } = renderStorePage(ID, DESKTOP, {
      baseUrl: 'https://x.test/"><script>1</script>',
      title: '<img src=x onerror=alert(1)>',
      iosStoreUrl: 'https://apps.apple.com/?a=1&b="2"',
      androidStoreUrl: 'https://play.google.com/?q=<b>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
  });

  it('never follows a store setting that is not a web address', () => {
    const { html, redirectTo } = renderStorePage(ID, IPHONE, {
      ...config,
      iosStoreUrl: 'javascript:alert(1)',
    });

    expect(redirectTo).toBeNull();
    expect(html).not.toContain('javascript:');
  });

  it('says nothing about the reel beyond its id in the address', () => {
    const { html } = renderStorePage(ID, DESKTOP, config);
    expect(html.match(new RegExp(ID, 'g'))).toHaveLength(2); // canonical and og:url, nothing else
  });

  it.each([
    [IPHONE, 'ios'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'ios'],
    [ANDROID, 'android'],
    [DESKTOP, 'other'],
  ])('reads %p as %s', (agent, platform) => {
    expect(platformOf(agent)).toBe(platform);
  });
});

describe('app link files (research R15)', () => {
  it('builds the Apple file for the customer app, covering /reels/*', () => {
    expect(
      buildAppleAppSiteAssociation({
        teamId: 'ABCDE12345',
        bundleId: 'sa.chinaparts.customer',
      }),
    ).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.sa.chinaparts.customer'],
            components: [{ '/': '/reels/*' }],
            appID: 'ABCDE12345.sa.chinaparts.customer',
            paths: ['/reels/*'],
          },
        ],
      },
    });
  });

  it('builds the Android file with the package and its fingerprints', () => {
    expect(
      buildAssetLinks({
        packageName: 'sa.chinaparts',
        fingerprints: ['AA:BB', 'CC:DD'],
      }),
    ).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'sa.chinaparts',
          sha256_cert_fingerprints: ['AA:BB', 'CC:DD'],
        },
      },
    ]);
  });

  it('reads a comma-separated list of fingerprints', () => {
    expect(parseFingerprints(' AA:BB , CC:DD ,, ')).toEqual(['AA:BB', 'CC:DD']);
    expect(parseFingerprints(undefined)).toEqual([]);
    expect(parseFingerprints('')).toEqual([]);
  });
});

describe('LinksController', () => {
  function setup(values: Record<string, string | undefined>) {
    const sent: {
      type?: string;
      headers: Record<string, string>;
      body?: string;
    } = {
      headers: {},
    };
    const res = {
      req: { headers: { 'user-agent': IPHONE } },
      type(value: string) {
        sent.type = value;
        return this;
      },
      set(name: string, value: string) {
        sent.headers[name] = value;
        return this;
      },
      send(body: string) {
        sent.body = body;
        return this;
      },
    } as unknown as Response;
    const controller = new LinksController({
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService);
    return { controller, res, sent };
  }

  const page = {
    LINKS_PUBLIC_BASE_URL: 'https://reels.example.test/',
    LINKS_PAGE_TITLE: 'China Parts Reels',
    IOS_STORE_URL: config.iosStoreUrl,
    ANDROID_STORE_URL: config.androidStoreUrl,
  };

  it('is public', () => {
    expect(Reflect.getMetadata(ACCESS_KEY, LinksController)).toBe('public');
  });

  it('serves the store page as HTML, for a short time, with the trailing slash of the base URL dropped', () => {
    const { controller, res, sent } = setup(page);

    controller.storePage(ID, res);

    expect(sent.type).toBe('html');
    expect(sent.headers['Cache-Control']).toBe('public, max-age=300');
    expect(sent.body).toContain(
      `href="https://reels.example.test/reels/${ID}"`,
    );
  });

  it.each(['some-id', '%3Cscript%3E', '<script>alert(1)</script>', ''])(
    'answers 404 for %p, before building any page',
    (id) => {
      const { controller, res, sent } = setup(page);

      expect(() => controller.storePage(id, res)).toThrow(NotFoundException);
      expect(sent.body).toBeUndefined();
    },
  );

  it('serves the Apple file as JSON when configured, and 404 when it is not', () => {
    const configured = setup({
      IOS_TEAM_ID: 'ABCDE12345',
      IOS_BUNDLE_ID: 'sa.cp',
    });
    configured.controller.appleAppSiteAssociation(configured.res);
    expect(configured.sent.type).toBe('application/json');
    expect(JSON.parse(configured.sent.body ?? '{}')).toHaveProperty('applinks');

    for (const values of [
      {},
      { IOS_TEAM_ID: 'ABCDE12345' },
      { IOS_BUNDLE_ID: 'sa.cp' },
    ]) {
      const missing = setup(values);
      expect(() =>
        missing.controller.appleAppSiteAssociation(missing.res),
      ).toThrow(NotFoundException);
    }
  });

  it('serves the Android file as JSON when configured, and 404 when it is not', () => {
    const configured = setup({
      ANDROID_PACKAGE_NAME: 'sa.cp',
      ANDROID_CERT_FINGERPRINTS: 'AA:BB,CC:DD',
    });
    configured.controller.assetLinks(configured.res);
    expect(configured.sent.type).toBe('application/json');
    expect(JSON.parse(configured.sent.body ?? '[]')).toHaveLength(1);

    for (const values of [
      {},
      { ANDROID_PACKAGE_NAME: 'sa.cp' },
      { ANDROID_CERT_FINGERPRINTS: 'AA:BB' },
      { ANDROID_PACKAGE_NAME: 'sa.cp', ANDROID_CERT_FINGERPRINTS: ' , ' },
    ]) {
      const missing = setup(values);
      expect(() => missing.controller.assetLinks(missing.res)).toThrow(
        NotFoundException,
      );
    }
  });
});

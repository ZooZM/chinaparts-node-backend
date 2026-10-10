import { ACCESS_KEY } from '../../common/guards/access.decorator';
import {
  ReelsRedirectController,
  renderRedirectPage,
} from './reels-redirect.controller';

describe('ReelsRedirectController', () => {
  it('is public: a shared link opens in a browser with no session (FR-039a)', () => {
    expect(Reflect.getMetadata(ACCESS_KEY, ReelsRedirectController)).toBe(
      'public',
    );
  });
});

describe('renderRedirectPage (FR-039a)', () => {
  it('redirects iPhone user agents to the App Store', () => {
    const { url, html } = renderRedirectPage(
      'reel-1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    );
    expect(url).toContain('apps.apple.com');
    expect(html).toContain('reel-1');
    expect(html).toContain('http-equiv="refresh"');
  });

  it('redirects Android user agents to Google Play', () => {
    const { url } = renderRedirectPage(
      'reel-1',
      'Mozilla/5.0 (Linux; Android 14)',
    );
    expect(url).toContain('play.google.com');
  });

  it('shows a dual-link page (no auto-redirect) for desktop/unknown user agents', () => {
    const { url, html } = renderRedirectPage(
      'reel-1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    );
    expect(url).toBeNull();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain('App Store');
    expect(html).toContain('Google Play');
  });
});

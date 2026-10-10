import { Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { user } from '../../common/guards/testing';
import { FakeRedis } from '../../common/redis/fake-redis.testing';
import type { AccountsService } from './accounts.service';
import { LocaleInterceptor, localeFromHeader } from './locale.interceptor';

function setup() {
  const recordLocale = jest.fn().mockResolvedValue(undefined);
  const redis = new FakeRedis();
  const interceptor = new LocaleInterceptor(
    { recordLocale } as unknown as AccountsService,
    redis.asRedis(),
  );
  const next: CallHandler = { handle: () => of('handled') };
  const run = async (request: Record<string, unknown>) => {
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await interceptor.intercept(context, next);
  };
  return { run, recordLocale, redis };
}

describe('localeFromHeader', () => {
  it.each([
    ['ar', 'ar'],
    ['en', 'en'],
    ['ar-SA,ar;q=0.9,en;q=0.8', 'ar'],
    ['en-US,en;q=0.9,ar;q=0.8', 'en'],
    ['fr-FR,en;q=0.8', 'en'],
    ['AR', 'ar'],
    [' en-GB ', 'en'],
  ])('reads %p as %p', (header, expected) => {
    expect(localeFromHeader(header)).toBe(expected);
  });

  it.each([undefined, '', 'fr-FR', 'de,es;q=0.5', '*'])(
    'finds nothing in %p',
    (header) => {
      expect(localeFromHeader(header)).toBeNull();
    },
  );
});

describe('LocaleInterceptor (FR-065, research R14)', () => {
  const signedIn = user({
    userId: 'u1',
    locale: 'ar',
    accountType: 'seller',
    externalId: 7,
  });

  it('writes the new language when it differs, and updates the cached entry', async () => {
    const { run, recordLocale, redis } = setup();
    await redis.set(
      'auth:acct:seller:7',
      JSON.stringify({
        accountId: 'u1',
        standing: 'good',
        locale: 'ar',
        preferredCurrency: null,
      }),
      'EX',
      60,
    );
    const request = {
      user: { ...signedIn },
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    };

    await run(request);

    expect(recordLocale).toHaveBeenCalledWith('u1', 'en');
    expect(
      JSON.parse((await redis.get('auth:acct:seller:7')) ?? '{}'),
    ).toMatchObject({
      accountId: 'u1',
      locale: 'en',
    });
    expect(request.user.locale).toBe('en');
  });

  it("keeps the cached entry's expiry when it changes it", async () => {
    jest.useFakeTimers();
    try {
      const { run, redis } = setup();
      await redis.set(
        'auth:acct:seller:7',
        JSON.stringify({ locale: 'ar' }),
        'EX',
        60,
      );
      jest.advanceTimersByTime(50_000);

      await run({
        user: { ...signedIn },
        headers: { 'accept-language': 'en' },
      });

      jest.advanceTimersByTime(11_000);
      expect(await redis.get('auth:acct:seller:7')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does nothing when the language has not changed', async () => {
    const { run, recordLocale } = setup();

    await run({
      user: { ...signedIn },
      headers: { 'accept-language': 'ar-SA' },
    });

    expect(recordLocale).not.toHaveBeenCalled();
  });

  it.each([
    ['no header', {}],
    ['a language it does not write in', { 'accept-language': 'fr-FR' }],
  ])(
    'does nothing for %s: the last language stays',
    async (_label, headers) => {
      const { run, recordLocale } = setup();
      await run({ user: { ...signedIn }, headers });
      expect(recordLocale).not.toHaveBeenCalled();
    },
  );

  it('does nothing for a signed-out visitor', async () => {
    const { run, recordLocale } = setup();
    await run({ headers: { 'accept-language': 'en' } });
    expect(recordLocale).not.toHaveBeenCalled();
  });

  it('still writes when the account has no cached entry', async () => {
    const { run, recordLocale } = setup();
    await run({ user: { ...signedIn }, headers: { 'accept-language': 'en' } });
    expect(recordLocale).toHaveBeenCalledWith('u1', 'en');
  });

  it('never fails the request when the write fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { run, recordLocale } = setup();
    recordLocale.mockRejectedValue(new Error('mongo is down'));

    await expect(
      run({ user: { ...signedIn }, headers: { 'accept-language': 'en' } }),
    ).resolves.toBeUndefined();
  });
});

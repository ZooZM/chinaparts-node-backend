import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { Access, RateLimitClass, SkipRateLimit } from './access.decorator';
import { IdentityThrottlerGuard } from './identity-throttler.guard';
import { IpThrottlerGuard } from './ip-throttler.guard';
import { httpContext, user, route } from './testing';

const CONFIG: Record<string, number> = {
  IP_RATE_LIMIT_PER_MINUTE: 3,
  USER_RATE_LIMIT_PER_MINUTE: 4,
  GUEST_RATE_LIMIT_PER_MINUTE: 2,
  UPLOAD_RATE_LIMIT_PER_HOUR: 1,
  WRITE_RATE_LIMIT_PER_MINUTE: 2,
};

/** A counter store with the same contract as the Redis one: hits above `limit` are blocked. */
class FakeStorage implements ThrottlerStorage {
  readonly calls: Array<{
    key: string;
    ttl: number;
    limit: number;
    name: string;
  }> = [];
  private readonly counters = new Map<string, number>();

  increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    name: string,
  ) {
    this.calls.push({ key, ttl, limit, name });
    const id = `${name}:${key}`;
    const hits = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, hits);
    return Promise.resolve({
      totalHits: hits,
      timeToExpire: 42,
      isBlocked: hits > limit,
      timeToBlockExpire: 0,
    });
  }
}

class Controller {
  @Access('signed-in')
  signedIn(): void {}

  @Access('optional')
  optional(): void {}

  @Access('public')
  publicRoute(): void {}

  @Access('admin')
  admin(): void {}

  @Access('seller')
  @RateLimitClass('upload')
  upload(): void {}

  @Access('signed-in')
  @RateLimitClass('write')
  write(): void {}

  @SkipRateLimit()
  @Access('public')
  health(): void {}
}

function setup() {
  const storage = new FakeStorage();
  const config = {
    getOrThrow: (key: string) => CONFIG[key],
  } as unknown as ConfigService;
  const reflector = new Reflector();
  return {
    storage,
    ip: new IpThrottlerGuard(storage, config, reflector),
    identity: new IdentityThrottlerGuard(storage, config, reflector),
  };
}

function ctx(request: Record<string, unknown>, handler: () => void) {
  const response = { setHeader: jest.fn() };
  return {
    context: httpContext({
      request,
      response,
      handler,
      controller: Controller,
    }),
    response,
  };
}

async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
}

describe('IpThrottlerGuard (research R10, guard 1)', () => {
  it('counts every request by client IP, against the configured per-minute limit', async () => {
    const { ip, storage } = setup();
    const { context } = ctx(
      { ip: '203.0.113.7' },
      route(Controller, 'signedIn'),
    );

    await ip.canActivate(context);

    expect(storage.calls).toEqual([
      { key: '203.0.113.7', ttl: 60_000, limit: 3, name: 'ip' },
    ]);
  });

  it('allows up to the limit, then answers 429 RATE_LIMITED with Retry-After', async () => {
    const { ip } = setup();
    const request = { ip: '203.0.113.7' };
    for (let hit = 0; hit < 3; hit++) {
      const { context } = ctx(request, route(Controller, 'signedIn'));
      await expect(ip.canActivate(context)).resolves.toBe(true);
    }

    const { context, response } = ctx(request, route(Controller, 'signedIn'));
    const error = await ip.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: 'RATE_LIMITED',
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('counts each IP separately', async () => {
    const { ip } = setup();
    for (let hit = 0; hit < 3; hit++) {
      await ip.canActivate(
        ctx({ ip: '1.1.1.1' }, route(Controller, 'signedIn')).context,
      );
    }
    await expect(
      ip.canActivate(
        ctx({ ip: '2.2.2.2' }, route(Controller, 'signedIn')).context,
      ),
    ).resolves.toBe(true);
  });

  it('applies to public routes too, which only have this limit', async () => {
    const { ip, storage } = setup();
    await ip.canActivate(
      ctx({ ip: '1.1.1.1' }, route(Controller, 'publicRoute')).context,
    );
    expect(storage.calls).toHaveLength(1);
  });

  it('skips routes marked @SkipRateLimit (health checks)', async () => {
    const { ip, storage } = setup();
    for (let hit = 0; hit < 10; hit++) {
      await ip.canActivate(
        ctx({ ip: '1.1.1.1' }, route(Controller, 'health')).context,
      );
    }
    expect(storage.calls).toHaveLength(0);
  });

  it('uses a placeholder when the IP is unknown', async () => {
    const { ip, storage } = setup();
    await ip.canActivate(ctx({}, route(Controller, 'signedIn')).context);
    expect(storage.calls[0].key).toBe('unknown');
  });
});

describe('IdentityThrottlerGuard (research R10, guard 3)', () => {
  it('counts a signed-in caller by account', async () => {
    const { identity, storage } = setup();
    await identity.canActivate(
      ctx(
        { user: user({ userId: 'u1' }), ip: '1.1.1.1' },
        route(Controller, 'signedIn'),
      ).context,
    );
    expect(storage.calls).toEqual([
      { key: 'u1', ttl: 60_000, limit: 4, name: 'user' },
    ]);
  });

  it('counts a guest by installation id plus IP (FR-004b)', async () => {
    const { identity, storage } = setup();
    await identity.canActivate(
      ctx(
        { installationId: 'inst-1', ip: '1.1.1.1' },
        route(Controller, 'optional'),
      ).context,
    );
    expect(storage.calls).toEqual([
      { key: 'inst-1:1.1.1.1', ttl: 60_000, limit: 2, name: 'guest' },
    ]);
  });

  it('counts a guest with no installation id under "none"', async () => {
    const { identity, storage } = setup();
    await identity.canActivate(
      ctx({ ip: '1.1.1.1' }, route(Controller, 'optional')).context,
    );
    expect(storage.calls[0].key).toBe('none:1.1.1.1');
  });

  it('limits a guest to the configured number a minute, then 429', async () => {
    const { identity } = setup();
    const request = { installationId: 'inst-1', ip: '1.1.1.1' };
    expect(
      await status(
        identity.canActivate(
          ctx(request, route(Controller, 'optional')).context,
        ),
      ),
    ).toBe('ok');
    expect(
      await status(
        identity.canActivate(
          ctx(request, route(Controller, 'optional')).context,
        ),
      ),
    ).toBe('ok');
    expect(
      await status(
        identity.canActivate(
          ctx(request, route(Controller, 'optional')).context,
        ),
      ),
    ).toBe(429);
  });

  it('keeps two accounts behind one IP apart', async () => {
    const { identity } = setup();
    for (let hit = 0; hit < 4; hit++) {
      await identity.canActivate(
        ctx(
          { user: user({ userId: 'a' }), ip: '9.9.9.9' },
          route(Controller, 'signedIn'),
        ).context,
      );
    }
    expect(
      await status(
        identity.canActivate(
          ctx(
            { user: user({ userId: 'a' }), ip: '9.9.9.9' },
            route(Controller, 'signedIn'),
          ).context,
        ),
      ),
    ).toBe(429);
    expect(
      await status(
        identity.canActivate(
          ctx(
            { user: user({ userId: 'b' }), ip: '9.9.9.9' },
            route(Controller, 'signedIn'),
          ).context,
        ),
      ),
    ).toBe('ok');
  });

  describe('named limits', () => {
    it('adds the upload limit by the hour, on top of the general one', async () => {
      const { identity, storage } = setup();
      await identity.canActivate(
        ctx(
          { user: user({ userId: 'u1', accountType: 'seller' }) },
          route(Controller, 'upload'),
        ).context,
      );
      expect(storage.calls.map((call) => call.name)).toEqual([
        'user',
        'upload',
      ]);
      expect(storage.calls[1]).toMatchObject({
        key: 'u1',
        ttl: 3_600_000,
        limit: 1,
      });
    });

    it('refuses the second upload within the hour', async () => {
      const { identity } = setup();
      const request = { user: user({ userId: 'u1', accountType: 'seller' }) };
      expect(
        await status(
          identity.canActivate(
            ctx(request, route(Controller, 'upload')).context,
          ),
        ),
      ).toBe('ok');
      expect(
        await status(
          identity.canActivate(
            ctx(request, route(Controller, 'upload')).context,
          ),
        ),
      ).toBe(429);
    });

    it('adds the write limit by the minute', async () => {
      const { identity, storage } = setup();
      await identity.canActivate(
        ctx({ user: user({ userId: 'u1' }) }, route(Controller, 'write'))
          .context,
      );
      expect(storage.calls[1]).toMatchObject({
        name: 'write',
        ttl: 60_000,
        limit: 2,
      });
    });

    it('refuses the third write within the minute', async () => {
      const { identity } = setup();
      const request = { user: user({ userId: 'u1' }) };
      await identity.canActivate(
        ctx(request, route(Controller, 'write')).context,
      );
      await identity.canActivate(
        ctx(request, route(Controller, 'write')).context,
      );
      expect(
        await status(
          identity.canActivate(
            ctx(request, route(Controller, 'write')).context,
          ),
        ),
      ).toBe(429);
    });

    it('does not apply to a route without a named limit', async () => {
      const { identity, storage } = setup();
      await identity.canActivate(
        ctx({ user: user() }, route(Controller, 'signedIn')).context,
      );
      expect(storage.calls.map((call) => call.name)).toEqual(['user']);
    });
  });

  it('does not count public or admin routes, which only pass the IP limit', async () => {
    const { identity, storage } = setup();
    await identity.canActivate(
      ctx({ ip: '1.1.1.1' }, route(Controller, 'publicRoute')).context,
    );
    await identity.canActivate(
      ctx({ ip: '1.1.1.1' }, route(Controller, 'admin')).context,
    );
    expect(storage.calls).toHaveLength(0);
  });

  it('skips routes marked @SkipRateLimit', async () => {
    const { identity, storage } = setup();
    await identity.canActivate(ctx({}, route(Controller, 'health')).context);
    expect(storage.calls).toHaveLength(0);
  });

  it('treats a route with no @Access as signed-in, so it is still counted', async () => {
    const { identity, storage } = setup();
    class Plain {
      route(): void {}
    }
    const context = httpContext({
      request: { user: user({ userId: 'u9' }) },
      handler: route(Plain, 'route'),
      controller: Plain,
    });
    await identity.canActivate(context);
    expect(storage.calls[0]).toMatchObject({ name: 'user', key: 'u9' });
  });
});

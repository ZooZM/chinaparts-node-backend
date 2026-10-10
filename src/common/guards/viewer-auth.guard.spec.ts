import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../http/viewer-request';
import { Access } from './access.decorator';
import type { RequestAuthenticator } from './request-authenticator';
import { httpContext, user, route } from './testing';
import { ViewerAuthGuard } from './viewer-auth.guard';

@Access('optional')
class OptionalController {
  inherits(): void {}

  @Access('seller')
  seller(): void {}

  @Access('public')
  publicRoute(): void {}

  @Access('admin')
  admin(): void {}
}

class UndecoratedController {
  route(): void {}
}

const VALID_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

function setup(
  options: {
    adminKey?: string;
    authenticate?: (
      request: Record<string, unknown>,
    ) => Promise<AuthenticatedUser>;
  } = {},
) {
  const authenticate = jest.fn(
    (context: Parameters<RequestAuthenticator['authenticate']>[0]) => {
      const request = context
        .switchToHttp()
        .getRequest<Record<string, unknown>>();
      return (options.authenticate ?? (() => Promise.resolve(user())))(request);
    },
  );
  const guard = new ViewerAuthGuard(
    new Reflector(),
    { get: () => options.adminKey } as unknown as ConfigService,
    { authenticate },
  );
  return { guard, authenticate };
}

function call(
  guard: ViewerAuthGuard,
  request: Record<string, unknown>,
  handler: () => void,
  controller: abstract new (
    ...args: never[]
  ) => unknown = UndecoratedController,
) {
  return guard.canActivate(httpContext({ request, handler, controller }));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error: unknown) => error,
  );
}

describe('ViewerAuthGuard (research R10)', () => {
  describe('the default level', () => {
    it('is signed-in: a route without @Access refuses a guest (fails closed)', async () => {
      const { guard } = setup();
      const error = await rejection(
        call(guard, { headers: {} }, route(UndecoratedController, 'route')),
      );
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        error: 'AUTH_REQUIRED',
      });
    });

    it('lets a signed-in caller through and sets request.user', async () => {
      const { guard } = setup();
      const request = { headers: { authorization: 'Bearer 1|x' } };
      await expect(
        call(guard, request, route(UndecoratedController, 'route')),
      ).resolves.toBe(true);
      expect((request as { user?: AuthenticatedUser }).user).toEqual(user());
    });
  });

  describe('optional routes', () => {
    it('admit a guest without asking the authenticator', async () => {
      const { guard, authenticate } = setup();
      const request: Record<string, unknown> = { headers: {} };
      await expect(
        call(
          guard,
          request,
          route(OptionalController, 'inherits'),
          OptionalController,
        ),
      ).resolves.toBe(true);
      expect(request.user).toBeUndefined();
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('validate a header that is present, and refuse it when invalid (FR-004a)', async () => {
      const { guard } = setup({
        authenticate: () =>
          Promise.reject(
            new UnauthorizedException({
              error: 'AUTH_INVALID_SESSION',
              message: 'x',
            }),
          ),
      });
      const error = await rejection(
        call(
          guard,
          { headers: { authorization: 'Bearer stale' } },
          route(OptionalController, 'inherits'),
          OptionalController,
        ),
      );
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        error: 'AUTH_INVALID_SESSION',
      });
    });

    it('treat an empty Authorization header as present, not as a guest', async () => {
      const { guard, authenticate } = setup();
      await call(
        guard,
        { headers: { authorization: '' } },
        route(OptionalController, 'inherits'),
        OptionalController,
      );
      expect(authenticate).toHaveBeenCalledTimes(1);
    });

    it('pass an outage through as a 503, so it never looks like a sign-out', async () => {
      const outage = new ServiceUnavailableException({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'down',
      });
      const { guard } = setup({ authenticate: () => Promise.reject(outage) });
      expect(
        await rejection(
          call(
            guard,
            { headers: { authorization: 'Bearer ok' } },
            route(OptionalController, 'inherits'),
            OptionalController,
          ),
        ),
      ).toBe(outage);
    });
  });

  describe('signed-in and seller routes', () => {
    it('refuse a guest on a seller route with AUTH_REQUIRED, not a 403', async () => {
      const { guard } = setup();
      const error = await rejection(
        call(
          guard,
          { headers: {} },
          route(OptionalController, 'seller'),
          OptionalController,
        ),
      );
      expect(error).toBeInstanceOf(UnauthorizedException);
    });

    it('refuse a customer on a seller route with REELS_SELLERS_ONLY (FR-025)', async () => {
      const { guard } = setup({
        authenticate: () => Promise.resolve(user({ accountType: 'customer' })),
      });
      const error = await rejection(
        call(
          guard,
          { headers: { authorization: 'Bearer c' } },
          route(OptionalController, 'seller'),
          OptionalController,
        ),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        error: 'REELS_SELLERS_ONLY',
      });
    });

    it('admit a seller, even one who is suspended (standing is a later guard)', async () => {
      const { guard } = setup({
        authenticate: () =>
          Promise.resolve(
            user({ accountType: 'seller', standing: 'suspended' }),
          ),
      });
      await expect(
        call(
          guard,
          { headers: { authorization: 'Bearer s' } },
          route(OptionalController, 'seller'),
          OptionalController,
        ),
      ).resolves.toBe(true);
    });
  });

  describe('public routes', () => {
    it('never ask the authenticator, even when a header is sent', async () => {
      const { guard, authenticate } = setup();
      await expect(
        call(
          guard,
          { headers: { authorization: 'Bearer anything' } },
          route(OptionalController, 'publicRoute'),
          OptionalController,
        ),
      ).resolves.toBe(true);
      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  describe('X-Installation-Id', () => {
    const run = async (header: unknown) => {
      const { guard } = setup();
      const request: Record<string, unknown> = {
        headers: header === undefined ? {} : { 'x-installation-id': header },
      };
      await call(
        guard,
        request,
        route(OptionalController, 'inherits'),
        OptionalController,
      );
      return request.installationId;
    };

    it('is read when it is a valid UUID v4', async () => {
      expect(await run(VALID_ID)).toBe(VALID_ID);
      expect(await run(VALID_ID.toUpperCase())).toBe(VALID_ID.toUpperCase());
    });

    it.each([
      ['not a uuid', 'not-a-uuid'],
      ['a UUID v1', '3f2b8c1e-4d5a-1b6c-8d7e-9f0a1b2c3d4e'],
      ['a bad variant', '3f2b8c1e-4d5a-4b6c-ce7e-9f0a1b2c3d4e'],
      ['empty', ''],
      ['an array of values', [VALID_ID, VALID_ID]],
      ['too long', `${VALID_ID}0`],
    ])('is ignored when it is %s', async (_label, header) => {
      expect(await run(header)).toBeUndefined();
    });

    it('is also read for a signed-in caller', async () => {
      const { guard } = setup();
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer x', 'x-installation-id': VALID_ID },
      };
      await call(guard, request, route(UndecoratedController, 'route'));
      expect(request.installationId).toBe(VALID_ID);
    });
  });

  describe('admin routes (FR-059)', () => {
    const adminCall = (
      guard: ViewerAuthGuard,
      headers: Record<string, unknown>,
    ) =>
      call(
        guard,
        { headers },
        route(OptionalController, 'admin'),
        OptionalController,
      );

    it('accept the right key', async () => {
      const { guard } = setup({ adminKey: 'secret' });
      await expect(adminCall(guard, { 'x-admin-key': 'secret' })).resolves.toBe(
        true,
      );
    });

    it.each([
      ['a missing key', {}],
      ['a wrong key', { 'x-admin-key': 'wrong' }],
      ['a key of a different length', { 'x-admin-key': 'secret-and-more' }],
      ['an empty key', { 'x-admin-key': '' }],
      ['a repeated header', { 'x-admin-key': ['secret', 'secret'] }],
    ])('refuse %s with ADMIN_KEY_INVALID', async (_label, headers) => {
      const { guard } = setup({ adminKey: 'secret' });
      const error = await rejection(adminCall(guard, headers));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        error: 'ADMIN_KEY_INVALID',
      });
    });

    it.each([undefined, ''])(
      'fail closed when ADMIN_API_KEY is %p',
      async (adminKey) => {
        const { guard } = setup({ adminKey });
        const error = await rejection(
          adminCall(guard, { 'x-admin-key': 'anything' }),
        );
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect((error as UnauthorizedException).getResponse()).toMatchObject({
          message: 'The operator surface is not configured',
        });
      },
    );

    it('ignore a user session: a valid bearer token grants nothing', async () => {
      const { guard, authenticate } = setup({ adminKey: 'secret' });
      const error = await rejection(
        adminCall(guard, { authorization: 'Bearer valid-user-token' }),
      );
      expect(error).toBeInstanceOf(HttpException);
      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  it('lets a non-HTTP context through untouched', async () => {
    const { guard } = setup();
    const context = { getType: () => 'ws' } as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

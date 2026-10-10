import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Access, StandingExempt } from './access.decorator';
import { GoodStandingGuard } from './good-standing.guard';
import { httpContext, user, route } from './testing';

class Controller {
  write(): void {}

  @StandingExempt()
  exempt(): void {}
}

@StandingExempt()
class ExemptController {
  write(): void {}
}

class Unrelated {
  @Access('signed-in')
  route(): void {}
}

const guard = new GoodStandingGuard(new Reflector());

function run(
  request: Record<string, unknown>,
  handler: () => void = route(Controller, 'write'),
  controller: abstract new (...args: never[]) => unknown = Controller,
): boolean {
  return guard.canActivate(httpContext({ request, handler, controller }));
}

describe('GoodStandingGuard (FR-008)', () => {
  it('lets a writer in good standing through', () => {
    expect(run({ method: 'POST', user: user() })).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a %s by an account that is not in good standing',
    (method) => {
      expect(() =>
        run({ method, user: user({ standing: 'suspended' }) }),
      ).toThrow(ForbiddenException);
    },
  );

  it('names the sentinel the apps branch on', () => {
    try {
      run({ method: 'POST', user: user({ standing: 'suspended' }) });
      fail('expected a 403');
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        error: 'ACCOUNT_NOT_IN_GOOD_STANDING',
      });
    }
  });

  it('refuses a deleted account as well', () => {
    expect(() =>
      run({ method: 'POST', user: user({ standing: 'deleted' }) }),
    ).toThrow(ForbiddenException);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'lets a suspended account read: %s',
    (method) => {
      expect(run({ method, user: user({ standing: 'suspended' }) })).toBe(true);
    },
  );

  it('does not apply to guests', () => {
    expect(run({ method: 'POST' })).toBe(true);
    expect(run({ method: 'POST', user: undefined })).toBe(true);
  });

  it('lets a suspended account use a @StandingExempt route (delete own reel, view, own comment)', () => {
    expect(
      run(
        { method: 'DELETE', user: user({ standing: 'suspended' }) },
        route(Controller, 'exempt'),
      ),
    ).toBe(true);
  });

  it('honours @StandingExempt on the class too', () => {
    expect(
      run(
        { method: 'POST', user: user({ standing: 'suspended' }) },
        route(ExemptController, 'write'),
        ExemptController,
      ),
    ).toBe(true);
  });

  it('is not loosened by unrelated metadata', () => {
    expect(() =>
      run(
        { method: 'POST', user: user({ standing: 'suspended' }) },
        route(Unrelated, 'route'),
        Unrelated,
      ),
    ).toThrow(ForbiddenException);
  });

  it('ignores non-HTTP contexts', () => {
    expect(guard.canActivate({ getType: () => 'ws' } as never)).toBe(true);
  });
});

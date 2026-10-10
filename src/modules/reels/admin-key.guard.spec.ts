import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AdminKeyGuard } from './admin-key.guard';

function contextWithHeader(headerValue: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-admin-key': headerValue } }),
    }),
  } as unknown as ExecutionContext;
}

function configWithKey(value: string | undefined): ConfigService {
  return { get: jest.fn(() => value) } as unknown as ConfigService;
}

describe('AdminKeyGuard (FR-071, v4)', () => {
  it('fails closed when ADMIN_API_KEY is unset', () => {
    const guard = new AdminKeyGuard(configWithKey(undefined));
    expect(() => guard.canActivate(contextWithHeader('anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when ADMIN_API_KEY is an empty string', () => {
    const guard = new AdminKeyGuard(configWithKey(''));
    expect(() => guard.canActivate(contextWithHeader('anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing x-admin-key header', () => {
    const guard = new AdminKeyGuard(configWithKey('secret'));
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong x-admin-key header', () => {
    const guard = new AdminKeyGuard(configWithKey('secret'));
    expect(() => guard.canActivate(contextWithHeader('wrong'))).toThrow(
      UnauthorizedException,
    );
  });

  it('allows the request through when the header matches', () => {
    const guard = new AdminKeyGuard(configWithKey('secret'));
    expect(guard.canActivate(contextWithHeader('secret'))).toBe(true);
  });
});

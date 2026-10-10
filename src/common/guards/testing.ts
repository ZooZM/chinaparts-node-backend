import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../http/viewer-request';

type Target = (...args: never[]) => unknown;

/** Builds a fake HTTP `ExecutionContext` whose handler and class carry real decorator metadata. */
export function httpContext(options: {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  handler?: Target;
  controller?: Target | (abstract new (...args: never[]) => unknown);
}): ExecutionContext {
  const request = options.request ?? {};
  const response = options.response ?? { setHeader: jest.fn() };
  return {
    getType: () => 'http',
    getHandler: () => options.handler ?? (() => undefined),
    getClass: () => options.controller ?? class Anonymous {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

export function user(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    userId: '650000000000000000000001',
    accountType: 'customer',
    externalId: 1,
    standing: 'good',
    locale: 'ar',
    preferredCurrency: null,
    ...overrides,
  };
}

/**
 * The handler function of a controller method, looked up by name. Specs need the function itself
 * (to read its decorator metadata), and `Controller.prototype.method` would be an unbound method
 * reference.
 */
export function route(controller: { prototype: object }, name: string): Target {
  const value: unknown = Object.getOwnPropertyDescriptor(
    controller.prototype,
    name,
  )?.value;
  if (typeof value !== 'function') {
    throw new Error(`${controller.constructor.name} has no route ${name}`);
  }
  return value as Target;
}

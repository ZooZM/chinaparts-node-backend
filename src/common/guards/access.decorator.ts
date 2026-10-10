import { SetMetadata } from '@nestjs/common';

/**
 * How a route is reached (contracts/rest-api.md, "Access levels"):
 * - `public`: no authentication (links, health)
 * - `optional`: signed-out visitors allowed, and a present but invalid header is a 401 (FR-004a)
 * - `signed-in`: a valid China Parts session
 * - `seller`: signed-in with a seller account
 * - `admin`: the operator key only; no user session is accepted (FR-059)
 *
 * A route without one is `signed-in`, so a forgotten annotation fails closed (research R10).
 */
export type AccessLevel =
  'public' | 'optional' | 'signed-in' | 'seller' | 'admin';

export const ACCESS_KEY = 'reels:access';
export const STANDING_EXEMPT_KEY = 'reels:standing-exempt';
export const RATE_LIMIT_CLASS_KEY = 'reels:rate-limit-class';
export const SKIP_RATE_LIMIT_KEY = 'reels:skip-rate-limit';

export const Access = (level: AccessLevel): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, level);

/**
 * Lets an account that is not in good standing call this write route (FR-008): deleting one's own
 * reel, recording a view, and deleting a comment (where the service applies the rest of the rule).
 */
export const StandingExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(STANDING_EXEMPT_KEY, true);

/** A tighter, named limit on top of the general per-account one. */
export type RateLimitClassName = 'upload' | 'write';
export const RateLimitClass = (
  name: RateLimitClassName,
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_CLASS_KEY, name);

/** For routes that must never be throttled, such as health checks. */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);

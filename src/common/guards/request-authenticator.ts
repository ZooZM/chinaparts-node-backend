import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../http/viewer-request';

/** Injection token for whatever turns an `Authorization` header into a signed-in caller. */
export const REQUEST_AUTHENTICATOR = Symbol('REQUEST_AUTHENTICATOR');

/**
 * Keeps `common/` free of any knowledge about China Parts (constitution I): the guard chain asks
 * an authenticator, and the accounts module supplies the one that validates Sanctum tokens.
 *
 * Contract: resolves with the caller, or throws `401 AUTH_INVALID_SESSION` for a token that does
 * not validate, or `503 UPSTREAM_UNAVAILABLE` when it could not be verified (never a 401 then).
 */
export interface RequestAuthenticator {
  authenticate(context: ExecutionContext): Promise<AuthenticatedUser>;
}

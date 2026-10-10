import type { Request } from 'express';

export type AccountType = 'customer' | 'seller';
export type Standing = 'good' | 'suspended' | 'deleted';
export type Locale = 'ar' | 'en';

/**
 * The caller, as resolved from a valid China Parts session. `userId` is the reels account's
 * ObjectId (a string), the same id every ported controller already passes around. `externalId`
 * is the China Parts number, which is only unique together with `accountType` (FR-006).
 */
export interface AuthenticatedUser {
  userId: string;
  accountType: AccountType;
  externalId: number;
  standing: Standing;
  locale: Locale;
  /** Three-letter code, or null for "use the base currency" (FR-036). */
  preferredCurrency: string | null;
}

/** A request on a route that requires a session. */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  installationId?: string;
}

/** A request on a route that also admits signed-out visitors. */
export interface ViewerRequest extends Request {
  user?: AuthenticatedUser;
  installationId?: string;
}

/** What a service needs to know about whoever is calling: possibly nobody, possibly an install. */
export interface ViewerContext {
  user?: AuthenticatedUser;
  installationId?: string;
}

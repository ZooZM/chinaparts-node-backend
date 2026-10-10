/**
 * Every error the service returns carries one of these sentinels in the `error` field of the
 * response envelope (research R25, contracts/rest-api.md "Error sentinels").
 *
 * They are load-bearing (constitution IV): the China Parts apps branch on them. Rename or
 * remove one only together with the consuming apps.
 */
export enum ErrorCode {
  // 400 and other validation failures
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_CURSOR = 'INVALID_CURSOR',
  VIDEO_REQUIRED = 'VIDEO_REQUIRED',
  VIDEO_TOO_LONG = 'VIDEO_TOO_LONG',
  VIDEO_DURATION_UNREADABLE = 'VIDEO_DURATION_UNREADABLE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  PRODUCT_NOT_ATTACHABLE = 'PRODUCT_NOT_ATTACHABLE',
  TOO_MANY_PRODUCTS = 'TOO_MANY_PRODUCTS',
  CANNOT_FOLLOW_SELF = 'CANNOT_FOLLOW_SELF',
  CANNOT_BLOCK_SELF = 'CANNOT_BLOCK_SELF',
  CANNOT_REPORT_OWN_REEL = 'CANNOT_REPORT_OWN_REEL',
  CANNOT_REPORT_OWN_COMMENT = 'CANNOT_REPORT_OWN_COMMENT',
  CANNOT_REPOST_OWN_REEL = 'CANNOT_REPOST_OWN_REEL',

  // 401
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  AUTH_INVALID_SESSION = 'AUTH_INVALID_SESSION',
  ADMIN_KEY_INVALID = 'ADMIN_KEY_INVALID',

  // 403
  ACCOUNT_NOT_IN_GOOD_STANDING = 'ACCOUNT_NOT_IN_GOOD_STANDING',
  REELS_SELLERS_ONLY = 'REELS_SELLERS_ONLY',
  NOT_REEL_OWNER = 'NOT_REEL_OWNER',
  COMMENT_NOT_DELETABLE = 'COMMENT_NOT_DELETABLE',

  // 404
  REEL_NOT_FOUND = 'REEL_NOT_FOUND',
  COMMENT_NOT_FOUND = 'COMMENT_NOT_FOUND',
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  PRODUCT_LINK_NOT_FOUND = 'PRODUCT_LINK_NOT_FOUND',

  // 409
  USERNAME_TAKEN = 'USERNAME_TAKEN',
  REEL_NOT_HIDDEN = 'REEL_NOT_HIDDEN',

  // 413
  VIDEO_TOO_LARGE = 'VIDEO_TOO_LARGE',

  // 429
  REPORT_DAILY_LIMIT = 'REPORT_DAILY_LIMIT',
  RATE_LIMITED = 'RATE_LIMITED',

  // 5xx
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UPSTREAM_UNAVAILABLE = 'UPSTREAM_UNAVAILABLE',
  NOT_READY = 'NOT_READY',

  // Generic fallbacks for errors raised by the framework itself (unknown route, wrong verb).
  // Application code never throws these; it always picks a specific sentinel above.
  BAD_REQUEST = 'BAD_REQUEST',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  CONFLICT = 'CONFLICT',
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

/**
 * Whether a write failed because of a unique index (MongoDB error 11000). Callers use it for
 * idempotent inserts: a duplicate means "already there", while any other error is a real failure
 * that must not be swallowed.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/** The index fields behind a duplicate-key error, for example `['usernameNormalized']`. */
export function duplicateKeyFields(error: unknown): string[] {
  if (!isDuplicateKeyError(error)) return [];
  const pattern = (error as { keyPattern?: unknown }).keyPattern;
  return typeof pattern === 'object' && pattern !== null
    ? Object.keys(pattern)
    : [];
}

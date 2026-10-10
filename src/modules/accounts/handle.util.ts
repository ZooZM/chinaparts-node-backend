import type { AccountType } from '../../common/http/viewer-request';

const MAX_LENGTH = 30;
const MIN_LENGTH = 3;

/** Letters (any script), combining marks, digits, underscore and period (research R6). */
const DISALLOWED = /[^\p{L}\p{M}\p{N}_.]/gu;
const EDGES = /^[_.]+|[_.]+$/g;
const HANDLE = /^[\p{L}\p{M}\p{N}_.]{3,30}$/u;

function length(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/**
 * The starting point for an automatic handle (FR-015): the public name with spaces turned into
 * underscores and everything else not allowed stripped, so an Arabic-only shop name stays Arabic.
 * Too short a result falls back to `shop` for sellers or `user` for customers.
 */
export function generateHandleBase(
  name: string,
  accountType: AccountType,
): string {
  const cleaned = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(DISALLOWED, '')
    .replace(/_{2,}/g, '_')
    .replace(EDGES, '');
  const base = truncate(cleaned, MAX_LENGTH).replace(EDGES, '');
  if (length(base) >= MIN_LENGTH) return base;
  return accountType === 'seller' ? 'shop' : 'user';
}

/** A handle someone may choose: 3 to 30 letters, marks, digits, `_` or `.`. */
export function isValidHandle(value: string): boolean {
  return HANDLE.test(value);
}

/**
 * `base` with a suffix that keeps the whole handle within 30 characters: ("Sara", "_2") gives
 * "Sara_2", and a 30-character base is cut to make room.
 */
export function withSuffix(base: string, suffix: string): string {
  return truncate(base, MAX_LENGTH - length(suffix)) + suffix;
}

import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../../common/errors/error-codes';

/**
 * The cursor of a list whose order is computed rather than stored (research R9): account search
 * ranks by exact match and then by follower count, which has no stable keyset, so a page is "this
 * many places down a short, capped list". It is the only list that pages this way.
 */

/** Far beyond the 200 results search serves, so a hand-made huge offset is refused, not served. */
const MAX_OFFSET = 10_000;

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

/** The offset a cursor carries; 0 for no cursor. Throws `400 INVALID_CURSOR` for anything else. */
export function decodeOffsetCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (raw.length === 0 || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid();
  }
  const offset = (value as Record<string, unknown>).o;
  if (
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > MAX_OFFSET
  ) {
    throw invalid();
  }
  return offset;
}

function invalid(): BadRequestException {
  return new BadRequestException({
    error: ErrorCode.INVALID_CURSOR,
    message: 'Invalid cursor',
  });
}

import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../../common/errors/error-codes';
import { decodeOffsetCursor, encodeOffsetCursor } from './offset-cursor';

function rejection(cursor: string): BadRequestException {
  try {
    decodeOffsetCursor(cursor);
  } catch (error) {
    if (error instanceof BadRequestException) return error;
    throw error;
  }
  throw new Error(`Cursor was accepted: ${cursor}`);
}

const hand = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

describe('offset cursor (research R9, account search)', () => {
  it('starts at zero when there is no cursor', () => {
    expect(decodeOffsetCursor(undefined)).toBe(0);
  });

  it('round-trips an offset, as URL-safe text', () => {
    for (const offset of [0, 1, 25, 175, 200]) {
      const cursor = encodeOffsetCursor(offset);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeOffsetCursor(cursor)).toBe(offset);
    }
  });

  it.each([
    ['an empty value', ''],
    ['characters outside the alphabet', 'not a cursor!'],
    ['a bare number, as the old scheme wrote it', '25'],
    ['text that is not JSON', hand('plain text')],
    ['JSON that is not an object', hand([1])],
    ['no offset', hand({})],
    ['a negative offset', hand({ o: -1 })],
    ['a fractional offset', hand({ o: 1.5 })],
    ['a text offset', hand({ o: '5' })],
    ['an offset beyond anything search serves', hand({ o: 1_000_000 })],
    ['a feed cursor', hand({ p: 0, t: 1, i: '650000000000000000000001' })],
  ])('refuses %s as 400 INVALID_CURSOR', (_label, cursor) => {
    const error = rejection(cursor);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({
      error: ErrorCode.INVALID_CURSOR,
    });
  });
});

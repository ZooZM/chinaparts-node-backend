import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  decodeFeedCursor,
  decodeListCursor,
  encodeFeedCursor,
  FEED_TOP,
  MAX_INJECTED,
} from './feed-cursor';

const ID = '650000000000000000000001';

function fakeIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    (0x650000000000000000000000 + index).toString(16).padStart(24, '0'),
  );
}

/** A cursor built by hand the way a client could: the header JSON, and optionally raw id bytes. */
function handMade(header: unknown, injected?: Buffer): string {
  const encoded = Buffer.from(
    typeof header === 'string' ? header : JSON.stringify(header),
  ).toString('base64url');
  return injected === undefined
    ? encoded
    : `${encoded}.${injected.toString('base64url')}`;
}

function rejectionOf(decode: () => unknown): BadRequestException {
  try {
    decode();
  } catch (error) {
    if (error instanceof BadRequestException) return error;
    throw error;
  }
  throw new Error('The cursor was accepted');
}

function rejection(cursor: string): BadRequestException {
  return rejectionOf(() => decodeFeedCursor(cursor));
}

describe('feed cursor (research R9)', () => {
  describe('round trip', () => {
    it('keeps the pass and the keyset position', () => {
      const createdAt = new Date('2026-10-01T10:20:30.456Z');
      const decoded = decodeFeedCursor(
        encodeFeedCursor({ pass: 2, createdAt, id: ID }),
      );

      expect(decoded.pass).toBe(2);
      expect(decoded.createdAt).toEqual(createdAt);
      expect(decoded.id).toBe(ID);
      expect(decoded.injected).toEqual([]);
    });

    it('keeps the injected ids, in order', () => {
      const injected = fakeIds(7);
      const decoded = decodeFeedCursor(
        encodeFeedCursor({
          pass: 0,
          createdAt: new Date(1_700_000_000_000),
          id: ID,
          injected,
        }),
      );
      expect(decoded.injected).toEqual(injected);
    });

    it('is URL safe (letters, digits, - _ and .), so it needs no escaping in a query string', () => {
      const cursor = encodeFeedCursor({
        pass: 0,
        createdAt: new Date(1_700_000_000_000),
        id: ID,
        injected: fakeIds(MAX_INJECTED),
      });
      expect(cursor).toMatch(/^[A-Za-z0-9_.-]+$/);
    });

    it('holds the top of the catalog, where a new pass starts', () => {
      const decoded = decodeFeedCursor(
        encodeFeedCursor({ pass: 1, ...FEED_TOP }),
      );
      expect(decoded.createdAt).toEqual(FEED_TOP.createdAt);
      expect(decoded.id).toBe(FEED_TOP.id);
    });
  });

  describe('size', () => {
    it('stays under 1 KB with the largest injected list', () => {
      const cursor = encodeFeedCursor({
        pass: 0,
        createdAt: new Date(1_700_000_000_000),
        id: ID,
        injected: fakeIds(MAX_INJECTED),
      });
      expect(cursor.length).toBeLessThan(1024);
    });

    it('refuses to encode more injected ids than the limit', () => {
      expect(() =>
        encodeFeedCursor({
          pass: 0,
          createdAt: new Date(1_700_000_000_000),
          id: ID,
          injected: fakeIds(MAX_INJECTED + 1),
        }),
      ).toThrow(RangeError);
    });
  });

  describe('a cursor the service did not issue is 400 INVALID_CURSOR', () => {
    const valid = {
      p: 0,
      t: 1_700_000_000_000,
      i: ID,
    };

    it.each([
      ['an empty value', ''],
      ['characters outside the alphabet', 'not a cursor!'],
      ['an offset from the old scheme', '30'],
      ['text that is not JSON', handMade('plain text')],
      ['JSON that is not an object', handMade([1, 2, 3])],
      ['JSON null', handMade('null')],
      ['no pass', handMade({ t: valid.t, i: valid.i })],
      ['a negative pass', handMade({ ...valid, p: -1 })],
      ['a fractional pass', handMade({ ...valid, p: 1.5 })],
      ['a text pass', handMade({ ...valid, p: '0' })],
      ['a pass beyond any real loop count', handMade({ ...valid, p: 1e12 })],
      ['no time', handMade({ p: 0, i: ID })],
      ['a text time', handMade({ ...valid, t: 'yesterday' })],
      ['a time beyond the date range', handMade({ ...valid, t: 9e15 })],
      ['a fractional time', handMade({ ...valid, t: 1.5 })],
      ['no id', handMade({ p: 0, t: valid.t })],
      ['an id that is too short', handMade({ ...valid, i: 'abc' })],
      ['an id that is not hex', handMade({ ...valid, i: 'z'.repeat(24) })],
      ['an injected list outside the alphabet', `${handMade(valid)}.!!!`],
      ['an empty injected list after the dot', `${handMade(valid)}.`],
      [
        'an injected list that is not whole 12-byte ids',
        handMade(valid, Buffer.alloc(13)),
      ],
      [
        'more injected ids than the limit',
        handMade(valid, Buffer.alloc(12 * (MAX_INJECTED + 1))),
      ],
      [
        'a third part',
        `${handMade(valid, Buffer.alloc(12))}.${Buffer.alloc(12).toString('base64url')}`,
      ],
      ['a value far longer than any cursor', 'A'.repeat(4096)],
    ])('rejects %s', (_label, cursor) => {
      const error = rejection(cursor);
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({
        error: ErrorCode.INVALID_CURSOR,
      });
    });

    it('rejects a real cursor with one character changed to something outside the alphabet', () => {
      const cursor = encodeFeedCursor({
        pass: 0,
        createdAt: new Date(1_700_000_000_000),
        id: ID,
      });
      expect(rejection(`${cursor.slice(0, -1)}*`).getStatus()).toBe(400);
    });
  });

  describe('a list that ends (decodeListCursor)', () => {
    const createdAt = new Date('2026-10-01T10:20:30.456Z');

    it('has no position on the first page', () => {
      expect(decodeListCursor(undefined)).toBeUndefined();
    });

    it('returns the keyset position of a pass-0 cursor', () => {
      const cursor = encodeFeedCursor({ pass: 0, createdAt, id: ID });
      expect(decodeListCursor(cursor)).toEqual({ createdAt, id: ID });
    });

    it('refuses a cursor from the looping feed: a later pass, or injected reels', () => {
      for (const cursor of [
        encodeFeedCursor({ pass: 1, createdAt, id: ID }),
        encodeFeedCursor({ pass: 0, createdAt, id: ID, injected: [ID] }),
      ]) {
        const error = rejectionOf(() => decodeListCursor(cursor));
        expect(error.getResponse()).toMatchObject({
          error: ErrorCode.INVALID_CURSOR,
        });
      }
    });

    it('refuses garbage like any other cursor', () => {
      expect(() => decodeListCursor('not-a-cursor!')).toThrow(
        BadRequestException,
      );
    });
  });
});

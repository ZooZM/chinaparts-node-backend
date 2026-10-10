import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../../common/errors/error-codes';

/**
 * What a client passes back to continue a list, as an opaque string (research R9).
 *
 * A position in a list is a keyset position: "strictly older than this reel", by `(createdAt, _id)`.
 * Unlike an offset, it does not move when new reels are published while a client is scrolling, so
 * a page never repeats a reel or skips one (FR-019).
 */
export interface FeedCursor {
  /**
   * How many times the For You feed has wrapped around the catalog (FR-020). Every other list is
   * finite and always has pass 0.
   */
  pass: number;
  createdAt: Date;
  id: string;
  /**
   * Reels placed on the first page of pass 0 because someone the viewer follows reposted them
   * (FR-017). They are left out of the rest of pass 0, so each is shown once. Empty from pass 1.
   */
  injected: string[];
}

export interface FeedCursorInput {
  pass: number;
  createdAt: Date;
  id: string;
  injected?: string[];
}

/** FR-017 uses at most the 50 most recent reposts, so the list can never be longer. */
export const MAX_INJECTED = 50;

/**
 * A position newer than any reel, which is where a pass begins: everything is "older than" it.
 * Both parts are the largest values their types allow.
 */
export const FEED_TOP: Pick<FeedCursor, 'createdAt' | 'id'> = {
  createdAt: new Date(8_640_000_000_000_000),
  id: 'ffffffffffffffffffffffff',
};

const ID_BYTES = 12;
/** Far more than a pass can ever take: a million loops of a catalog is not a real client. */
const MAX_PASS = 1_000_000;
/** The header is under 100 characters and 50 ids are about 800, so 1 KB is the ceiling. */
const MAX_CURSOR_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** The header, with short keys because every page response carries a cursor. */
interface Header {
  p: number;
  t: number;
  i: string;
}

/**
 * `<header>` or `<header>.<injected>`, each part base64url. The header is JSON; the injected ids
 * are their 12-byte values joined. They are separate parts rather than a field inside the JSON, so
 * the ids are encoded once and not twice: 50 of them take 800 characters, not 1,100.
 */
export function encodeFeedCursor(cursor: FeedCursorInput): string {
  const injected = cursor.injected ?? [];
  if (injected.length > MAX_INJECTED) {
    throw new RangeError(
      `A cursor holds at most ${MAX_INJECTED} injected reels, got ${injected.length}`,
    );
  }
  const header: Header = {
    p: cursor.pass,
    t: cursor.createdAt.getTime(),
    i: cursor.id,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    'base64url',
  );
  if (injected.length === 0) return encodedHeader;
  const ids = Buffer.concat(injected.map((id) => Buffer.from(id, 'hex')));
  return `${encodedHeader}.${ids.toString('base64url')}`;
}

/** Throws `400 INVALID_CURSOR` for anything this service did not issue. */
export function decodeFeedCursor(raw: string): FeedCursor {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) throw invalid();
  const parts = raw.split('.');
  if (parts.length > 2) throw invalid();
  const [encodedHeader, encodedIds] = parts;

  const header = parseHeader(encodedHeader);
  return {
    pass: header.p,
    createdAt: new Date(header.t),
    id: header.i,
    injected: encodedIds === undefined ? [] : decodeInjected(encodedIds),
  };
}

/**
 * The cursor of a list that ends (a creator or hashtag feed, Liked, Saved, comments, ...): only a
 * keyset position, `undefined` for the first page. A cursor from the looping feed, one with a later
 * pass or injected reels, is not one of these and is refused like any other the service did not
 * issue for this list.
 */
export function decodeListCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeFeedCursor(raw);
  if (cursor.pass !== 0 || cursor.injected.length > 0) throw invalid();
  return { createdAt: cursor.createdAt, id: cursor.id };
}

function parseHeader(encoded: string): Header {
  if (encoded.length === 0 || !BASE64URL.test(encoded)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid();
  }
  const { p, t, i } = value as Record<string, unknown>;
  if (!isInteger(p) || p < 0 || p > MAX_PASS) throw invalid();
  if (!isInteger(t) || t < 0 || t > MAX_DATE_MS) throw invalid();
  if (typeof i !== 'string' || !OBJECT_ID.test(i)) throw invalid();
  return { p, t, i };
}

function decodeInjected(encoded: string): string[] {
  if (encoded.length === 0 || !BASE64URL.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length % ID_BYTES !== 0) throw invalid();
  const count = bytes.length / ID_BYTES;
  if (count > MAX_INJECTED) throw invalid();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      bytes.subarray(index * ID_BYTES, (index + 1) * ID_BYTES).toString('hex'),
    );
  }
  return ids;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function invalid(): BadRequestException {
  return new BadRequestException({
    error: ErrorCode.INVALID_CURSOR,
    message: 'Invalid cursor',
  });
}

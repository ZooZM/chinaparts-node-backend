import type { NextFunction, Request, Response } from 'express';
import { requestSanitizer, sanitizeValue } from './sanitize.middleware';

/** Express 5: `req.query` is a getter on the prototype, and assigning to it throws. */
function express5Request(
  query: Record<string, unknown>,
  body?: unknown,
): Request {
  const prototype = {};
  Object.defineProperty(prototype, 'query', {
    get: () => structuredClone(query),
    configurable: true,
  });
  const request = Object.create(prototype) as Record<string, unknown>;
  request.body = body;
  return request as unknown as Request;
}

function run(request: Request): void {
  const next: NextFunction = jest.fn();
  requestSanitizer()(request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
}

describe('sanitizeValue', () => {
  it('strips MongoDB operator keys', () => {
    expect(sanitizeValue({ text: { $ne: 1 } })).toEqual({ text: { _ne: 1 } });
  });

  it('strips dotted keys', () => {
    expect(sanitizeValue({ 'a.b': 1 })).toEqual({ a_b: 1 });
  });

  it('encodes < in strings, which is all xss-clean does', () => {
    expect(sanitizeValue({ text: '<script>alert(1)</script>' })).toEqual({
      text: '&lt;script>alert(1)&lt;/script>',
    });
  });

  it('leaves ordinary text, Arabic, hashtags and mentions alone', () => {
    const text = 'فلتر زيت & بنزين #فلتر_زيت @قطع_الرياض "ok" \'ok\'';
    expect(sanitizeValue({ text })).toEqual({ text });
  });

  it('passes primitives through', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue('plain')).toBe('plain');
    expect(sanitizeValue(null)).toBeNull();
  });
});

describe('requestSanitizer under Express 5', () => {
  it('sanitizes the body in place', () => {
    const request = express5Request({}, { text: { $gt: '' }, note: '<b>' });
    run(request);
    expect(request.body).toEqual({ text: { _gt: '' }, note: '&lt;b>' });
  });

  it('replaces the read-only req.query with a sanitized own property, without throwing', () => {
    const request = express5Request({ cursor: { $ne: 'x' }, q: '<i>' });
    run(request);
    expect(request.query).toEqual({ cursor: { _ne: 'x' }, q: '&lt;i>' });
    // The sanitized copy is stable: a second read is the same object.
    expect(request.query).toBe(request.query);
  });

  it('copes with a request that has no body', () => {
    const request = express5Request({});
    run(request);
    expect(request.body).toBeUndefined();
  });

  it('leaves an empty query empty', () => {
    const request = express5Request({});
    run(request);
    expect(request.query).toEqual({});
  });
});

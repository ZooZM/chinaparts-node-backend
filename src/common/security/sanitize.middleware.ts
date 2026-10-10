import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sanitize } from 'express-mongo-sanitize';
import { clean } from 'xss-clean/lib/xss';

/**
 * Input sanitization at the application edge (constitution V): `express-mongo-sanitize` strips
 * MongoDB operator keys (`$ne`, dotted paths) and `xss-clean` encodes `<`.
 *
 * Both libraries ship their own middleware, but it assigns `req.query`, which is a read-only
 * getter in Express 5 and throws. This applies the same two functions to the parsed values, and
 * replaces `req.query` with an own property so later reads see the sanitized copy.
 *
 * It is defense in depth: every payload is also a validated DTO, which rejects operator objects
 * where a string is expected. Multipart bodies are parsed later by Multer, so the upload
 * description is validated and HTML-escaped where it is rendered rather than here.
 */
function isContainer(
  value: unknown,
): value is unknown[] | Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function sanitizeValue(value: unknown): unknown {
  // `sanitize` only takes objects and arrays, so a bare string only needs the XSS step.
  if (typeof value === 'string') return clean(value);
  if (isContainer(value)) return clean(sanitize(value, { replaceWith: '_' }));
  return value;
}

export function requestSanitizer(): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (request.body !== undefined && request.body !== null) {
      request.body = sanitizeValue(request.body);
    }
    Object.defineProperty(request, 'query', {
      value: sanitizeValue(request.query),
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}

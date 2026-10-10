import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { GlobalExceptionFilter } from './global-exception.filter';

const request = { method: 'GET', url: '/api/reels' };

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let logged: string[];

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    logged = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it('passes one of our sentinels through with its message and status', () => {
    const envelope = filter.toEnvelope(
      new NotFoundException({
        error: ErrorCode.REEL_NOT_FOUND,
        message: 'Reel not found',
      }),
      request,
    );
    expect(envelope).toEqual({
      success: false,
      error: 'REEL_NOT_FOUND',
      message: 'Reel not found',
      statusCode: 404,
    });
  });

  it('passes structured details through when present', () => {
    const envelope = filter.toEnvelope(
      new BadRequestException({
        error: ErrorCode.PRODUCT_NOT_ATTACHABLE,
        message: 'Some products cannot be attached',
        details: { productIds: [103, 104] },
      }),
      request,
    );
    expect(envelope.error).toBe('PRODUCT_NOT_ATTACHABLE');
    expect(envelope.details).toEqual({ productIds: [103, 104] });
  });

  it('replaces Nest default error names with a fallback sentinel', () => {
    // `new NotFoundException('Cannot GET /x')` carries `error: 'Not Found'`, which is not a sentinel.
    const envelope = filter.toEnvelope(
      new NotFoundException('Cannot GET /x'),
      request,
    );
    expect(envelope.error).toBe(ErrorCode.NOT_FOUND);
    expect(envelope.message).toBe('Cannot GET /x');
  });

  it('joins an array of validation messages into one string', () => {
    const envelope = filter.toEnvelope(
      new BadRequestException({
        error: ErrorCode.VALIDATION_FAILED,
        message: ['text must not be empty', 'text must be a string'],
      }),
      request,
    );
    expect(envelope.message).toBe(
      'text must not be empty; text must be a string',
    );
    expect(envelope.error).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('keeps a 5xx we raised on purpose, because it carries a sentinel and a safe message', () => {
    const envelope = filter.toEnvelope(
      new ServiceUnavailableException({
        error: ErrorCode.UPSTREAM_UNAVAILABLE,
        message: 'China Parts is temporarily unavailable',
      }),
      request,
    );
    expect(envelope).toMatchObject({
      error: 'UPSTREAM_UNAVAILABLE',
      statusCode: 503,
      message: 'China Parts is temporarily unavailable',
    });
  });

  it('hides the message of a 5xx without a sentinel', () => {
    const envelope = filter.toEnvelope(
      new HttpException('connect ECONNREFUSED 10.0.0.5:3306', 502),
      request,
    );
    expect(envelope.error).toBe(ErrorCode.INTERNAL_ERROR);
    expect(envelope.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(envelope)).not.toContain('ECONNREFUSED');
  });

  it('never leaks the message or stack of an unexpected error, and logs them server-side', () => {
    const boom = new Error(
      'E11000 duplicate key error collection: reels.secret',
    );
    const envelope = filter.toEnvelope(boom, request);

    expect(envelope).toEqual({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
    expect(JSON.stringify(envelope)).not.toContain('E11000');
    expect(JSON.stringify(envelope)).not.toContain('at ');
    expect(logged.join('\n')).toContain('E11000');
  });

  it('maps a framework 413 to VIDEO_TOO_LARGE', () => {
    const envelope = filter.toEnvelope(
      new PayloadTooLargeException('File too large'),
      request,
    );
    expect(envelope.error).toBe(ErrorCode.VIDEO_TOO_LARGE);
    expect(envelope.statusCode).toBe(413);
  });

  it('maps a non-Http 4xx raised by middleware (body-parser) without exposing its message', () => {
    const err = Object.assign(new Error('request entity too large: 52428800'), {
      status: 413,
      expose: true,
    });
    const envelope = filter.toEnvelope(err, request);
    expect(envelope.statusCode).toBe(413);
    expect(envelope.error).toBe(ErrorCode.VIDEO_TOO_LARGE);
    expect(envelope.message).toBe('The request could not be processed');
  });

  it('falls back to a generic code for an unmapped 4xx', () => {
    const envelope = filter.toEnvelope(new ForbiddenException(), request);
    expect(envelope.error).toBe(ErrorCode.FORBIDDEN);
    expect(envelope.statusCode).toBe(HttpStatus.FORBIDDEN);
  });

  it('writes the envelope to the response, and does nothing once headers are sent', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = (headersSent: boolean) =>
      ({
        switchToHttp: () => ({
          getResponse: () => ({ status, json, headersSent }),
          getRequest: () => request,
        }),
      }) as never;

    filter.catch(
      new NotFoundException({ error: ErrorCode.REEL_NOT_FOUND, message: 'x' }),
      host(false),
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledTimes(1);

    filter.catch(new Error('late'), host(true));
    expect(json).toHaveBeenCalledTimes(1);
  });
});

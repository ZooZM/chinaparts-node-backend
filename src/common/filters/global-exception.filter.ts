import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode, isErrorCode } from '../errors/error-codes';

/** `{ success, error, message, statusCode }` (constitution IV), plus optional structured `details`. */
export interface ErrorEnvelope {
  success: false;
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred';

/** Used when a framework exception carries no sentinel of ours. */
const FALLBACK_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_REQUIRED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: ErrorCode.METHOD_NOT_ALLOWED,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  // The only large payload this service accepts is an upload.
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.VIDEO_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Errors raised by Express middleware (for example body-parser's payload-too-large) are not
 * `HttpException`s but carry a 4xx status and flag themselves safe to expose.
 */
function clientStatusOf(exception: unknown): number | undefined {
  if (!isRecord(exception)) return undefined;
  const status = exception.status ?? exception.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : undefined;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    if (response.headersSent) return;

    const envelope = this.toEnvelope(exception, request);
    response.status(envelope.statusCode).json(envelope);
  }

  /** Pure mapping, exposed for tests. Never puts stack traces or driver messages in the result. */
  toEnvelope(
    exception: unknown,
    request: Pick<Request, 'method' | 'url'>,
  ): ErrorEnvelope {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, request);
    }

    const clientStatus = clientStatusOf(exception);
    if (clientStatus !== undefined) {
      return {
        success: false,
        error: FALLBACK_BY_STATUS[clientStatus] ?? ErrorCode.BAD_REQUEST,
        message: 'The request could not be processed',
        statusCode: clientStatus,
      };
    }

    // Unexpected: log everything server-side, tell the client nothing (constitution IV).
    this.logger.error(
      `${request.method} ${request.url} failed`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      success: false,
      error: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_ERROR_MESSAGE,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }

  private fromHttpException(
    exception: HttpException,
    request: Pick<Request, 'method' | 'url'>,
  ): ErrorEnvelope {
    const statusCode = exception.getStatus();
    const body = exception.getResponse();

    let message = exception.message;
    let error: ErrorCode | undefined;
    let details: unknown;

    if (typeof body === 'string') {
      message = body;
    } else if (isRecord(body)) {
      if (isErrorCode(body.error)) error = body.error;
      if (typeof body.message === 'string') {
        message = body.message;
      } else if (Array.isArray(body.message)) {
        message = body.message.map(String).join('; ');
      }
      if (body.details !== undefined) details = body.details;
    }

    if (statusCode >= 500) {
      // A 5xx we raised on purpose carries a sentinel and a safe message (for example
      // UPSTREAM_UNAVAILABLE). Anything else is treated as an unexpected failure.
      this.logger.error(`${request.method} ${request.url} -> ${statusCode}`);
      if (error === undefined) {
        return {
          success: false,
          error: ErrorCode.INTERNAL_ERROR,
          message: GENERIC_ERROR_MESSAGE,
          statusCode,
        };
      }
    }

    const envelope: ErrorEnvelope = {
      success: false,
      error: error ?? FALLBACK_BY_STATUS[statusCode] ?? ErrorCode.BAD_REQUEST,
      message,
      statusCode,
    };
    if (details !== undefined) envelope.details = details;
    return envelope;
  }
}

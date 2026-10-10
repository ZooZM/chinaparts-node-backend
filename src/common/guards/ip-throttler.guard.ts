import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import { ErrorCode } from '../errors/error-codes';
import type { ViewerRequest } from '../http/viewer-request';
import { SKIP_RATE_LIMIT_KEY } from './access.decorator';

const MINUTE_MS = 60_000;

/** Throws `429 RATE_LIMITED` with `Retry-After` when a counter went over its limit. */
export function rejectOverLimit(
  response: Response,
  record: { isBlocked: boolean; timeToExpire: number },
): void {
  if (!record.isBlocked) return;
  response.setHeader('Retry-After', String(Math.max(1, record.timeToExpire)));
  throw new HttpException(
    {
      error: ErrorCode.RATE_LIMITED,
      message: 'Too many requests. Try again shortly.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Global guard 1 of 4 (research R10): a limit per client IP on every request. It runs before any
 * token lookup, so a flood of invented tokens cannot reach China Parts' database without limit.
 * The limit is generous, because mobile carriers put many users behind one address.
 */
@Injectable()
export class IpThrottlerGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<ViewerRequest>();
    const limit = this.config.getOrThrow<number>('IP_RATE_LIMIT_PER_MINUTE');

    const record = await this.storage.increment(
      request.ip ?? 'unknown',
      MINUTE_MS,
      limit,
      0,
      'ip',
    );
    rejectOverLimit(http.getResponse<Response>(), record);
    return true;
  }
}

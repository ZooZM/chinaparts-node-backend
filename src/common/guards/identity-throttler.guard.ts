import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import type { ViewerRequest } from '../http/viewer-request';
import {
  ACCESS_KEY,
  AccessLevel,
  RATE_LIMIT_CLASS_KEY,
  RateLimitClassName,
  SKIP_RATE_LIMIT_KEY,
} from './access.decorator';
import { rejectOverLimit } from './ip-throttler.guard';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Global guard 3 of 4 (research R10): limits by who is calling. Signed-in callers are counted by
 * account, guests by installation id plus IP (FR-004b), and the IP limit in guard 1 bounds anyone
 * who rotates installation ids. Routes marked `@RateLimitClass(...)` add a tighter named limit.
 *
 * `public` and `admin` routes are not counted here: they only pass the IP limit.
 */
@Injectable()
export class IdentityThrottlerGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        SKIP_RATE_LIMIT_KEY,
        targets,
      )
    ) {
      return true;
    }
    const level =
      this.reflector.getAllAndOverride<AccessLevel | undefined>(
        ACCESS_KEY,
        targets,
      ) ?? 'signed-in';
    if (level === 'public' || level === 'admin') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<ViewerRequest>();
    const response = http.getResponse<Response>();
    const user = request.user;

    const general = user
      ? await this.storage.increment(
          user.userId,
          MINUTE_MS,
          this.config.getOrThrow<number>('USER_RATE_LIMIT_PER_MINUTE'),
          0,
          'user',
        )
      : await this.storage.increment(
          `${request.installationId ?? 'none'}:${request.ip ?? 'unknown'}`,
          MINUTE_MS,
          this.config.getOrThrow<number>('GUEST_RATE_LIMIT_PER_MINUTE'),
          0,
          'guest',
        );
    rejectOverLimit(response, general);

    const named = this.reflector.getAllAndOverride<
      RateLimitClassName | undefined
    >(RATE_LIMIT_CLASS_KEY, targets);
    if (named && user) {
      const record =
        named === 'upload'
          ? await this.storage.increment(
              user.userId,
              HOUR_MS,
              this.config.getOrThrow<number>('UPLOAD_RATE_LIMIT_PER_HOUR'),
              0,
              'upload',
            )
          : await this.storage.increment(
              user.userId,
              MINUTE_MS,
              this.config.getOrThrow<number>('WRITE_RATE_LIMIT_PER_MINUTE'),
              0,
              'write',
            );
      rejectOverLimit(response, record);
    }
    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../errors/error-codes';
import type { ViewerRequest } from '../http/viewer-request';
import { STANDING_EXEMPT_KEY } from './access.decorator';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard 4 of 4 (research R10, FR-008): every request that writes, by a signed-in caller,
 * needs good standing, except on routes marked `@StandingExempt()`. Guests and reads pass: a
 * suspended account can still look, just not act.
 */
@Injectable()
export class GoodStandingGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<ViewerRequest>();
    if (!request.user) return true;
    if (READ_ONLY_METHODS.has(request.method)) return true;

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(
      STANDING_EXEMPT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) return true;

    if (request.user.standing !== 'good') {
      throw new ForbiddenException({
        error: ErrorCode.ACCOUNT_NOT_IN_GOOD_STANDING,
        message: 'Your account is not in good standing',
      });
    }
    return true;
  }
}

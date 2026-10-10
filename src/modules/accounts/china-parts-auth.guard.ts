import {
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/http/viewer-request';

/**
 * Runs the `chinaparts` Passport strategy and translates its outcome into our error sentinels.
 * An error we raised on purpose (the 503 for an unreachable China Parts) passes through, and every
 * other failure, including a malformed header, is `401 AUTH_INVALID_SESSION`.
 */
@Injectable()
export class ChinaPartsAuthGuard extends AuthGuard('chinaparts') {
  handleRequest<TUser = AuthenticatedUser>(
    error: unknown,
    user: TUser | false | undefined,
  ): TUser {
    if (error instanceof HttpException) throw error;
    if (error || !user) {
      throw new UnauthorizedException({
        error: ErrorCode.AUTH_INVALID_SESSION,
        message: 'Your session is invalid or has expired',
      });
    }
    return user;
  }
}

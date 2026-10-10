import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ErrorCode } from '../errors/error-codes';
import type { ViewerRequest } from '../http/viewer-request';
import { ACCESS_KEY, AccessLevel } from './access.decorator';
import { REQUEST_AUTHENTICATOR } from './request-authenticator';
import type { RequestAuthenticator } from './request-authenticator';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Global guard 2 of 4 (research R10): works out who is calling and whether the route admits them.
 *
 * - No `Authorization` header means a guest. A header that is present is validated, and a failure
 *   is a 401 even on routes open to guests (FR-004a). An outage while validating passes through as
 *   a 503, so a China Parts outage never looks like a sign-out.
 * - `admin` routes ignore user sessions and check `x-admin-key`, failing closed when unset (FR-059).
 * - `X-Installation-Id` is read for guests only when it is a valid UUID v4.
 */
@Injectable()
export class ViewerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Inject(REQUEST_AUTHENTICATOR)
    private readonly authenticator: RequestAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<ViewerRequest>();
    const level =
      this.reflector.getAllAndOverride<AccessLevel | undefined>(ACCESS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'signed-in';

    if (level === 'admin') return this.checkAdminKey(request);

    const installationId = request.headers['x-installation-id'];
    if (typeof installationId === 'string' && UUID_V4.test(installationId)) {
      request.installationId = installationId;
    }

    if (level === 'public') return true;

    // Present, even if empty: an empty header is a broken client, not a guest.
    if (request.headers.authorization !== undefined) {
      request.user = await this.authenticator.authenticate(context);
    }

    if (level === 'optional') return true;

    if (!request.user) {
      throw new UnauthorizedException({
        error: ErrorCode.AUTH_REQUIRED,
        message: 'Sign in to continue',
      });
    }
    if (level === 'seller' && request.user.accountType !== 'seller') {
      throw new ForbiddenException({
        error: ErrorCode.REELS_SELLERS_ONLY,
        message: 'Reels can only be published by sellers',
      });
    }
    return true;
  }

  private checkAdminKey(request: ViewerRequest): boolean {
    const expected = this.config.get<string>('ADMIN_API_KEY');
    const provided = request.headers['x-admin-key'];
    // Hash both sides so the comparison is constant-time and length-independent. An unset key
    // locks the surface for everyone rather than defaulting open.
    const valid =
      !!expected &&
      typeof provided === 'string' &&
      timingSafeEqual(sha256(provided), sha256(expected));
    if (!valid) {
      throw new UnauthorizedException({
        error: ErrorCode.ADMIN_KEY_INVALID,
        message: expected
          ? 'Invalid admin key'
          : 'The operator surface is not configured',
      });
    }
    return true;
  }
}

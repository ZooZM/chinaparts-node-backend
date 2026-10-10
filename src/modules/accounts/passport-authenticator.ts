import { ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestAuthenticator } from '../../common/guards/request-authenticator';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/http/viewer-request';
import { ChinaPartsAuthGuard } from './china-parts-auth.guard';

/** The `RequestAuthenticator` the guard chain uses: it runs the China Parts Passport strategy. */
@Injectable()
export class PassportAuthenticator implements RequestAuthenticator {
  constructor(private readonly guard: ChinaPartsAuthGuard) {}

  async authenticate(context: ExecutionContext): Promise<AuthenticatedUser> {
    // On success Passport has put the validated user on `request.user`.
    await this.guard.canActivate(context);
    return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  }
}

import { Controller, Get } from '@nestjs/common';
import { Access } from '../../common/guards/access.decorator';
import type { AuthenticatedUser } from '../../common/http/viewer-request';
import { CurrentUser } from '../../common/http/viewer.decorator';
import { AccountsService, MeDto } from './accounts.service';

/** The caller's own reels account. Thin: it asks the service and answers (constitution II). */
@Controller('api/users')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  /**
   * EP24. A customer and a seller who share a China Parts number are different accounts here, and
   * this is where an app finds out which one it is signed in as (SC-005).
   */
  @Get('me')
  @Access('signed-in')
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return this.accounts.getMe(user.userId);
  }
}

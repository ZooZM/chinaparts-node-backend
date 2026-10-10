import { Injectable, Logger } from '@nestjs/common';
import { StandingService } from '../../accounts/standing.service';
import { ReelsService } from '../reels.service';
import { AccountCleanupRepository } from './account-cleanup.repository';

const REEL_PAGE = 200;

/**
 * Removes a deleted China Parts account from the reels data (FR-010): its reels and everything
 * that hangs on them, then its footprint on everyone else's content, then the account itself.
 *
 * Every step is safe to run again, so a job that fails half way is simply retried. The order puts
 * the reels first because deleting a reel is the one step that also touches storage and the
 * hashtag dictionary, and it goes through the same path as the owner deleting it, so those side
 * effects are identical.
 */
@Injectable()
export class AccountCleanupService {
  private readonly logger = new Logger(AccountCleanupService.name);

  constructor(
    private readonly cleanup: AccountCleanupRepository,
    private readonly reels: ReelsService,
    private readonly standing: StandingService,
  ) {}

  async cleanUp(accountId: string): Promise<void> {
    const reels = await this.deleteReels(accountId);
    const comments = await this.cleanup.removeComments(accountId);
    const likes = await this.cleanup.removeLikes(accountId);
    const follows = await this.cleanup.removeFollows(accountId);
    const reports = await this.cleanup.removeReelReports(accountId);
    await this.cleanup.removeOtherRelations(accountId);
    await this.cleanup.removeFromBlockLists(accountId);
    await this.cleanup.removeNotificationEvents(accountId);
    await this.cleanup.forgetTapper(accountId);
    // The account no longer exists, so it leaves the not-in-good-standing set with it.
    await this.standing.remove(accountId);
    await this.cleanup.deleteAccount(accountId);

    this.logger.log(
      JSON.stringify({
        event: 'account.cleaned',
        accountId,
        reels,
        comments,
        likes,
        follows,
        reports,
      }),
    );
  }

  private async deleteReels(accountId: string): Promise<number> {
    let deleted = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.cleanup.listReelIds(accountId, after, REEL_PAGE);
      if (page.length === 0) return deleted;
      for (const reelId of page) {
        await this.reels.deleteReelOf(accountId, reelId);
        deleted += 1;
      }
      after = page[page.length - 1];
    }
  }
}

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { LimitsService } from '../../../common/config/limits';
import { ErrorCode } from '../../../common/errors/error-codes';
import { CommentReportsRepository } from '../comments/comment-reports.repository';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelsRepository } from '../reels.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daily limit on reports (FR-055, research R16), shared by reel reports and comment reports: a
 * reporter's reports of both kinds in the last 24 hours count together against
 * `REEL_REPORT_DAILY_LIMIT`. It is a rule, so it lives in a service; the repositories only count.
 */
@Injectable()
export class ReportLimitService {
  constructor(
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    private readonly commentReports: CommentReportsRepository,
    private readonly limits: LimitsService,
  ) {}

  /** Throws `429 REPORT_DAILY_LIMIT` when one more report would pass the limit. */
  async assertWithinLimit(reporterId: string): Promise<void> {
    const since = new Date(Date.now() - DAY_MS);
    const [reelReports, commentReports] = await Promise.all([
      this.reels.countRecentReelReports(reporterId, since),
      this.commentReports.countRecent(reporterId, since),
    ]);
    if (reelReports + commentReports >= this.limits.reportDailyLimit) {
      throw new HttpException(
        {
          error: ErrorCode.REPORT_DAILY_LIMIT,
          message: 'Daily report limit reached',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

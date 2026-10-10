import { HttpException } from '@nestjs/common';
import { LimitsService } from '../../../common/config/limits';
import type { CommentReportsRepository } from '../comments/comment-reports.repository';
import type { ReelsRepository } from '../reels.repository';
import { ReportLimitService } from './report-limit.service';

function setup(limit = 5) {
  const countRecentReelReports = jest.fn().mockResolvedValue(0);
  const countRecent = jest.fn().mockResolvedValue(0);
  const service = new ReportLimitService(
    { countRecentReelReports } as unknown as ReelsRepository,
    { countRecent } as unknown as CommentReportsRepository,
    new LimitsService({ get: () => limit } as never),
  );
  return { service, countRecentReelReports, countRecent };
}

describe('ReportLimitService (FR-055, research R16)', () => {
  it('lets a report through below the limit', async () => {
    const { service, countRecentReelReports, countRecent } = setup(5);
    countRecentReelReports.mockResolvedValue(2);
    countRecent.mockResolvedValue(2);

    await expect(service.assertWithinLimit('u1')).resolves.toBeUndefined();
  });

  it.each([
    ['reel reports alone', 5, 0],
    ['comment reports alone', 0, 5],
    ['both kinds together', 3, 2],
    ['more than the limit', 9, 9],
  ])(
    'refuses at the limit by %s, with 429 REPORT_DAILY_LIMIT',
    async (_label, reels, comments) => {
      const { service, countRecentReelReports, countRecent } = setup(5);
      countRecentReelReports.mockResolvedValue(reels);
      countRecent.mockResolvedValue(comments);

      const error = await service
        .assertWithinLimit('u1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: 'REPORT_DAILY_LIMIT',
      });
    },
  );

  it('counts the last 24 hours for the reporter, in both collections', async () => {
    const { service, countRecentReelReports, countRecent } = setup();
    const before = Date.now();

    await service.assertWithinLimit('u1');

    for (const mock of [countRecentReelReports, countRecent]) {
      const [reporter, since] = mock.mock.calls[0] as [string, Date];
      expect(reporter).toBe('u1');
      const age = before - since.getTime();
      expect(age).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5);
      expect(age).toBeLessThan(24 * 60 * 60 * 1000 + 5_000);
    }
  });
});

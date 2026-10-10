import { ConfigService } from '@nestjs/config';
import { LimitsService } from './limits';

function limits(values: Record<string, unknown>): LimitsService {
  return new LimitsService({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

const base = {
  FEED_PAGE_SIZE_DEFAULT: 10,
  FEED_PAGE_SIZE_MAX: 25,
  COMMENTS_PAGE_SIZE_DEFAULT: 20,
  COMMENTS_PAGE_SIZE_MAX: 50,
};

describe('LimitsService', () => {
  describe('clampPageSize', () => {
    const service = limits(base);

    it('uses the default when nothing sensible is requested', () => {
      expect(service.clampPageSize('feed')).toBe(10);
      expect(service.clampPageSize('feed', 0)).toBe(10);
      expect(service.clampPageSize('feed', -3)).toBe(10);
      expect(service.clampPageSize('feed', Number.NaN)).toBe(10);
      expect(service.clampPageSize('comments')).toBe(20);
    });

    it('honours a request inside the range, flooring fractions', () => {
      expect(service.clampPageSize('feed', 7)).toBe(7);
      expect(service.clampPageSize('feed', 7.9)).toBe(7);
      expect(service.clampPageSize('comments', 30)).toBe(30);
    });

    it('clamps to the maximum instead of rejecting (research R9)', () => {
      expect(service.clampPageSize('feed', 100)).toBe(25);
      expect(service.clampPageSize('comments', 100)).toBe(50);
    });

    it('follows configuration, not constants (FR-070)', () => {
      const custom = limits({
        FEED_PAGE_SIZE_DEFAULT: 4,
        FEED_PAGE_SIZE_MAX: 8,
      });
      expect(custom.clampPageSize('feed')).toBe(4);
      expect(custom.clampPageSize('feed', 50)).toBe(8);
    });
  });

  it('exposes every limit as a typed number', () => {
    const service = limits({
      REEL_MAX_VIDEO_BYTES: 1,
      REEL_MAX_DURATION_SECONDS: 2,
      REEL_MAX_DESCRIPTION_LENGTH: 3,
      REEL_COMMENT_MAX_LENGTH: 4,
      REEL_REPORT_REASON_MAX_LENGTH: 5,
      REEL_MAX_PRODUCTS: 6,
      REEL_REPORT_DAILY_LIMIT: 7,
      REEL_REPORT_AUTOHIDE_THRESHOLD: 8,
    });
    expect([
      service.maxVideoBytes,
      service.maxDurationSeconds,
      service.maxDescriptionLength,
      service.maxCommentLength,
      service.maxReportReasonLength,
      service.maxProducts,
      service.reportDailyLimit,
      service.reportAutoHideThreshold,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('fails loudly on a missing value instead of inventing one', () => {
    expect(() => limits({}).maxVideoBytes).toThrow(/REEL_MAX_VIDEO_BYTES/);
    expect(() => limits({ REEL_MAX_PRODUCTS: '5' }).maxProducts).toThrow(
      /REEL_MAX_PRODUCTS/,
    );
  });
});

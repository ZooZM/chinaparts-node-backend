import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type PageKind = 'feed' | 'comments';

/**
 * Typed access to every limit FR-070 says must be configurable (research R24). The values are
 * validated and defaulted by the Joi schema in `AppModule`, so a missing value here is a
 * programming error, not a runtime condition.
 */
@Injectable()
export class LimitsService {
  constructor(private readonly config: ConfigService) {}

  get maxVideoBytes(): number {
    return this.number('REEL_MAX_VIDEO_BYTES');
  }

  get maxDurationSeconds(): number {
    return this.number('REEL_MAX_DURATION_SECONDS');
  }

  get maxDescriptionLength(): number {
    return this.number('REEL_MAX_DESCRIPTION_LENGTH');
  }

  get maxCommentLength(): number {
    return this.number('REEL_COMMENT_MAX_LENGTH');
  }

  get maxReportReasonLength(): number {
    return this.number('REEL_REPORT_REASON_MAX_LENGTH');
  }

  get maxProducts(): number {
    return this.number('REEL_MAX_PRODUCTS');
  }

  get reportDailyLimit(): number {
    return this.number('REEL_REPORT_DAILY_LIMIT');
  }

  get reportAutoHideThreshold(): number {
    return this.number('REEL_REPORT_AUTOHIDE_THRESHOLD');
  }

  /**
   * Page sizes are clamped, not rejected (research R9): `min(requested or default, max)`.
   * A missing, non-numeric, or non-positive request gets the default.
   */
  clampPageSize(kind: PageKind, requested?: number): number {
    const prefix = kind === 'feed' ? 'FEED_PAGE_SIZE' : 'COMMENTS_PAGE_SIZE';
    const fallback = this.number(`${prefix}_DEFAULT`);
    const max = this.number(`${prefix}_MAX`);
    const wanted =
      requested === undefined || !Number.isFinite(requested) || requested < 1
        ? fallback
        : Math.floor(requested);
    return Math.min(wanted, max);
  }

  private number(key: string): number {
    const value = this.config.get<number>(key);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Configuration value ${key} is missing or not a number`);
    }
    return value;
  }
}

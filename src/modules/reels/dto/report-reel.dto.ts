import { IsEnum, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxLengthFromConfig } from '../../../common/validation/max-length-from-config';
import { ReelReportReason } from '../schemas/reel-report.schema';

/** `customReason` is required (non-empty, trimmed) if and only if `reason` is `other` (FR-053). */
export class ReportReelDto {
  @IsEnum(ReelReportReason)
  reason: ReelReportReason;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((o: ReportReelDto) => o.reason === ReelReportReason.OTHER)
  @IsString()
  @IsNotEmpty()
  @MaxLengthFromConfig('REEL_REPORT_REASON_MAX_LENGTH')
  customReason?: string;
}

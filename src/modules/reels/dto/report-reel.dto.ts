import { IsEnum, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { ReelReportReason } from '../schemas/reel-report.schema';

/** v4 (FR-069): `customReason` is required (non-empty, trimmed) iff `reason === 'other'`. */
export class ReportReelDto {
  @IsEnum(ReelReportReason)
  reason: ReelReportReason;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((o: ReportReelDto) => o.reason === ReelReportReason.OTHER)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  customReason?: string;
}

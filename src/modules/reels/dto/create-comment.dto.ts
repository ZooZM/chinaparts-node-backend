import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxLengthFromConfig } from '../../../common/validation/max-length-from-config';

export class CreateCommentDto {
  // 1 to REEL_COMMENT_MAX_LENGTH characters after trimming (FR-040).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLengthFromConfig('REEL_COMMENT_MAX_LENGTH')
  text: string;
}

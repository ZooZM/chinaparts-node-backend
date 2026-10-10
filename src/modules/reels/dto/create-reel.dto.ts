import { IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxLengthFromConfig } from '../../../common/validation/max-length-from-config';

/**
 * The text fields of the multipart upload. The `video` and `thumbnail` files themselves are
 * handled by Multer, not by this DTO.
 */
export class CreateReelDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLengthFromConfig('REEL_MAX_DESCRIPTION_LENGTH')
  description?: string;
}

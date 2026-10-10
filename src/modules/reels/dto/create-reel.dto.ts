import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * v3 (FR-060): multipart upload body — the `video`/`thumbnail` files
 * themselves are handled by Multer (`FileInterceptor`), not this DTO.
 */
export class CreateReelDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(2200)
  description?: string;
}

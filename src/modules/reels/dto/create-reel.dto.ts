import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxLengthFromConfig } from '../../../common/validation/max-length-from-config';

/**
 * `productIds` as a multipart field arrives as text: a JSON list ("[101,102]"), a comma-separated
 * list ("101,102"), or the same field repeated. Anything that does not read as whole numbers is
 * left as it is, so validation refuses it.
 */
export function parseProductIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      typeof item === 'string' ? toNumber(item) : item,
    );
  }
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === '') return [];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  return text.split(',').map((part) => toNumber(part));
}

function toNumber(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;
}

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

  // Up to REEL_MAX_PRODUCTS of the seller's own active products (FR-035). How many, and whether
  // each qualifies, is the service's to say, with its own errors, so only the shape is checked here.
  @Transform(({ value }: { value: unknown }) => parseProductIds(value))
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  productIds?: number[];
}

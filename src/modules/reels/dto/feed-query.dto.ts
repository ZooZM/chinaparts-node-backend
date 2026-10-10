import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Page sizes are clamped by the service, not rejected here: `limit=100` returns the configured
 * maximum rather than a 400 (research R9, R24). The default also comes from configuration, so no
 * default is set on the DTO.
 */
export class FeedQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  creatorId?: string;

  // A hashtag-scoped feed. Matched after normalization, so the '#' and the spelling variant do
  // not matter (FR-049a, FR-051).
  @IsOptional()
  @IsString()
  hashtag?: string;

  // The target account for the public Reposts list (GET /reposted). Required for signed-out
  // visitors, and defaults to the caller when signed in.
  @IsOptional()
  @IsString()
  userId?: string;
}

export class CommentsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

// Feeds the mention-suggestion overlay. Page size 50, at most 100: not one of the FR-070 limits.
export class FollowingUsersQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

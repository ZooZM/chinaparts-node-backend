import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FeedQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  creatorId?: string;

  // FR-047a: hashtag-scoped feed (no '#', case-insensitive exact match).
  @IsOptional()
  @IsString()
  hashtag?: string;

  // v6: the target user for the public Reposts list (GET /reposted). Defaults
  // to the caller when omitted.
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
  @Max(50)
  limit?: number = 20;
}

// v5 (FR-084, contracts §31): feeds the mention-suggestion overlay.
export class FollowingUsersQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}

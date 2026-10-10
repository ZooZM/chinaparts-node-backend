import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum AdminCommentAction {
  REMOVE = 'remove',
  DISMISS = 'dismiss',
}

/** The body of `PATCH /api/reels/comments/:commentId/moderation` (EP32). */
export class AdminCommentModerationDto {
  @IsEnum(AdminCommentAction)
  action: AdminCommentAction;
}

/** The query of `GET /api/reels/moderation/comments` (EP31). */
export class AdminCommentQueueQueryDto {
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

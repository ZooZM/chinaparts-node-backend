import { IsEnum } from 'class-validator';

export enum AdminModerationAction {
  RESTORE = 'restore',
  REJECT = 'reject',
}

/** v4 (FR-071): body for `PATCH /api/reels/:id/moderation`. */
export class AdminModerationDto {
  @IsEnum(AdminModerationAction)
  action: AdminModerationAction;
}

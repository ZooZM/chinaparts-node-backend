import { IsOptional, IsString, Matches } from 'class-validator';

/** 3 to 30 letters (any script), marks, digits, `_` or `.` (research R6). */
const HANDLE_PATTERN = /^[\p{L}\p{M}\p{N}_.]{3,30}$/u;

/**
 * The body of `PATCH /api/users/me`: the two things a user may change about their reels identity.
 * Name, picture and standing belong to China Parts and cannot be edited here. The bio's length (150
 * characters, counted as characters and not UTF-16 units, so Arabic and emoji count fairly) is
 * checked by `AccountsService.updateMe`.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Matches(HANDLE_PATTERN, {
    message: 'username must be 3 to 30 letters, digits, underscores or periods',
  })
  username?: string;

  @IsOptional()
  @IsString()
  bio?: string;
}

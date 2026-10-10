import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  CommentQueueItem,
  CommentReportsService,
} from './comments/comment-reports.service';
import {
  AdminCommentAction,
  AdminCommentModerationDto,
  AdminCommentQueueQueryDto,
} from './dto/admin-comment-moderation.dto';
import { Access } from '../../common/guards/access.decorator';
import { AdminHiddenQueryDto } from './dto/admin-hidden-query.dto';
import { AdminModerationDto } from './dto/admin-moderation.dto';
import { ReelsService } from './reels.service';
import type { AdminHiddenReelDto, Page } from './reels.repository';

/**
 * The secured, non-user-facing operator surface (FR-057, FR-058, FR-059). It is reached with the
 * operator key only: `@Access('admin')` makes the global guard ignore user sessions here, so a
 * China Parts login never grants access. There is no operator UI: the surface is used through API
 * tooling.
 */
@Controller('api/reels')
@Access('admin')
export class ReelsAdminController {
  constructor(
    private readonly reelsService: ReelsService,
    private readonly commentReports: CommentReportsService,
  ) {}

  // Two path segments, so it never collides with `GET /api/reels/:id` in ReelsController.
  @Get('moderation/hidden')
  listHidden(
    @Query() query: AdminHiddenQueryDto,
  ): Promise<Page<AdminHiddenReelDto>> {
    return this.reelsService.listHiddenReels(query);
  }

  @Patch(':id/moderation')
  moderateReel(
    @Param('id') id: string,
    @Body() dto: AdminModerationDto,
  ): Promise<{ id: string; status: string }> {
    return this.reelsService.adminModerateReel(id, dto.action);
  }

  // Comments with open reports, most recently reported first (EP31).
  @Get('moderation/comments')
  listReportedComments(
    @Query() query: AdminCommentQueueQueryDto,
  ): Promise<Page<CommentQueueItem>> {
    return this.commentReports.listQueue({
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
  }

  // Three path segments, so it never meets `PATCH :id/moderation` above (EP32).
  @Patch('comments/:commentId/moderation')
  moderateComment(
    @Param('commentId') commentId: string,
    @Body() dto: AdminCommentModerationDto,
  ): Promise<{ id: string; action: 'remove' | 'dismiss' }> {
    return dto.action === AdminCommentAction.REMOVE
      ? this.commentReports.remove(commentId)
      : this.commentReports.dismiss(commentId);
  }
}

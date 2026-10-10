import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  Access,
  RateLimitClass,
  StandingExempt,
} from '../../common/guards/access.decorator';
import type {
  AuthenticatedUser,
  ViewerContext,
} from '../../common/http/viewer-request';
import { CurrentUser, Viewer } from '../../common/http/viewer.decorator';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreateReelDto } from './dto/create-reel.dto';
import {
  CommentsQueryDto,
  FeedQueryDto,
  FollowingUsersQueryDto,
} from './dto/feed-query.dto';
import { ReportReelDto } from './dto/report-reel.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { ReelUploadService } from './media/reel-upload.service';
import { ReelsService } from './reels.service';
import type {
  CommentDto,
  FollowedUserDto,
  Page,
  ReelDto,
} from './reels.repository';

interface UploadFiles {
  video?: Express.Multer.File[];
  thumbnail?: Express.Multer.File[];
}

/**
 * Thin: translates HTTP, delegates, never decides (constitution II). Every route states its access
 * level, matching contracts/rest-api.md.
 *
 * Static routes (liked, saved, search, following, ...) MUST stay above the `:id` routes: Nest
 * matches in declaration order, and `:id` would otherwise swallow them, for example
 * `GET /api/reels/liked` becoming `getReel('liked')`.
 */
@Controller('api/reels')
export class ReelsController {
  constructor(
    private readonly reelsService: ReelsService,
    private readonly uploadService: ReelUploadService,
  ) {}

  @Get('liked')
  @Access('signed-in')
  getLiked(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.getLiked(user, query);
  }

  @Get('saved')
  @Access('signed-in')
  getSaved(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.getSaved(user, query);
  }

  // The public Reposts list. `userId` selects whose (required when signed out).
  @Get('reposted')
  @Access('optional')
  getReposted(
    @Viewer() viewer: ViewerContext,
    @Query() query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.getReposted(viewer, query);
  }

  @Get('search')
  @Access('signed-in')
  searchReels(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.searchReels(user, query);
  }

  @Get('following')
  @Access('signed-in')
  getFollowingFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.getFollowingFeed(user, query);
  }

  // Followed accounts, for the mention-suggestion overlay.
  @Get('me/following')
  @Access('signed-in')
  getFollowingUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FollowingUsersQueryDto,
  ): Promise<Page<FollowedUserDto>> {
    return this.reelsService.getFollowingUsers(user, query);
  }

  @Get()
  @Access('optional')
  getFeed(
    @Viewer() viewer: ViewerContext,
    @Query() query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    return this.reelsService.getFeed(viewer, query);
  }

  // Publishing: sellers only (FR-025). The response never waits on screening (FR-029). The size
  // limit and the allowed types come from the Multer options registered in the module.
  @Post()
  @Access('seller')
  @RateLimitClass('upload')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'video', maxCount: 1 },
      { name: 'thumbnail', maxCount: 1 },
    ]),
  )
  uploadReel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReelDto,
    @UploadedFiles() files: UploadFiles,
  ): Promise<ReelDto> {
    return this.uploadService.upload(
      user,
      { video: files.video?.[0], thumbnail: files.thumbnail?.[0] },
      dto,
    );
  }

  // Deleting one's own reel stays possible out of good standing (FR-008).
  @Delete(':id')
  @Access('signed-in')
  @StandingExempt()
  deleteReel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ deleted: true }> {
    return this.reelsService.deleteReel(user, id);
  }

  @Get(':id')
  @Access('optional')
  getReel(
    @Viewer() viewer: ViewerContext,
    @Param('id') id: string,
  ): Promise<ReelDto> {
    return this.reelsService.getReel(viewer, id);
  }

  @Post(':id/like')
  @Access('signed-in')
  toggleLike(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ liked: boolean; likesCount: number }> {
    return this.reelsService.toggleLike(user, id);
  }

  @Get(':id/comments')
  @Access('optional')
  getComments(
    @Viewer() viewer: ViewerContext,
    @Param('id') id: string,
    @Query() query: CommentsQueryDto,
  ): Promise<{
    items: CommentDto[];
    nextCursor: string | null;
    commentsCount: number;
  }> {
    return this.reelsService.getComments(viewer, id, query);
  }

  @Post(':id/comments')
  @Access('signed-in')
  @RateLimitClass('write')
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ): Promise<{ comment: CommentDto; commentsCount: number }> {
    return this.reelsService.addComment(user, id, dto.text);
  }

  @Post(':id/share')
  @Access('signed-in')
  recordShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ sharesCount: number }> {
    return this.reelsService.recordShare(user, id);
  }

  // Counted once per account, or once per installation when signed out. No good standing needed.
  @Post(':id/view')
  @Access('optional')
  @StandingExempt()
  recordView(
    @Viewer() viewer: ViewerContext,
    @Param('id') id: string,
  ): Promise<{ viewsCount: number }> {
    return this.reelsService.recordView(viewer, id);
  }

  @Post(':id/save')
  @Access('signed-in')
  toggleSave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ saved: boolean }> {
    return this.reelsService.toggleSave(user, id);
  }

  // Report a reel: a preset reason, or `other` with typed text.
  @Post(':id/report')
  @Access('signed-in')
  @RateLimitClass('write')
  reportReel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReportReelDto,
  ): Promise<{ reported: true; alreadyReported: boolean }> {
    return this.reelsService.reportReel(user, id, dto);
  }

  // Explicit repost and un-repost: separate verbs, not a toggle.
  @Post(':id/repost')
  @Access('signed-in')
  repostReel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ reposted: true }> {
    return this.reelsService.repostReel(user, id);
  }

  @Delete(':id/repost')
  @Access('signed-in')
  unrepostReel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ reposted: false }> {
    return this.reelsService.unrepostReel(user, id);
  }

  // Everyone who reposted this reel: the reposters bottom sheet.
  @Get(':id/reposters')
  @Access('optional')
  getReposters(
    @Viewer() viewer: ViewerContext,
    @Param('id') id: string,
    @Query() query: FeedQueryDto,
  ): Promise<Page<FollowedUserDto>> {
    return this.reelsService.getReposters(viewer, id, query);
  }
}

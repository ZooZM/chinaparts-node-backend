import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Access } from '../../common/guards/access.decorator';
import type {
  AuthenticatedUser,
  ViewerContext,
} from '../../common/http/viewer-request';
import { CurrentUser, Viewer } from '../../common/http/viewer.decorator';
import { SearchQueryDto } from './dto/search-query.dto';
import { ReelsService } from './reels.service';
import type {
  CreatorProfileDto,
  Page,
  UserSearchResultDto,
} from './reels.repository';

@Controller('api/users')
export class ReelsUsersController {
  constructor(private readonly reelsService: ReelsService) {}

  // Static route above `:id/profile`, for the same reason as in ReelsController.
  @Get('search')
  @Access('signed-in')
  searchUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchQueryDto,
  ): Promise<Page<UserSearchResultDto>> {
    return this.reelsService.searchUsers(user, query);
  }

  @Get(':id/profile')
  @Access('optional')
  getProfile(
    @Viewer() viewer: ViewerContext,
    @Param('id') id: string,
  ): Promise<CreatorProfileDto> {
    return this.reelsService.getProfile(viewer, id);
  }

  @Post(':id/follow')
  @Access('signed-in')
  toggleFollow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ following: boolean; followersCount: number }> {
    return this.reelsService.toggleFollow(user, id);
  }

  @Post(':id/block')
  @Access('signed-in')
  toggleBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ blocked: boolean }> {
    return this.reelsService.toggleBlock(user, id);
  }
}

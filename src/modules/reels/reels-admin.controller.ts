import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
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
  constructor(private readonly reelsService: ReelsService) {}

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
}

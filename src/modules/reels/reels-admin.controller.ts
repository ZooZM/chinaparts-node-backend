import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard';
import { ReelsService } from './reels.service';
import { AdminHiddenQueryDto } from './dto/admin-hidden-query.dto';
import { AdminModerationDto } from './dto/admin-moderation.dto';

/**
 * v4 (FR-071): the secured, non-user-facing admin moderation surface —
 * deliberately a SEPARATE controller from `ReelsController` (mirrors
 * `ReelsRedirectController`'s pattern) so `AdminKeyGuard` is the ONLY guard
 * on these routes; `ReelsController`'s class-level `JwtAuthGuard` never
 * applies here. No admin UI in v1 — operated via API tooling only.
 */
@UseGuards(AdminKeyGuard)
@Controller('api/reels')
export class ReelsAdminController {
  constructor(private readonly reelsService: ReelsService) {}

  // Two path segments (`moderation/hidden`) — does not collide with
  // ReelsController's single-segment `GET /api/reels/:id`.
  @Get('moderation/hidden')
  listHidden(@Query() query: AdminHiddenQueryDto) {
    return this.reelsService.listHiddenReels(query);
  }

  @Patch(':id/moderation')
  moderateReel(@Param('id') id: string, @Body() dto: AdminModerationDto) {
    return this.reelsService.adminModerateReel(id, dto.action);
  }
}

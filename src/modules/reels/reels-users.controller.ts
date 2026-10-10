import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ReelsService } from './reels.service';
import { SearchQueryDto } from './dto/search-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('api/users')
export class ReelsUsersController {
  constructor(private readonly reelsService: ReelsService) {}

  // Static route above `:id/profile` for the same reason as ReelsController.
  @Get('search')
  searchUsers(@Request() req: any, @Query() query: SearchQueryDto) {
    return this.reelsService.searchUsers(req.user.userId, query);
  }

  @Get(':id/profile')
  getProfile(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.getProfile(id, req.user.userId);
  }

  @Post(':id/follow')
  toggleFollow(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.toggleFollow(id, req.user.userId);
  }

  @Post(':id/block')
  toggleBlock(@Request() req: any, @Param('id') id: string) {
    return this.reelsService.toggleBlock(id, req.user.userId);
  }
}

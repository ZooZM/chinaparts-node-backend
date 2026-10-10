import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ReelsController } from './reels.controller';
import { ReelsUsersController } from './reels-users.controller';
import { ReelsRedirectController } from './reels-redirect.controller';
import { ReelsAdminController } from './reels-admin.controller';
import { AdminKeyGuard } from './admin-key.guard';
import { ReelsService } from './reels.service';
import { ReelsDbRepository } from './reels-db.repository';
import { ReelsSeedService } from './reels-seed.service';
import { ReelsNotificationsService } from './reels-notifications.service';
import { REELS_REPOSITORY } from './reels.repository';
import { NotificationsModule } from '../notifications/notifications.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Reel, ReelSchema } from './schemas/reel.schema';
import {
  REELS_MODERATION_QUEUE,
  ReelsModerationProcessor,
} from './reels-moderation.processor';
import { ReelsModerationService } from './reels-moderation.service';
import { MODERATION_PROVIDER } from './moderation/moderation-provider';
import { StubModerationProvider } from './moderation/stub.provider';
import { SightengineModerationProvider } from './moderation/sightengine.provider';
import { ReelLike, ReelLikeSchema } from './schemas/reel-like.schema';
import { ReelSave, ReelSaveSchema } from './schemas/reel-save.schema';
import { ReelView, ReelViewSchema } from './schemas/reel-view.schema';
import { ReelShare, ReelShareSchema } from './schemas/reel-share.schema';
import { ReelComment, ReelCommentSchema } from './schemas/reel-comment.schema';
import { ReelReport, ReelReportSchema } from './schemas/reel-report.schema';
import { ReelRepost, ReelRepostSchema } from './schemas/reel-repost.schema';
import { Follow, FollowSchema } from './schemas/follow.schema';
import {
  NotificationEvent,
  NotificationEventSchema,
} from './schemas/notification-event.schema';

@Module({
  imports: [
    // Registering the existing `User` schema here too (alongside UsersModule)
    // is a standard, safe NestJS/Mongoose pattern — both modules bind to the
    // same underlying collection/model, keeping ReelsModule self-contained
    // for its own Mongo needs (mirrors the v1 mock store's self-containment).
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Reel.name, schema: ReelSchema },
      { name: ReelLike.name, schema: ReelLikeSchema },
      { name: ReelSave.name, schema: ReelSaveSchema },
      { name: ReelView.name, schema: ReelViewSchema },
      { name: ReelShare.name, schema: ReelShareSchema },
      { name: ReelComment.name, schema: ReelCommentSchema },
      { name: ReelReport.name, schema: ReelReportSchema },
      { name: ReelRepost.name, schema: ReelRepostSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: NotificationEvent.name, schema: NotificationEventSchema },
    ]),
    NotificationsModule,
    // v3: HTTP client for the Sightengine provider (video + text REST calls).
    HttpModule,
    // v3 (R17): the moderation worker's queue. Connection is inherited from
    // the global `BullModule.forRootAsync` registration in app.module.ts.
    BullModule.registerQueue({ name: REELS_MODERATION_QUEUE }),
  ],
  controllers: [
    ReelsController,
    ReelsUsersController,
    ReelsRedirectController,
    ReelsAdminController,
  ],
  providers: [
    ReelsService,
    ReelsDbRepository,
    ReelsSeedService,
    ReelsNotificationsService,
    ReelsModerationService,
    ReelsModerationProcessor,
    AdminKeyGuard,
    { provide: REELS_REPOSITORY, useExisting: ReelsDbRepository },
    // v3 (R15): 'stub' by default (dev/test, no credentials); 'sightengine'
    // for the real provider. Swapping providers later is a new class here.
    {
      provide: MODERATION_PROVIDER,
      inject: [
        ConfigService,
        SightengineModerationProvider,
        StubModerationProvider,
      ],
      useFactory: (
        config: ConfigService,
        sightengine: SightengineModerationProvider,
        stub: StubModerationProvider,
      ) =>
        config.get<string>('MODERATION_PROVIDER') === 'sightengine'
          ? sightengine
          : stub,
    },
    StubModerationProvider,
    SightengineModerationProvider,
  ],
})
export class ReelsModule {}

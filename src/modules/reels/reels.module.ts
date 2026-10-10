import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { LimitsService } from '../../common/config/limits';
import {
  QUEUE_MEDIA_VISIBILITY,
  QUEUE_REELS_MODERATION,
} from '../../common/queues/queue-names';
import { AccountsModule } from '../accounts/accounts.module';
import { ChinaPartsModule } from '../china-parts/china-parts.module';
import { PushModule } from '../push/push.module';
import { MediaVisibilityProcessor } from './lifecycle/media-visibility.processor';
import { CommentsRepository } from './comments/comments.repository';
import { CommentsService } from './comments/comments.service';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import { MediaUrlService } from './media/media-url.service';
import { ReelMediaService } from './media/reel-media.service';
import { ReelUploadService } from './media/reel-upload.service';
import { createUploadOptions } from './media/upload.config';
import { MODERATION_PROVIDER } from './moderation/moderation-provider';
import { SightengineModerationProvider } from './moderation/sightengine.provider';
import { StubModerationProvider } from './moderation/stub.provider';
import { NotificationEventsRepository } from './notification-events.repository';
import { ReelPresenter } from './presentation/reel-presenter.service';
import { ReelsAdminController } from './reels-admin.controller';
import { ReelsDbRepository } from './reels-db.repository';
import { ReelsModerationProcessor } from './reels-moderation.processor';
import { ReelsModerationService } from './reels-moderation.service';
import { ReelsNotificationsService } from './reels-notifications.service';
import { ReelsRedirectController } from './reels-redirect.controller';
import { ReelsSeedService } from './reels-seed.service';
import { ReelsUsersController } from './reels-users.controller';
import { ReelsController } from './reels.controller';
import { REELS_REPOSITORY } from './reels.repository';
import { ReelsService } from './reels.service';
import { Follow, FollowSchema } from './schemas/follow.schema';
import {
  NotificationEvent,
  NotificationEventSchema,
} from './schemas/notification-event.schema';
import { ReelComment, ReelCommentSchema } from './schemas/reel-comment.schema';
import {
  ReelGuestView,
  ReelGuestViewSchema,
} from './schemas/reel-guest-view.schema';
import { ReelLike, ReelLikeSchema } from './schemas/reel-like.schema';
import { ReelReport, ReelReportSchema } from './schemas/reel-report.schema';
import { ReelRepost, ReelRepostSchema } from './schemas/reel-repost.schema';
import { ReelSave, ReelSaveSchema } from './schemas/reel-save.schema';
import { ReelShare, ReelShareSchema } from './schemas/reel-share.schema';
import { ReelView, ReelViewSchema } from './schemas/reel-view.schema';
import { Reel, ReelSchema } from './schemas/reel.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Reel.name, schema: ReelSchema },
      { name: ReelLike.name, schema: ReelLikeSchema },
      { name: ReelSave.name, schema: ReelSaveSchema },
      { name: ReelView.name, schema: ReelViewSchema },
      { name: ReelGuestView.name, schema: ReelGuestViewSchema },
      { name: ReelShare.name, schema: ReelShareSchema },
      { name: ReelComment.name, schema: ReelCommentSchema },
      { name: ReelReport.name, schema: ReelReportSchema },
      { name: ReelRepost.name, schema: ReelRepostSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: NotificationEvent.name, schema: NotificationEventSchema },
    ]),
    AccountsModule,
    ChinaPartsModule,
    PushModule,
    // HTTP client for the Sightengine provider (video and text REST calls).
    HttpModule,
    // The screening queue. The connection comes from `BullModule.forRootAsync` in AppModule.
    BullModule.registerQueue({ name: QUEUE_REELS_MODERATION }),
    // Re-applies media visibility after an account's standing changed (the sync enqueues the jobs).
    BullModule.registerQueue({ name: QUEUE_MEDIA_VISIBILITY }),
    // Upload limits and temp storage come from configuration (FR-070), not a decorator argument.
    MulterModule.registerAsync({
      inject: [LimitsService],
      useFactory: createUploadOptions,
    }),
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
    { provide: REELS_REPOSITORY, useExisting: ReelsDbRepository },
    NotificationEventsRepository,
    CommentsRepository,
    CommentsService,
    ReelsNotificationsService,
    ReelsModerationService,
    ReelsModerationProcessor,
    ReelsSeedService,
    ReelUploadService,
    ReelMediaService,
    MediaUrlService,
    ReelPresenter,
    ReelLifecycleService,
    MediaVisibilityProcessor,
    // 'stub' by default (development and test, no credentials); 'sightengine' for the real
    // provider. Swapping providers later is a new class here.
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

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUE_REELS_PUSH } from '../../common/queues/queue-names';
import { AccountsModule } from '../accounts/accounts.module';
import { ChinaPartsModule } from '../china-parts/china-parts.module';
import { FcmPushClient, FCM_SENDER_CLIENT } from './fcm-push.client';
import {
  FIREBASE_MESSAGING,
  FirebaseAdminMessaging,
} from './firebase-messaging';
import { PushPayloadBuilder } from './push-payload.builder';
import { PushProcessor } from './push.processor';
import { PUSH_SENDER } from './push-sender';
import { QueuedPushSender } from './queued-push.sender';

/**
 * Push delivery to the devices China Parts already holds (research R14). `PUSH_SENDER` queues a
 * notification; the worker delivers it through Firebase, one project per China Parts app.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_REELS_PUSH }),
    AccountsModule,
    ChinaPartsModule,
  ],
  providers: [
    PushPayloadBuilder,
    FirebaseAdminMessaging,
    { provide: FIREBASE_MESSAGING, useExisting: FirebaseAdminMessaging },
    { provide: FCM_SENDER_CLIENT, useClass: FcmPushClient },
    PushProcessor,
    { provide: PUSH_SENDER, useClass: QueuedPushSender },
  ],
  exports: [PUSH_SENDER],
})
export class PushModule {}

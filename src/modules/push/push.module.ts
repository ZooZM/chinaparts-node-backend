import { Module } from '@nestjs/common';
import { NoopPushSender } from './noop-push.sender';
import { PUSH_SENDER } from './push-sender';

/** Push delivery to China Parts' registered devices (research R14). */
@Module({
  providers: [{ provide: PUSH_SENDER, useClass: NoopPushSender }],
  exports: [PUSH_SENDER],
})
export class PushModule {}

import { Processor } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUE_REELS_PUSH } from '../../common/queues/queue-names';
import { RoleAwareWorkerHost } from '../../common/queues/role-aware-worker.host';
import { AccountsRepository } from '../accounts/accounts.repository';
import { ChinaPartsDevicesRepository } from '../china-parts/devices.repository';
import { FCM_SENDER_CLIENT } from './fcm-push.client';
import type { FcmSenderClient } from './fcm-push.client';
import { PushPayloadBuilder } from './push-payload.builder';
import type { PushJob } from './push-sender';

/**
 * Delivers one notification (research R14, FR-063 to FR-066): finds the recipient's devices in
 * China Parts, composes the message in their language, and sends it.
 *
 * A failure is thrown, so the queue retries it with backoff. It never reaches the request that
 * caused the notification, which finished long before.
 *
 * Runs only in a worker process (`WORKER_ROLE`), see `RoleAwareWorkerHost`.
 */
@Injectable()
@Processor(QUEUE_REELS_PUSH, { autorun: false })
export class PushProcessor extends RoleAwareWorkerHost {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly devices: ChinaPartsDevicesRepository,
    private readonly builder: PushPayloadBuilder,
    @Inject(FCM_SENDER_CLIENT) private readonly fcm: FcmSenderClient,
    config: ConfigService,
  ) {
    super(config);
  }

  async process(job: Job<PushJob>): Promise<void> {
    const { recipientId, actorId } = job.data;
    const found = await this.accounts.findByIdsLean(
      actorId ? [recipientId, actorId] : [recipientId],
      ['accountType', 'externalId', 'locale', 'name', 'standing'],
    );
    const recipient = found.find(
      (account) => account._id.toString() === recipientId,
    );
    // An account that is gone has nobody to tell.
    if (!recipient || recipient.standing === 'deleted') return;
    const actor = actorId
      ? found.find((account) => account._id.toString() === actorId)
      : undefined;

    // Exactly this account's devices in exactly its app (FR-063): seller 1 is not customer 1.
    const devices = await this.devices.getTokens(
      recipient.accountType,
      recipient.externalId,
    );
    if (devices.length === 0) return;

    const message = this.builder.build(job.data, recipient.locale, actor?.name);
    const result = await this.fcm.sendMulticast(
      recipient.accountType,
      devices.map((device) => device.token),
      message,
    );

    // For the SC-010 report (scripts/metrics/latency-report.sh): the time from the event to the
    // send. The type and the numbers only: no id, no name, nothing that identifies anyone.
    this.logger.log(
      JSON.stringify({
        event: 'push.delivered',
        type: job.data.type,
        sent: result.sent,
        deliveryLatencyMs: Date.now() - job.timestamp,
      }),
    );
  }
}

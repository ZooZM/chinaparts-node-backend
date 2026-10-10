import { Inject, Injectable, Logger } from '@nestjs/common';
import { PUSH_SENDER } from '../push/push-sender';
import type { PushSender } from '../push/push-sender';
import { NotificationEventsRepository } from './notification-events.repository';
import { NotificationEventType } from './schemas/notification-event.schema';

/**
 * Durable notification events and push delivery (FR-062 to FR-066).
 *
 * A user's own actions on their own content never notify (self-events are skipped). Repeating an
 * action after undoing it does not notify again: the unique index behind
 * `NotificationEventsRepository.recordIfNew` makes a duplicate a silent no-op. The event is
 * recorded before delivery is attempted, and a failure anywhere in here is logged and swallowed,
 * never propagated: the like or follow that triggered it must succeed regardless (FR-066).
 *
 * What a push says, in which language, and to which devices is decided where it is delivered, not
 * here: a job carries ids only (research R14).
 */
@Injectable()
export class ReelsNotificationsService {
  private readonly logger = new Logger(ReelsNotificationsService.name);

  constructor(
    private readonly events: NotificationEventsRepository,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  async notifyNewFollower(params: {
    actorId: string;
    recipientId: string;
  }): Promise<void> {
    if (params.actorId === params.recipientId) return;
    await this.deliver(NotificationEventType.NEW_FOLLOWER, params);
  }

  async notifyReelLike(params: {
    actorId: string;
    recipientId: string;
    reelId: string;
  }): Promise<void> {
    if (params.actorId === params.recipientId) return;
    await this.deliver(NotificationEventType.REEL_LIKE, params);
  }

  /**
   * Called at the publish transition, once per mentioned account. A seed never calls it, so demo
   * content cannot spam mention pushes at boot.
   */
  async notifyMentions(params: {
    actorId: string;
    reelId: string;
    mentions: { userId: string; username: string }[];
  }): Promise<void> {
    for (const mention of params.mentions) {
      if (mention.userId === params.actorId) continue;
      await this.deliver(NotificationEventType.REEL_MENTION, {
        actorId: params.actorId,
        recipientId: mention.userId,
        reelId: params.reelId,
      });
    }
  }

  /**
   * Screening rejected an uploaded reel. System-originated: there is no actor, so the self-skip
   * does not apply. A clean publish is deliberately silent.
   */
  async notifyReelRejected(params: {
    recipientId: string;
    reelId: string;
  }): Promise<void> {
    await this.deliver(NotificationEventType.REEL_REJECTED, {
      actorId: null,
      recipientId: params.recipientId,
      reelId: params.reelId,
    });
  }

  private async deliver(
    type: NotificationEventType,
    params: { actorId: string | null; recipientId: string; reelId?: string },
  ): Promise<void> {
    try {
      const isNew = await this.events.recordIfNew({ type, ...params });
      if (!isNew) return;
      await this.sender.send({
        recipientId: params.recipientId,
        type,
        // Only what exists: a job has no key for an absent actor or reel.
        ...(params.actorId ? { actorId: params.actorId } : {}),
        ...(params.reelId ? { reelId: params.reelId } : {}),
      });
    } catch (error) {
      this.logger.warn(
        `Notification ${type} for ${params.recipientId} failed: ${String(error)}`,
      );
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PushService } from '../notifications/push.service';
import { DeviceTokensRepository } from '../notifications/device-tokens.repository';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  NotificationEvent,
  NotificationEventDocument,
  NotificationEventType,
} from './schemas/notification-event.schema';

/**
 * FR-054: durable notification events + end-to-end FCM push (clarified —
 * full delivery ships this phase, not just the event schema). Reuses the
 * existing `NotificationsModule` (PushService + DeviceTokensRepository) so
 * no new push plumbing is introduced.
 *
 * A user's own actions on their own content never notify (self-events are
 * rejected below). Re-doing the same action after undoing it (unlike/
 * re-like, unfollow/re-follow) does not re-notify — the unique index on
 * `notification_events` makes a duplicate write a silent no-op.
 */
@Injectable()
export class ReelsNotificationsService {
  private readonly logger = new Logger(ReelsNotificationsService.name);

  constructor(
    @InjectModel(NotificationEvent.name)
    private readonly eventModel: Model<NotificationEventDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly pushService: PushService,
    private readonly deviceTokens: DeviceTokensRepository,
  ) {}

  async notifyNewFollower(params: {
    actorId: string;
    recipientId: string;
  }): Promise<void> {
    if (params.actorId === params.recipientId) return;
    const wasNew = await this.recordEvent({
      type: NotificationEventType.NEW_FOLLOWER,
      actorId: params.actorId,
      recipientId: params.recipientId,
    });
    if (!wasNew) return;
    const actor = await this.userModel
      .findById(params.actorId)
      .select('name')
      .lean()
      .exec();
    await this.push(params.recipientId, {
      title: actor?.name ?? 'Someone',
      body: 'notif_new_follower',
      data: {
        type: NotificationEventType.NEW_FOLLOWER,
        actorId: params.actorId,
      },
    });
  }

  async notifyReelLike(params: {
    actorId: string;
    recipientId: string;
    reelId: string;
  }): Promise<void> {
    if (params.actorId === params.recipientId) return;
    const wasNew = await this.recordEvent({
      type: NotificationEventType.REEL_LIKE,
      actorId: params.actorId,
      recipientId: params.recipientId,
      reelId: params.reelId,
    });
    if (!wasNew) return;
    const actor = await this.userModel
      .findById(params.actorId)
      .select('name')
      .lean()
      .exec();
    await this.push(params.recipientId, {
      title: actor?.name ?? 'Someone',
      body: 'notif_new_like',
      data: {
        type: NotificationEventType.REEL_LIKE,
        actorId: params.actorId,
        reelId: params.reelId,
      },
    });
  }

  /**
   * FR-047/054: mention trigger point. Called at reel-creation time (no
   * upload endpoint exists yet — v1 has no create-reel flow, so this is
   * exercised directly by tests and by the future upload feature; the demo
   * seed calls `parseHashtagsAndMentions` without invoking this method, so
   * seeded content never spams mention pushes at boot).
   */
  async notifyMentions(params: {
    actorId: string;
    reelId: string;
    mentions: { userId: string; username: string }[];
  }): Promise<void> {
    for (const mention of params.mentions) {
      if (mention.userId === params.actorId) continue;

      const wasNew = await this.recordEvent({
        type: NotificationEventType.REEL_MENTION,
        actorId: params.actorId,
        recipientId: mention.userId,
        reelId: params.reelId,
      });
      if (!wasNew) continue;

      const actor = await this.userModel
        .findById(params.actorId)
        .select('name')
        .lean()
        .exec();

      await this.push(mention.userId, {
        title: actor?.name ?? 'Someone',
        body: 'notif_mention',
        data: {
          type: NotificationEventType.REEL_MENTION,
          actorId: params.actorId,
          reelId: params.reelId,
        },
      });
    }
  }

  /**
   * v3 (FR-064): the moderation worker rejected an uploaded reel. System-
   * originated — no actor, so the self-skip guard in the other `notify*`
   * methods does not apply here. Recorded even if push delivery fails
   * (FR-054 semantics); a clean publish is deliberately silent (clarified).
   */
  async notifyReelRejected(params: {
    recipientId: string;
    reelId: string;
  }): Promise<void> {
    const wasNew = await this.recordEvent({
      type: NotificationEventType.REEL_REJECTED,
      actorId: null,
      recipientId: params.recipientId,
      reelId: params.reelId,
    });
    if (!wasNew) return;
    await this.push(params.recipientId, {
      title: 'CiroChat',
      body: 'notif_rejected',
      data: {
        type: NotificationEventType.REEL_REJECTED,
        reelId: params.reelId,
      },
    });
  }

  /** Returns true if a new event row was written (i.e. this is not a repeat). */
  private async recordEvent(params: {
    type: NotificationEventType;
    actorId: string | null;
    recipientId: string;
    reelId?: string;
  }): Promise<boolean> {
    try {
      await this.eventModel.create({
        type: params.type,
        actorId: params.actorId ? new Types.ObjectId(params.actorId) : null,
        recipientId: new Types.ObjectId(params.recipientId),
        reelId: params.reelId ? new Types.ObjectId(params.reelId) : undefined,
      });
      return true;
    } catch {
      // Duplicate-key: an identical event already exists (dedup — R14).
      return false;
    }
  }

  private async push(
    recipientId: string,
    payload: { title: string; body: string; data: Record<string, string> },
  ): Promise<void> {
    const tokens = await this.deviceTokens.getTokens(recipientId);
    for (const doc of tokens) {
      await this.pushService.sendPush(doc.token, payload);
    }
    if (tokens.length === 0) {
      this.logger.debug(
        `No device tokens for ${recipientId} — event recorded, push skipped`,
      );
    }
  }
}

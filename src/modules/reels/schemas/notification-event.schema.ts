import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationEventDocument = NotificationEvent & Document;

export enum NotificationEventType {
  NEW_FOLLOWER = 'newFollower',
  REEL_LIKE = 'reelLike',
  REEL_MENTION = 'reelMention',
  // v3 (FR-064): system-originated — the moderation worker rejected an
  // uploaded reel. No actor; the self-skip rule does not apply to it.
  REEL_REJECTED = 'reelRejected',
}

// FR-054: durable record of a notification-worthy action, written before the
// FCM push fan-out is attempted. `actorId != recipientId` is enforced in the
// service layer for actor-driven types — a user's own actions on their own
// content never notify. v3: `actorId` is optional/null for system-originated
// events (`reelRejected`), which bypass the self-skip rule entirely.
@Schema({
  collection: 'notification_events',
  timestamps: { createdAt: true, updatedAt: false },
})
export class NotificationEvent {
  @Prop({ type: String, enum: NotificationEventType, required: true })
  type: NotificationEventType;

  @Prop({
    type: Types.ObjectId,
    ref: 'ReelsAccount',
    required: false,
    default: null,
  })
  actorId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  recipientId: Types.ObjectId;

  // Absent for `newFollower`; the liked/mentioned reel otherwise.
  @Prop({ type: Types.ObjectId, ref: 'Reel', required: false })
  reelId?: Types.ObjectId;

  createdAt?: Date;
}

export const NotificationEventSchema =
  SchemaFactory.createForClass(NotificationEvent);

// Future notification-center reads (out of scope this phase, index paid for now).
NotificationEventSchema.index({ recipientId: 1, createdAt: -1 });
// Dedup: re-like/re-follow after undo never re-notifies (R14) — reelId is
// part of the key so two different reels from the same actor both notify.
NotificationEventSchema.index(
  { type: 1, actorId: 1, recipientId: 1, reelId: 1 },
  { unique: true },
);

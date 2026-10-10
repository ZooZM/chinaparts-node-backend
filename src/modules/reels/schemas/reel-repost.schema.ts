import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelRepostDocument = ReelRepost & Document;

// v4 (FR-073): a repost is a pure distribution relationship — no copy of the
// reel is created, no public counter. At most one repost per (reel,
// reposter); toggled the same relation-write-outcome way as likes/saves.
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ReelRepost {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reposterId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelRepostSchema = SchemaFactory.createForClass(ReelRepost);

// Toggle/dedup integrity (FR-073) — repost/un-repost idempotency.
ReelRepostSchema.index({ videoId: 1, reposterId: 1 }, { unique: true });
// For You injection leg (FR-076): "reposts by users I follow (or myself)",
// ordered by repost recency — joins with Follow's { followerId, createdAt }
// index (data-model.md v4 "Feed composition").
ReelRepostSchema.index({ reposterId: 1, createdAt: -1 });
// Delete cascade (FR-067).
ReelRepostSchema.index({ videoId: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelLikeDocument = ReelLike & Document;

@Schema({
  collection: 'reel_likes',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelLike {
  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelLikeSchema = SchemaFactory.createForClass(ReelLike);

// Toggle/dedup integrity: at most one like per (user, video) — FR-055.
ReelLikeSchema.index({ userId: 1, videoId: 1 }, { unique: true });
// Liked Videos list ordering (FR-051).
ReelLikeSchema.index({ userId: 1, createdAt: -1 });
ReelLikeSchema.index({ videoId: 1 });

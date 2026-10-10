import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelViewDocument = ReelView & Document;

// FR-048: a view is counted once per user per reel, at playback start.
// The unique index below is what makes "insert-if-absent" dedup possible —
// only an actual insert (never a duplicate-key error) triggers `$inc viewsCount`.
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ReelView {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelViewSchema = SchemaFactory.createForClass(ReelView);

ReelViewSchema.index({ userId: 1, videoId: 1 }, { unique: true });
ReelViewSchema.index({ videoId: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelShareDocument = ReelShare & Document;

// Event log — deliberately NOT unique on (userId, videoId): every in-app
// send or Copy Link appends a new row (FR-021a, unchanged from v1).
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ReelShare {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelShareSchema = SchemaFactory.createForClass(ReelShare);

ReelShareSchema.index({ videoId: 1 });

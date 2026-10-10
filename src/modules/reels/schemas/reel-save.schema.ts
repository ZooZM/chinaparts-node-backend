import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelSaveDocument = ReelSave & Document;

// FR-049: saves are private — no public counter, no likesCount-style field
// anywhere. This collection is the sole source of truth for "is this saved".
@Schema({
  collection: 'reel_saves',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelSave {
  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  createdAt?: Date;
}

export const ReelSaveSchema = SchemaFactory.createForClass(ReelSave);

ReelSaveSchema.index({ userId: 1, videoId: 1 }, { unique: true });
// Saved Videos list ordering (FR-050).
ReelSaveSchema.index({ userId: 1, createdAt: -1 });
ReelSaveSchema.index({ videoId: 1 });

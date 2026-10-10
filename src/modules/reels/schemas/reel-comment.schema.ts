import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelCommentDocument = ReelComment & Document;

@Schema({
  collection: 'reel_comments',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelComment {
  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  authorId: Types.ObjectId;

  // 1-500 chars, trimmed, non-empty (FR-020) — enforced in the DTO/service.
  // The limit is configurable (REEL_COMMENT_MAX_LENGTH) and enforced by the DTO.
  @Prop({ required: true, maxlength: 5000 })
  text: string;

  createdAt?: Date;
}

export const ReelCommentSchema = SchemaFactory.createForClass(ReelComment);

// Comment page cursor: newest first, `_id` tiebreak.
ReelCommentSchema.index({ videoId: 1, createdAt: -1, _id: -1 });

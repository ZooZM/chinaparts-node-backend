import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelCommentDocument = ReelComment & Document;

/**
 * Who removed a comment: its author, the owner of the reel it is on, the operator, or `system` for
 * the cascade that cleans up after a deleted account.
 */
export type CommentDeletedBy = 'author' | 'reel_owner' | 'operator' | 'system';

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

  // Soft delete: a deleted comment is kept (an operator may still need to see what was removed)
  // but never served. Reads filter `deletedAt: null`.
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({
    type: String,
    enum: ['author', 'reel_owner', 'operator', 'system'],
    default: null,
  })
  deletedByRole: CommentDeletedBy | null;

  createdAt?: Date;
}

export const ReelCommentSchema = SchemaFactory.createForClass(ReelComment);

// A reel's comments, newest first, deleted ones filtered out, with `_id` as the tiebreak.
ReelCommentSchema.index({ videoId: 1, deletedAt: 1, createdAt: -1, _id: -1 });
// Standing filters and the cleanup after an account is deleted.
ReelCommentSchema.index({ authorId: 1 });

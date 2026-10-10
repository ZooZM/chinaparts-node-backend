import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ReelReportReason } from './reel-report.schema';

export type ReelCommentReportDocument = ReelCommentReport & Document;

/**
 * A report of a comment (research R16). Kept while its reel exists, whatever happens to the
 * comment, and deleted with the reel. `dismissedAt` is set when an operator dismisses the comment's
 * open reports; a later report from someone new is a new open report.
 */
@Schema({
  collection: 'reel_comment_reports',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelCommentReport {
  @Prop({ type: Types.ObjectId, ref: 'ReelComment', required: true })
  commentId: Types.ObjectId;

  /** Copied from the comment, so the reports go with their reel. */
  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  reporterId: Types.ObjectId;

  @Prop({ type: String, enum: ReelReportReason, required: true })
  reason: ReelReportReason;

  /** Required only for `other`. */
  @Prop({ type: String, default: null })
  customReason: string | null;

  @Prop({ type: Date, default: null })
  dismissedAt: Date | null;

  createdAt?: Date;
}

export const ReelCommentReportSchema =
  SchemaFactory.createForClass(ReelCommentReport);

// One report of a comment per account, so a repeat is a quiet no-op.
ReelCommentReportSchema.index(
  { commentId: 1, reporterId: 1 },
  { unique: true },
);
// The operator queue: open reports, newest first.
ReelCommentReportSchema.index({ dismissedAt: 1, createdAt: -1 });
// The shared daily limit counts a reporter's recent reports.
ReelCommentReportSchema.index({ reporterId: 1, createdAt: -1 });
// Deleting a reel deletes its reports.
ReelCommentReportSchema.index({ videoId: 1 });

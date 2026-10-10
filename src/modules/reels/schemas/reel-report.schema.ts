import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelReportDocument = ReelReport & Document;

export enum ReelReportReason {
  SPAM = 'spam',
  NUDITY = 'nudity',
  VIOLENCE = 'violence',
  HATE_SPEECH = 'hate_speech',
  OTHER = 'other',
}

// v4 (FR-069): at most one report per (reel, reporter) — the unique index
// makes a duplicate submission an idempotent no-op at the DB layer. Reports
// are retained for admin audit (GET /moderation/hidden, FR-071) even after
// a reel is restored or rejected.
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ReelReport {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  @Prop({ type: String, enum: ReelReportReason, required: true })
  reason: ReelReportReason;

  // Required non-empty (service-validated) iff reason === 'other'; absent otherwise.
  @Prop({ required: false, maxlength: 500 })
  customReason?: string;

  createdAt?: Date;
}

export const ReelReportSchema = SchemaFactory.createForClass(ReelReport);

// Dedup integrity (FR-069) — the report service's insert-if-absent no-op path.
ReelReportSchema.index({ videoId: 1, reporterId: 1 }, { unique: true });
// Per-reel audit/maintenance + delete cascade (FR-067).
ReelReportSchema.index({ videoId: 1 });
// Per-user daily rate limit (REEL_REPORT_DAILY_LIMIT, FR-069) + reporter audit.
ReelReportSchema.index({ reporterId: 1, createdAt: -1 });

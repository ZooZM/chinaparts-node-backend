import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelDocument = Reel & Document;

@Schema({ _id: false })
export class ReelMention {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  username: string;
}

export const ReelMentionSchema = SchemaFactory.createForClass(ReelMention);

// v3 (specs/021-reels-video-feed FR-061): the reel moderation status state
// machine. `pendingModeration` is the only entry state for uploads.
// v4 (FR-070): `hidden` added — a *third* status writer (the report
// service, alongside the moderation worker and the admin endpoint) can
// now transition `published -> hidden` when the unique-reporter count
// crosses the auto-hide threshold. See data-model.md v4's state machine.
export enum ReelStatus {
  PENDING_MODERATION = 'pending_moderation',
  PUBLISHED = 'published',
  REJECTED = 'rejected',
  HIDDEN = 'hidden',
}

// v3: the spec's "Moderation Result" entity, embedded 1:1 with its reel —
// nothing ever queries a moderation result independently of its reel.
@Schema({ _id: false })
export class ModerationResult {
  @Prop({ type: String, enum: ['clean', 'flagged'], required: true })
  verdict: 'clean' | 'flagged';

  @Prop({ type: String, enum: ['video', 'description'], required: false })
  flaggedSource?: 'video' | 'description';

  @Prop({ type: [String], default: [] })
  categories: string[];

  @Prop({ required: false })
  providerRef?: string;

  @Prop({ required: true })
  completedAt: Date;
}

export const ModerationResultSchema =
  SchemaFactory.createForClass(ModerationResult);

@Schema({ timestamps: { createdAt: true, updatedAt: true } })
export class Reel {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  creatorId: Types.ObjectId;

  @Prop({ required: true })
  videoUrl: string;

  // v3 (FR-060): the thumbnail is optional on upload — seeded/CDN content
  // always has one, but a user upload may not attach one.
  @Prop({ default: '' })
  thumbnailUrl: string;

  // FR-047: supports #hashtags and @mentions; parsed at write time.
  @Prop({ default: '', maxlength: 2200 })
  description: string;

  // Normalized (lowercase, no '#'), deduped. Multikey-indexed for hashtag
  // feeds (exact match) and search (substring regex — see reels.service.ts).
  @Prop({ type: [String], default: [] })
  hashtags: string[];

  // Only @mentions that resolve to an existing user (FR-047).
  @Prop({ type: [ReelMentionSchema], default: [] })
  mentions: ReelMention[];

  // v3 (FR-061): moderation status state machine. New uploads default to
  // pending; only `published` reels are visible to non-owners on any
  // surface (ReelsService.isVisible). The moderation worker is the only
  // writer of transitions out of `pending_moderation` (guarded update).
  @Prop({
    type: String,
    enum: ReelStatus,
    default: ReelStatus.PENDING_MODERATION,
    required: true,
  })
  status: ReelStatus;

  // v3: set by the worker on the clean-verdict transition (FR-063).
  @Prop({ required: false })
  publishedAt?: Date;

  // v3: written once by the worker on either transition (FR-064).
  @Prop({ type: ModerationResultSchema, required: false })
  moderation?: ModerationResult;

  // Stored counters (FR-055) — updated via $inc alongside the relation
  // write that causes the change; never computed by aggregation on read.
  @Prop({ default: 0 })
  viewsCount: number;

  @Prop({ default: 0 })
  likesCount: number;

  @Prop({ default: 0 })
  commentsCount: number;

  @Prop({ default: 0 })
  sharesCount: number;

  // v4 (FR-070): stored counter of unique reporters. `$inc` only on a real
  // `reel_reports` insert; the insert that reaches
  // `REEL_REPORT_AUTOHIDE_THRESHOLD` triggers the guarded hide transition.
  // Never exposed on non-owner-facing DTOs.
  @Prop({ default: 0 })
  reportsCount: number;

  // v4 (FR-070/FR-071): set `true` only by the admin restore transition and
  // never unset — "one auto-hide per reel ever". A restored reel keeps
  // accumulating reports for audit but is permanently immune to the
  // auto-hide threshold; only another explicit admin action can move it
  // out of `published` again.
  @Prop({ default: false })
  adminRestored: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ReelSchema = SchemaFactory.createForClass(Reel);

// v3: feed cursor gains a `status` equality prefix — non-owner reads always
// filter to `published`, so this keeps the cursor pattern index-covered
// (replaces the v2 { createdAt: -1, _id: -1 } index).
ReelSchema.index({ status: 1, createdAt: -1, _id: -1 });
// v3: creator-scoped feed / profile grid — others filter `published`, the
// owner reads all statuses (replaces the v2 { creatorId, createdAt } index).
ReelSchema.index({ creatorId: 1, status: 1, createdAt: -1 });
// Hashtag feed exact-match + order (FR-047a); also backs substring search
// (R11); the service applies the status filter on top of this index.
ReelSchema.index({ hashtags: 1, createdAt: -1 });
// v3 (R17): pending-sweep scan — re-enqueue reels stuck in
// `pending_moderation` past a staleness threshold. v4: this same
// { status, updatedAt } shape also backs the admin hidden-reel backlog
// (GET /moderation/hidden, FR-071) — `updatedAt` advances on the hide
// transition, so equality on `status: 'hidden'` + a descending scan of
// this index gives "most recently hidden first" for free.
ReelSchema.index({ status: 1, updatedAt: 1 });

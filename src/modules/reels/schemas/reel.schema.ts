import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelDocument = Reel & Document;

/** A reel as a plain object: what `.lean()` returns. */
export type ReelLean = Reel & { _id: Types.ObjectId };

@Schema({ _id: false })
export class ReelMention {
  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  username: string;
}

export const ReelMentionSchema = SchemaFactory.createForClass(ReelMention);

// The reel moderation status state machine (data-model.md, "Reel status"). `pending_moderation`
// is the only entry state for uploads. `hidden` is entered from `published` by the auto-hide
// threshold, and left again only by an operator.
export enum ReelStatus {
  PENDING_MODERATION = 'pending_moderation',
  PUBLISHED = 'published',
  REJECTED = 'rejected',
  HIDDEN = 'hidden',
}

/**
 * Where a reel's files are. Object keys, not URLs: a URL is built per response (research R12), a
 * public one while `location` is `public` and a presigned one for the owner otherwise.
 *
 * `location` is `public` only while the reel is published AND its creator is in good standing
 * (FR-009). `ReelLifecycleService` is the only writer.
 */
@Schema({ _id: false })
export class ReelMediaRef {
  @Prop({ type: String, required: true })
  videoKey: string;

  @Prop({ type: String, required: true })
  thumbnailKey: string;

  @Prop({ type: String, enum: ['private', 'public'], default: 'private' })
  location: 'private' | 'public';
}

export const ReelMediaRefSchema = SchemaFactory.createForClass(ReelMediaRef);

// The "Moderation Result" entity, embedded 1:1 with its reel: nothing ever queries a moderation
// result independently of its reel.
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

/** A product shown under a reel (FR-035). `tapsCount` is the permanent total of taps (FR-038). */
@Schema({ _id: false })
export class ReelProductLink {
  /** A China Parts `products.id`. */
  @Prop({ type: Number, required: true })
  productId: number;

  /** 0 to 4, the order the seller gave. */
  @Prop({ type: Number, required: true, min: 0, max: 4 })
  position: number;

  @Prop({ type: Number, default: 0 })
  tapsCount: number;
}

export const ReelProductLinkSchema =
  SchemaFactory.createForClass(ReelProductLink);

/** The most products a reel can link: the stored ceiling, under the configurable `REEL_MAX_PRODUCTS`. */
export const MAX_PRODUCT_LINKS = 5;

@Schema({
  collection: 'reels',
  timestamps: { createdAt: true, updatedAt: true },
})
export class Reel {
  @Prop({
    type: Types.ObjectId,
    ref: 'ReelsAccount',
    required: true,
    index: true,
  })
  creatorId: Types.ObjectId;

  @Prop({ type: ReelMediaRefSchema, required: true })
  media: ReelMediaRef;

  // Supports #hashtags and @mentions, parsed at write time. The limit is configurable
  // (REEL_MAX_DESCRIPTION_LENGTH) and enforced by the DTO, so this is only a hard ceiling.
  @Prop({ default: '', maxlength: 5000 })
  description: string;

  // As typed, without '#', deduplicated by normalized form. For display only.
  @Prop({ type: [String], default: [] })
  hashtags: string[];

  // `normalizeForMatch` of each hashtag, in the same order. Used for every match (research R8), so
  // #إطارات and #اطارات are the same hashtag.
  @Prop({ type: [String], default: [] })
  hashtagsNormalized: string[];

  // Only @mentions that resolve to an existing account.
  @Prop({ type: [ReelMentionSchema], default: [] })
  mentions: ReelMention[];

  // At most five, each product once. The links are stored even while a product is unavailable, so
  // it comes back on the reel if it is reactivated (FR-037).
  @Prop({
    type: [ReelProductLinkSchema],
    default: [],
    validate: [
      {
        validator: (links: ReelProductLink[]) =>
          links.length <= MAX_PRODUCT_LINKS,
        message: `A reel links at most ${MAX_PRODUCT_LINKS} products`,
      },
      {
        validator: (links: ReelProductLink[]) =>
          new Set(links.map((link) => link.productId)).size === links.length,
        message: 'A product can be linked to a reel only once',
      },
    ],
  })
  productLinks: ReelProductLink[];

  // Only `published` reels are visible to non-owners on any surface. The moderation worker is the
  // only writer of transitions out of `pending_moderation` (a guarded update).
  @Prop({
    type: String,
    enum: ReelStatus,
    default: ReelStatus.PENDING_MODERATION,
    required: true,
  })
  status: ReelStatus;

  // Set by the worker on the clean-verdict transition.
  @Prop({ required: false })
  publishedAt?: Date;

  // Written once by the worker on either transition.
  @Prop({ type: ModerationResultSchema, required: false })
  moderation?: ModerationResult;

  // Stored counters, updated with $inc alongside the relation write that causes the change and
  // never computed by aggregation on read.
  @Prop({ default: 0 })
  viewsCount: number;

  @Prop({ default: 0 })
  likesCount: number;

  @Prop({ default: 0 })
  commentsCount: number;

  @Prop({ default: 0 })
  sharesCount: number;

  // Stored counter of distinct reporters. `$inc` only on a real `reel_reports` insert; the insert
  // that reaches REEL_REPORT_AUTOHIDE_THRESHOLD triggers the guarded hide transition. Never
  // exposed on non-owner-facing DTOs.
  @Prop({ default: 0 })
  reportsCount: number;

  // Set true only by the operator restore and never unset: "one auto-hide per reel ever". A
  // restored reel keeps accumulating reports for audit but is immune to the threshold.
  @Prop({ default: false })
  adminRestored: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ReelSchema = SchemaFactory.createForClass(Reel);

// Non-owner reads always filter to `published`, so the status prefix keeps the feed cursor
// index-covered.
ReelSchema.index({ status: 1, createdAt: -1, _id: -1 });
// Creator-scoped feed and profile grid: others filter `published`, the owner reads every status.
ReelSchema.index({ creatorId: 1, status: 1, createdAt: -1 });
// Hashtag feed and search, on the normalized form (research R8, R9).
ReelSchema.index({ hashtagsNormalized: 1, createdAt: -1, _id: -1 });
// Pending-sweep scan: re-enqueue reels stuck in `pending_moderation`. The same shape backs the
// operator's hidden-reel backlog, since `updatedAt` advances on the hide transition.
ReelSchema.index({ status: 1, updatedAt: 1 });

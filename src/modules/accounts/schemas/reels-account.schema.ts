import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type {
  AccountType,
  Locale,
  Standing,
} from '../../../common/http/viewer-request';

export type ReelsAccountDocument = ReelsAccount & Document;

/** A reels account as a plain object: what `.lean()` returns. */
export type ReelsAccountLean = ReelsAccount & { _id: Types.ObjectId };

/**
 * One document per China Parts account that uses reels (research R5, data-model.md). It replaces
 * Ciro's `User` for everything the reels code reads from it, so the field names `name`, `username`,
 * `avatarUrl`, `bio`, `blockedUsers`, `followersCount`, `followingCount` and `totalLikes` are kept.
 *
 * China Parts stays the authority for name, picture, standing and currency: they are cached here
 * and refreshed by the sync, never edited through reels.
 */
@Schema({ collection: 'reels_accounts', timestamps: true })
export class ReelsAccount {
  @Prop({ type: String, enum: ['customer', 'seller'], required: true })
  accountType: AccountType;

  /** `customers.id` or `sellers.id`. Only unique together with `accountType` (FR-006). */
  @Prop({ type: Number, required: true })
  externalId: number;

  /** The public name (FR-011, FR-012). */
  @Prop({ type: String, default: '' })
  name: string;

  /** `normalizeForMatch(name)`, for account search. */
  @Prop({ type: String, default: '' })
  nameNormalized: string;

  /** The handle as typed: 3 to 30 letters, marks, digits, `_` or `.` (research R6). */
  @Prop({ type: String, required: true })
  username: string;

  /** `normalizeForMatch(username)`. Unique, so أحمد and احمد are the same handle. */
  @Prop({ type: String, required: true })
  usernameNormalized: string;

  @Prop({ type: String, default: '', maxlength: 150 })
  bio: string;

  /** `null` means the app shows a placeholder. */
  @Prop({ type: String, default: null })
  avatarUrl: string | null;

  /** Only `good` may write, apart from the exemptions in FR-008. */
  @Prop({
    type: String,
    enum: ['good', 'suspended', 'deleted'],
    default: 'good',
    required: true,
  })
  standing: Standing;

  /** The last `Accept-Language` seen, which sets the language of push notifications (R14). */
  @Prop({ type: String, enum: ['ar', 'en'], default: 'ar' })
  locale: Locale;

  /** Three-letter code, or null for the base currency (FR-036). */
  @Prop({ type: String, default: null })
  preferredCurrency: string | null;

  /** Set when the account's China Parts row was missing in a sync. A second miss deletes it (R7). */
  @Prop({ type: Date, default: null })
  missingSince: Date | null;

  /** Accounts this account blocked. The name is kept for the port. */
  @Prop({
    type: [{ type: Types.ObjectId, ref: 'ReelsAccount' }],
    default: [],
  })
  blockedUsers: Types.ObjectId[];

  @Prop({ type: Number, default: 0 })
  followersCount: number;

  @Prop({ type: Number, default: 0 })
  followingCount: number;

  @Prop({ type: Number, default: 0 })
  totalLikes: number;

  /** When this document was last refreshed from China Parts. */
  @Prop({ type: Date, default: null })
  syncedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ReelsAccountSchema = SchemaFactory.createForClass(ReelsAccount);

ReelsAccountSchema.index({ accountType: 1, externalId: 1 }, { unique: true });
ReelsAccountSchema.index({ usernameNormalized: 1 }, { unique: true });
// The reverse block lookup carried over from Ciro: who has blocked this account.
ReelsAccountSchema.index({ blockedUsers: 1 });
ReelsAccountSchema.index({ nameNormalized: 1 });
// Small, because almost every account is in good standing.
ReelsAccountSchema.index(
  { standing: 1 },
  { partialFilterExpression: { standing: { $in: ['suspended', 'deleted'] } } },
);

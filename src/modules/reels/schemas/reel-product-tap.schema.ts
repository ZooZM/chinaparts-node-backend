import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReelProductTapDocument = ReelProductTap & Document;

/** Raw taps are kept for a year; the permanent total lives on the link as `tapsCount`. */
const TAP_RETENTION_SECONDS = 365 * 24 * 60 * 60;

/**
 * One tap on a product card (FR-038). An append-only event, for analytics: `viewerId` is set for a
 * signed-in tapper and `installationId` for a signed-out one, and either may be absent.
 */
@Schema({
  collection: 'reel_product_taps',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ReelProductTap {
  @Prop({ type: Types.ObjectId, ref: 'Reel', required: true })
  videoId: Types.ObjectId;

  /** A China Parts product id: one of the reel's `productLinks`. */
  @Prop({ type: Number, required: true })
  productId: number;

  @Prop({ type: Types.ObjectId, ref: 'ReelsAccount', default: null })
  viewerId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  installationId: string | null;

  createdAt?: Date;
}

export const ReelProductTapSchema =
  SchemaFactory.createForClass(ReelProductTap);

ReelProductTapSchema.index({ videoId: 1, productId: 1, createdAt: -1 });
// Expires the raw events after a year.
ReelProductTapSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: TAP_RETENTION_SECONDS },
);

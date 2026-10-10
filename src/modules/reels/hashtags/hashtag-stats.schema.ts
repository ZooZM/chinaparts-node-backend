import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type HashtagStatsDocument = HashtagStats & Document;

/**
 * One row per normalized hashtag with the number of published reels that carry it (research R9).
 * Search finds matching tags here, by substring over a small collection, and then finds the reels
 * by an indexed `$in`, instead of running a substring scan over every reel.
 */
@Schema({ collection: 'hashtag_stats', timestamps: false })
export class HashtagStats {
  /** `normalizeForMatch` of the hashtag. Unique. */
  @Prop({ type: String, required: true })
  tag: string;

  /** The first spelling seen, as typed. For showing, never for matching. */
  @Prop({ type: String, required: true })
  display: string;

  /** Published reels carrying the tag. A row that reaches zero is removed. */
  @Prop({ type: Number, required: true, default: 0 })
  publishedReelsCount: number;
}

export const HashtagStatsSchema = SchemaFactory.createForClass(HashtagStats);

HashtagStatsSchema.index({ tag: 1 }, { unique: true });

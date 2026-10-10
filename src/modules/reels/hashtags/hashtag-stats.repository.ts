import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepository } from '../../../common/repositories/base.repository';
import { escapeRegex } from '../../../common/text/escape-regex';
import { HashtagStats, HashtagStatsDocument } from './hashtag-stats.schema';

/** Reads and writes the hashtag dictionary, and nothing else (constitution II). */
@Injectable()
export class HashtagStatsRepository extends BaseRepository<HashtagStatsDocument> {
  constructor(
    @InjectModel(HashtagStats.name) model: Model<HashtagStatsDocument>,
  ) {
    super(model);
  }

  /** One more published reel for each tag, creating the row the first time (the unique index makes it safe to race). */
  async increment(
    tags: Array<{ normalized: string; display: string }>,
  ): Promise<void> {
    if (tags.length === 0) return;
    await this.model.bulkWrite(
      tags.map(({ normalized, display }) => ({
        updateOne: {
          filter: { tag: normalized },
          update: {
            $inc: { publishedReelsCount: 1 },
            $setOnInsert: { display },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  /** One fewer for each tag, removing the rows that reach zero. */
  async decrement(normalizedTags: string[]): Promise<void> {
    if (normalizedTags.length === 0) return;
    await this.model.updateMany(
      { tag: { $in: normalizedTags } },
      { $inc: { publishedReelsCount: -1 } },
    );
    await this.model.deleteMany({
      tag: { $in: normalizedTags },
      publishedReelsCount: { $lte: 0 },
    });
  }

  /** Tags that contain the (already normalized) query, at most `limit`. */
  async findMatching(
    normalizedQuery: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.model
      .find({ tag: { $regex: escapeRegex(normalizedQuery) } })
      .limit(limit)
      .select({ tag: 1 })
      .lean<Array<{ tag: string }>>()
      .exec();
    return rows.map((row) => row.tag);
  }
}

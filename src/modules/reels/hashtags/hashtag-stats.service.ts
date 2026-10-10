import { Injectable } from '@nestjs/common';
import { HashtagStatsRepository } from './hashtag-stats.repository';

/** The most tags a search matches: the same cap research R9 puts on the dictionary scan. */
export const MAX_MATCHING_TAGS = 200;

/** A hashtag as a reel carries it: the matching form and the spelling as typed. */
export interface ReelHashtag {
  normalized: string;
  display: string;
}

/**
 * The hashtag dictionary (research R9): how many published reels carry each normalized tag. The
 * lifecycle keeps it in step with reel status, so a tag appears in search while at least one
 * published reel carries it and is gone when the last one is hidden, rejected or deleted.
 */
@Injectable()
export class HashtagStatsService {
  constructor(private readonly stats: HashtagStatsRepository) {}

  /** A reel was published or restored. Duplicate tags on one reel count once. */
  async increment(tags: ReelHashtag[]): Promise<void> {
    await this.stats.increment(uniqueByTag(tags));
  }

  /** A published reel was hidden, rejected or deleted. */
  async decrement(normalizedTags: string[]): Promise<void> {
    await this.stats.decrement([...new Set(normalizedTags)]);
  }

  /** The normalized tags that contain the normalized query. Empty for an empty query. */
  async findMatching(
    normalizedQuery: string,
    limit = MAX_MATCHING_TAGS,
  ): Promise<string[]> {
    const query = normalizedQuery.trim();
    if (query.length === 0) return [];
    return this.stats.findMatching(query, limit);
  }
}

function uniqueByTag(tags: ReelHashtag[]): ReelHashtag[] {
  const seen = new Map<string, ReelHashtag>();
  for (const tag of tags) {
    if (tag.normalized !== '' && !seen.has(tag.normalized)) {
      seen.set(tag.normalized, tag);
    }
  }
  return [...seen.values()];
}

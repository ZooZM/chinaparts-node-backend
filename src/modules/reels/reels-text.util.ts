import { Model } from 'mongoose';
import { UserDocument } from '../users/schemas/user.schema';

const HASHTAG_RE = /#([a-zA-Z0-9_]+)/g;
const MENTION_RE = /@([a-zA-Z0-9_.]+)/g;

/**
 * FR-047: parses a reel description into normalized hashtags and resolved
 * mentions. Only `@username`s that match an existing account become
 * mentions (FR-047) — unresolved ones stay as plain text on the client.
 */
export async function parseHashtagsAndMentions(
  description: string,
  userModel: Model<UserDocument>,
): Promise<{
  hashtags: string[];
  mentions: { userId: string; username: string }[];
}> {
  const hashtags = [
    ...new Set(
      [...description.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()),
    ),
  ];

  const candidateUsernames = [
    ...new Set(
      [...description.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()),
    ),
  ];
  if (candidateUsernames.length === 0) {
    return { hashtags, mentions: [] };
  }

  const resolved = await userModel
    .find({ username: { $in: candidateUsernames } })
    .select('_id username')
    .lean()
    .exec();

  const mentions = resolved.map((u) => ({
    userId: u._id.toString(),
    username: u.username as string,
  }));

  return { hashtags, mentions };
}

import {
  HASHTAG_PATTERN,
  MENTION_PATTERN,
  normalizeForMatch,
} from '../../common/text/normalize-for-match';

export interface ResolvedMention {
  userId: string;
  username: string;
}

/** Resolves normalized handles to the accounts that own them. Unknown handles are simply absent. */
export type MentionResolver = (
  normalizedHandles: string[],
) => Promise<ResolvedMention[]>;

export interface ParsedReelText {
  /** As typed, without `#`, deduplicated by normalized form: what a reel displays. */
  hashtags: string[];
  /** `normalizeForMatch` of each hashtag, in the same order: what every match uses. */
  hashtagsNormalized: string[];
  mentions: ResolvedMention[];
}

/**
 * Parses a reel description into hashtags and resolved mentions (FR-028, research R8).
 *
 * Hashtags and mentions are recognised in Arabic script, Latin script, digits and underscores, so
 * `#فلتر_زيت` and `#كامري_٢٠١٨` are kept, where the old Latin-only pattern dropped them. #إطارات
 * and #اطارات are the same hashtag: the first spelling is displayed and the normalized form is
 * what matches. Only @mentions of existing handles become mentions; the rest stay plain text.
 */
export async function parseHashtagsAndMentions(
  description: string,
  resolveMentions: MentionResolver,
): Promise<ParsedReelText> {
  const hashtags: string[] = [];
  const hashtagsNormalized: string[] = [];
  const seen = new Set<string>();
  for (const match of description.matchAll(HASHTAG_PATTERN)) {
    const display = match[1];
    const normalized = normalizeForMatch(display);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    hashtags.push(display);
    hashtagsNormalized.push(normalized);
  }

  // A handle may legitimately contain a period, so "@ahmed." at the end of a sentence is tried as
  // written first and then without the trailing period.
  const candidatesByMatch: string[][] = [];
  const wanted = new Set<string>();
  for (const match of description.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    const candidates = [normalizeForMatch(raw)];
    const trimmed = raw.replace(/\.+$/, '');
    if (trimmed && trimmed !== raw) candidates.push(normalizeForMatch(trimmed));
    candidatesByMatch.push(candidates);
    candidates.forEach((candidate) => wanted.add(candidate));
  }
  if (wanted.size === 0) return { hashtags, hashtagsNormalized, mentions: [] };

  const accounts = await resolveMentions([...wanted]);
  const byHandle = new Map(
    accounts.map((account) => [normalizeForMatch(account.username), account]),
  );

  const mentions: ResolvedMention[] = [];
  const mentioned = new Set<string>();
  for (const candidates of candidatesByMatch) {
    const account = candidates
      .map((candidate) => byHandle.get(candidate))
      .find((found) => found !== undefined);
    if (!account || mentioned.has(account.userId)) continue;
    mentioned.add(account.userId);
    mentions.push({ userId: account.userId, username: account.username });
  }
  return { hashtags, hashtagsNormalized, mentions };
}

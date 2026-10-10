import {
  MentionResolver,
  parseHashtagsAndMentions,
  ResolvedMention,
} from './reels-text.util';

const accounts: ResolvedMention[] = [
  { userId: 'u-riyadh', username: 'قطع_الرياض' },
  { userId: 'u-ahmed', username: 'ahmed' },
  { userId: 'u-dotted', username: 'a.b' },
];

function resolver(): { resolve: MentionResolver; calls: string[][] } {
  const calls: string[][] = [];
  const resolve: MentionResolver = (handles) => {
    calls.push(handles);
    // The real resolver matches on the normalized handle.
    return Promise.resolve(
      accounts.filter((account) =>
        handles.includes(account.username.toLowerCase()),
      ),
    );
  };
  return { resolve, calls };
}

describe('parseHashtagsAndMentions (FR-028)', () => {
  describe('hashtags', () => {
    it('keeps Arabic, Latin and digit hashtags exactly as typed, and normalizes them for matching', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        'فلتر زيت أصلي #فلتر_زيت #OilFilter #كامري_٢٠١٨',
        resolve,
      );
      expect(parsed.hashtags).toEqual(['فلتر_زيت', 'OilFilter', 'كامري_٢٠١٨']);
      expect(parsed.hashtagsNormalized).toEqual([
        'فلتر_زيت',
        'oilfilter',
        'كامري_2018',
      ]);
    });

    it('treats spelling variants as one hashtag, displaying the first spelling', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        '#إطارات و #اطارات',
        resolve,
      );
      expect(parsed.hashtags).toEqual(['إطارات']);
      expect(parsed.hashtagsNormalized).toEqual(['اطارات']);
    });

    it('does not split a hashtag at a diacritic', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions('#فِلْتَر', resolve);
      expect(parsed.hashtags).toEqual(['فِلْتَر']);
      expect(parsed.hashtagsNormalized).toEqual(['فلتر']);
    });

    it('de-duplicates case variants', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        '#Brake #brake #BRAKE',
        resolve,
      );
      expect(parsed.hashtags).toEqual(['Brake']);
    });

    it('keeps every hashtag in a description that mixes languages, digits and emoji', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        'عرض 😀 #تويوتا_2020 and #BMW_X5 🚗 #٣٠٠',
        resolve,
      );
      expect(parsed.hashtags).toEqual(['تويوتا_2020', 'BMW_X5', '٣٠٠']);
      expect(parsed.hashtagsNormalized).toEqual([
        'تويوتا_2020',
        'bmw_x5',
        '300',
      ]);
    });

    it('returns nothing for a description without hashtags', async () => {
      const { resolve } = resolver();
      expect(await parseHashtagsAndMentions('no tags here', resolve)).toEqual({
        hashtags: [],
        hashtagsNormalized: [],
        mentions: [],
      });
    });

    it('ignores a lone #', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions('# #! #', resolve);
      expect(parsed.hashtags).toEqual([]);
    });
  });

  describe('mentions', () => {
    it('resolves only handles that exist (FR-028)', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        'شكرا @ahmed و @nobody',
        resolve,
      );
      expect(parsed.mentions).toEqual([
        { userId: 'u-ahmed', username: 'ahmed' },
      ]);
    });

    it('resolves Arabic handles', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions('من @قطع_الرياض', resolve);
      expect(parsed.mentions).toEqual([
        { userId: 'u-riyadh', username: 'قطع_الرياض' },
      ]);
    });

    it('matches a handle regardless of case', async () => {
      const { resolve, calls } = resolver();
      const parsed = await parseHashtagsAndMentions('@AHMED', resolve);
      expect(calls[0]).toContain('ahmed');
      expect(parsed.mentions[0].userId).toBe('u-ahmed');
    });

    it('finds a handle at the end of a sentence, without its period', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions('thanks @ahmed.', resolve);
      expect(parsed.mentions).toEqual([
        { userId: 'u-ahmed', username: 'ahmed' },
      ]);
    });

    it('prefers a handle that really contains a period', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions('hi @a.b', resolve);
      expect(parsed.mentions).toEqual([
        { userId: 'u-dotted', username: 'a.b' },
      ]);
    });

    it('mentions an account once, however often it is named', async () => {
      const { resolve } = resolver();
      const parsed = await parseHashtagsAndMentions(
        '@ahmed @AHMED @ahmed.',
        resolve,
      );
      expect(parsed.mentions).toHaveLength(1);
    });

    it('does not call the resolver when there is nothing to resolve', async () => {
      const { resolve, calls } = resolver();
      await parseHashtagsAndMentions('just #tags', resolve);
      expect(calls).toHaveLength(0);
    });

    it('asks the resolver once, for every distinct handle', async () => {
      const { resolve, calls } = resolver();
      await parseHashtagsAndMentions('@ahmed @قطع_الرياض @ahmed', resolve);
      expect(calls).toHaveLength(1);
      expect(calls[0].sort()).toEqual(['ahmed', 'قطع_الرياض']);
    });
  });
});

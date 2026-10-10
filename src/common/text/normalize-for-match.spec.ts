import {
  HASHTAG_PATTERN,
  MENTION_PATTERN,
  normalizeForMatch,
} from './normalize-for-match';

describe('normalizeForMatch (FR-049a, SC-009)', () => {
  const table: Array<[string, string, string]> = [
    // [description, input, expected]
    ['alef with hamza above', 'أحمد', 'احمد'],
    ['alef with hamza below', 'إسلام', 'اسلام'],
    ['alef with madda', 'آمن', 'امن'],
    ['alef wasla', 'ٱلله', 'الله'],
    ['a decomposed alef + madda mark', 'آ', 'ا'],
    ['alef maksura to yaa', 'مستشفى', 'مستشفي'],
    ['taa marbuta to haa', 'مدرسة', 'مدرسه'],
    ['the spec example: إطارات', 'إطارات', 'اطارات'],
    ['diacritics are removed', 'فِلْتَر', 'فلتر'],
    ['superscript alef is removed', 'هٰذا', 'هذا'],
    ['tatweel is removed', 'جـــميل', 'جميل'],
    ['Arabic-Indic digits', '٢٠١٨', '2018'],
    ['Persian digits', '۲۰۱۸', '2018'],
    ['all ten Arabic-Indic digits', '٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['Latin case', 'OilFilter', 'oilfilter'],
    ['fullwidth Latin and digits fold to ASCII', 'ＡＢＣ１', 'abc1'],
    ['an Arabic presentation form (ﷲ)', 'ﷲ', 'الله'],
    [
      'mixed Arabic, Latin, digits and emoji',
      'كامري_٢٠١٨ Toyota 😀',
      'كامري_2018 toyota 😀',
    ],
    ['already normalized text is untouched', 'فلتر_زيت', 'فلتر_زيت'],
    ['the empty string', '', ''],
  ];

  it.each(table)('%s', (_description, input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const [, input] of table) {
      const once = normalizeForMatch(input);
      expect(normalizeForMatch(once)).toBe(once);
    }
  });

  it('makes spelling variants of the same word equal', () => {
    expect(normalizeForMatch('إطارات')).toBe(normalizeForMatch('اطارات'));
    expect(normalizeForMatch('أحمد')).toBe(normalizeForMatch('احمد'));
    expect(normalizeForMatch('كامري_٢٠١٨')).toBe(
      normalizeForMatch('كامري_2018'),
    );
  });

  it('lets a substring search match across variants (SC-009)', () => {
    const tag = normalizeForMatch('كامري_٢٠١٨');
    expect(tag.includes(normalizeForMatch('2018'))).toBe(true);
    expect(
      normalizeForMatch('#إطارات').includes(normalizeForMatch('اطار')),
    ).toBe(true);
    expect(
      normalizeForMatch('OilFilter').includes(normalizeForMatch('oilfilter')),
    ).toBe(true);
  });
});

describe('HASHTAG_PATTERN and MENTION_PATTERN (FR-028)', () => {
  const tags = (text: string) =>
    [...text.matchAll(HASHTAG_PATTERN)].map((match) => match[1]);
  const mentions = (text: string) =>
    [...text.matchAll(MENTION_PATTERN)].map((match) => match[1]);

  it('recognises Arabic, Latin, digits and underscores in hashtags', () => {
    expect(tags('#فلتر_زيت #OilFilter #كامري_٢٠١٨ #abc_123')).toEqual([
      'فلتر_زيت',
      'OilFilter',
      'كامري_٢٠١٨',
      'abc_123',
    ]);
  });

  it('keeps a hashtag whole when it contains diacritics', () => {
    expect(tags('#فِلْتَر')).toEqual(['فِلْتَر']);
  });

  it('stops a hashtag at punctuation, spaces and emoji', () => {
    expect(tags('#one, #two! #three😀 #four-five')).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  it('recognises Arabic and dotted handles in mentions', () => {
    expect(mentions('شكرا @قطع_الرياض و @ahmed.k')).toEqual([
      'قطع_الرياض',
      'ahmed.k',
    ]);
  });

  it('is safe to reuse: matchAll never leaks lastIndex between calls', () => {
    expect(tags('#a #b')).toEqual(['a', 'b']);
    expect(tags('#a #b')).toEqual(['a', 'b']);
  });
});

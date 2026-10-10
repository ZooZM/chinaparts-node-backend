/**
 * One pure function, applied to stored hashtags, handles, public names, and every search query or
 * hashtag lookup (research R8, FR-049a). Matching ignores common Arabic spelling variants,
 * diacritics, the stretching character, and the choice of digit style, so "اطار" finds "#إطارات"
 * and "2018" finds "#كامري_٢٠١٨".
 *
 * It never changes what a reel *displays*: reels keep each hashtag exactly as typed and store the
 * normalized form alongside it for matching only.
 */

// Tashkeel (U+064B to U+065F), superscript alef (U+0670), and tatweel/kashida (U+0640).
const DIACRITICS_AND_TATWEEL = /[ً-ٰٟـ]/g;
const ALEF_VARIANTS = /[أإآٱ]/g; // أ إ آ ٱ
const ARABIC_INDIC_DIGITS = /[٠-٩]/g; // ٠ to ٩
const EXTENDED_ARABIC_INDIC_DIGITS = /[۰-۹]/g; // ۰ to ۹ (Persian)

export function normalizeForMatch(text: string): string {
  return (
    text
      // Folds Arabic presentation forms into their base letters, and fullwidth Latin into ASCII.
      .normalize('NFKC')
      .toLowerCase()
      .replace(DIACRITICS_AND_TATWEEL, '')
      .replace(ALEF_VARIANTS, 'ا') // ا
      .replace(/ى/g, 'ي') // ى -> ي
      .replace(/ة/g, 'ه') // ة -> ه
      .replace(ARABIC_INDIC_DIGITS, (digit) =>
        String(digit.charCodeAt(0) - 0x0660),
      )
      .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) =>
        String(digit.charCodeAt(0) - 0x06f0),
      )
  );
}

/**
 * Hashtags and mentions are recognised in Arabic script, Latin script, digits, and underscores
 * (FR-028). The `u` flag is required for the property classes, and marks (`\p{M}`) are included
 * so a diacritic never cuts a tag in half. Both patterns are global: use `matchAll`, which
 * clones the regex, rather than `exec`, which would keep state in `lastIndex`.
 */
export const HASHTAG_PATTERN = /#([\p{L}\p{M}\p{N}_]+)/gu;
export const MENTION_PATTERN = /@([\p{L}\p{M}\p{N}_.]+)/gu;

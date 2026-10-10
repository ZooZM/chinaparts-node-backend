import { generateHandleBase, isValidHandle, withSuffix } from './handle.util';

describe('generateHandleBase (FR-015, research R6)', () => {
  it('keeps an Arabic-only shop name Arabic', () => {
    expect(generateHandleBase('قطع غيار الرياض', 'seller')).toBe(
      'قطع_غيار_الرياض',
    );
  });

  it('turns spaces into underscores and strips the rest', () => {
    expect(generateHandleBase('Riyadh Parts & Co.', 'seller')).toBe(
      'Riyadh_Parts_Co',
    );
    expect(generateHandleBase('  Sara   K. ', 'customer')).toBe('Sara_K');
  });

  it('keeps digits, marks, underscores and dots', () => {
    expect(generateHandleBase('auto.parts_24', 'seller')).toBe('auto.parts_24');
    expect(generateHandleBase('فِلْتَر', 'seller')).toBe('فِلْتَر');
  });

  it('cuts to 30 characters', () => {
    const base = generateHandleBase('a'.repeat(60), 'seller');
    expect(Array.from(base)).toHaveLength(30);
  });

  it('cuts by characters, not UTF-16 units', () => {
    const base = generateHandleBase('ب'.repeat(40), 'seller');
    expect(Array.from(base)).toHaveLength(30);
  });

  it('strips edges that would look odd: leading and trailing dots or underscores', () => {
    expect(generateHandleBase('__.abc.__', 'customer')).toBe('abc');
  });

  it.each([
    ['', 'seller', 'shop'],
    ['', 'customer', 'user'],
    ['ab', 'seller', 'shop'],
    ['!!!', 'customer', 'user'],
    ['😀😀', 'seller', 'shop'],
    ['A.', 'customer', 'user'],
  ])('falls back when %p is too short for a %s', (name, type, expected) => {
    expect(generateHandleBase(name, type as 'seller' | 'customer')).toBe(
      expected,
    );
  });

  it('always produces a valid handle', () => {
    for (const name of [
      'قطع',
      'x',
      '',
      '$$$',
      'Zoë Émile',
      '😀 emoji shop',
      '١٢٣',
    ]) {
      for (const type of ['seller', 'customer'] as const) {
        expect(isValidHandle(generateHandleBase(name, type))).toBe(true);
      }
    }
  });
});

describe('isValidHandle', () => {
  it.each([
    'abc',
    'a.b',
    'a_b',
    'قطع_الرياض',
    'Ahmed2',
    'x'.repeat(30),
    'فِلْتَر',
  ])('accepts %p', (value) => expect(isValidHandle(value)).toBe(true));

  it.each([
    'ab',
    'x'.repeat(31),
    'has space',
    'has-dash',
    'emoji😀',
    '@name',
    '#tag',
    '',
    'tab\t',
    'a/b',
  ])('rejects %p', (value) => expect(isValidHandle(value)).toBe(false));
});

describe('withSuffix', () => {
  it('appends the suffix', () => {
    expect(withSuffix('Sara_K', '_2')).toBe('Sara_K_2');
  });

  it('makes room by cutting the base, so the handle stays within 30', () => {
    const result = withSuffix('a'.repeat(30), '_2');
    expect(Array.from(result)).toHaveLength(30);
    expect(result.endsWith('_2')).toBe(true);
    expect(isValidHandle(result)).toBe(true);
  });

  it('counts characters, not UTF-16 units', () => {
    const result = withSuffix('ب'.repeat(30), '_12');
    expect(Array.from(result)).toHaveLength(30);
  });
});

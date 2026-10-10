import { escapeRegex } from './escape-regex';

describe('escapeRegex', () => {
  it.each([
    ['plain', 'plain'],
    ['a.b', 'a\\.b'],
    ['(x)', '\\(x\\)'],
    ['a+b*c?', 'a\\+b\\*c\\?'],
    ['[a-z]', '\\[a-z\\]'],
    ['^start$', '\\^start\\$'],
    ['a|b', 'a\\|b'],
    ['back\\slash', 'back\\\\slash'],
    ['فلتر', 'فلتر'],
  ])('%s -> %s', (input, expected) => {
    expect(escapeRegex(input)).toBe(expected);
  });

  it('makes every metacharacter match only itself', () => {
    const hostile = '.*+?^${}()|[]\\';
    expect(new RegExp(escapeRegex(hostile)).test(hostile)).toBe(true);
    expect(new RegExp(`^${escapeRegex('a.c')}$`).test('abc')).toBe(false);
  });
});

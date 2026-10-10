import { ConfigService } from '@nestjs/config';
import { ValidationArguments } from 'class-validator';
import { MaxLengthFromConfigConstraint } from './max-length-from-config';

function constraint(values: Record<string, unknown>) {
  return new MaxLengthFromConfigConstraint({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

const args = (property = 'text'): ValidationArguments =>
  ({
    property,
    constraints: ['REEL_COMMENT_MAX_LENGTH'],
  }) as ValidationArguments;

describe('MaxLengthFromConfigConstraint', () => {
  const c = constraint({ REEL_COMMENT_MAX_LENGTH: 5 });

  it('accepts a value up to the configured limit and rejects one above it', () => {
    expect(c.validate('12345', args())).toBe(true);
    expect(c.validate('123456', args())).toBe(false);
  });

  it('measures after trimming', () => {
    expect(c.validate('   12345   ', args())).toBe(true);
  });

  it('counts code points, so an emoji or Arabic letter is one character', () => {
    expect(c.validate('😀😀😀😀😀', args())).toBe(true);
    expect(c.validate('😀😀😀😀😀😀', args())).toBe(false);
    expect(c.validate('فلتر', args())).toBe(true);
  });

  it('leaves presence to other decorators', () => {
    expect(c.validate(undefined, args())).toBe(true);
    expect(c.validate(null, args())).toBe(true);
  });

  it('rejects a non-string', () => {
    expect(c.validate(12345, args())).toBe(false);
    expect(c.validate(['a'], args())).toBe(false);
  });

  it('follows configuration, not a constant (FR-070)', () => {
    const wide = constraint({ REEL_COMMENT_MAX_LENGTH: 500 });
    expect(wide.validate('a'.repeat(500), args())).toBe(true);
    expect(wide.validate('a'.repeat(501), args())).toBe(false);
  });

  it('states the limit in its message', () => {
    expect(c.defaultMessage(args('text'))).toBe(
      'text must be at most 5 characters',
    );
  });

  it('fails loudly when the configured limit is missing', () => {
    expect(() => constraint({}).validate('x', args())).toThrow(
      /REEL_COMMENT_MAX_LENGTH/,
    );
  });
});

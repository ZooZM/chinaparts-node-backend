/**
 * Exact decimal arithmetic for prices. A price is a decimal string in China Parts, and it goes out
 * as one: it never passes through a floating-point number, where 0.145 is 0.14499999999999999 and
 * rounds the wrong way. Values are held as fractions of BigInts, so a conversion and a discount
 * are exact and the only rounding is the final one, half up, to two decimals.
 */
export interface Fraction {
  num: bigint;
  den: bigint;
}

/** "45.00" as 4500/100. Returns null for anything that is not a non-negative decimal number. */
export function parseDecimal(value: string): Fraction | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  return {
    num: BigInt(match[1] + fraction),
    den: 10n ** BigInt(fraction.length),
  };
}

export function multiply(a: Fraction, b: Fraction): Fraction {
  return { num: a.num * b.num, den: a.den * b.den };
}

/** `a / b`. The caller has checked that `b` is not zero. */
export function divide(a: Fraction, b: Fraction): Fraction {
  return { num: a.num * b.den, den: a.den * b.num };
}

/** `value` rounded half up to two decimals, as a string such as "40.50". */
export function toMoney(value: Fraction): string {
  // floor(value * 100 + 1/2), with everything kept as integers.
  const cents = (2n * value.num * 100n + value.den) / (2n * value.den);
  const whole = cents / 100n;
  const rest = cents % 100n;
  return `${whole}.${rest.toString().padStart(2, '0')}`;
}

export function isZero(value: Fraction): boolean {
  return value.num === 0n;
}

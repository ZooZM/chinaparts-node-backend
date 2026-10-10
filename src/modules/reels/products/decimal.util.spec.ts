import {
  divide,
  isZero,
  multiply,
  parseDecimal,
  toMoney,
} from './decimal.util';

const d = (value: string) => {
  const parsed = parseDecimal(value);
  if (!parsed) throw new Error(`not a decimal: ${value}`);
  return parsed;
};

describe('decimal arithmetic for prices', () => {
  describe('parseDecimal', () => {
    it.each(['0', '45', '45.00', '0.266667', '  12.5 ', '1234567890.123456'])(
      'reads %p',
      (value) => {
        expect(parseDecimal(value)).not.toBeNull();
      },
    );

    it.each(['', 'abc', '-1', '1,5', '1e3', '.5', '5.', '1.2.3', 'NaN'])(
      'refuses %p',
      (value) => {
        expect(parseDecimal(value)).toBeNull();
      },
    );
  });

  describe('toMoney', () => {
    it.each([
      ['45', '45.00'],
      ['45.5', '45.50'],
      ['0', '0.00'],
      ['0.004', '0.00'],
      ['0.005', '0.01'],
      ['0.145', '0.15'], // a float would give 0.14: 0.145 is 0.14499999999999999
      ['1.005', '1.01'], // and 1.005 would give 1.00
      ['2.675', '2.68'],
      ['99.994', '99.99'],
      ['99.995', '100.00'],
      ['1234567.891', '1234567.89'],
    ])('rounds %p half up to %p', (input, expected) => {
      expect(toMoney(d(input))).toBe(expected);
    });
  });

  it('multiplies and divides exactly', () => {
    // 45.00 x 0.266667 = 12.000015
    expect(toMoney(multiply(d('45.00'), d('0.266667')))).toBe('12.00');
    // 45.00 / 0.266667 = 168.74989...
    expect(toMoney(divide(d('45.00'), d('0.266667')))).toBe('168.75');
    // 1 / 3 as a fraction, rounded once at the end.
    expect(toMoney(divide(d('1'), d('3')))).toBe('0.33');
    expect(toMoney(divide(d('2'), d('3')))).toBe('0.67');
  });

  it('knows zero', () => {
    expect(isZero(d('0.000'))).toBe(true);
    expect(isZero(d('0.001'))).toBe(false);
  });
});

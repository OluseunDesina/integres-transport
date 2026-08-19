import { formatMoney, multiplyDecimal } from './money';

describe('multiplyDecimal', () => {
  it('keeps the scale the server sent', () => {
    expect(multiplyDecimal('750.00', 2)).toBe('1500.00');
  });

  it('returns a zero total for no seats', () => {
    expect(multiplyDecimal('750.00', 0)).toBe('0.00');
  });

  it('is exact where binary floating point is not', () => {
    // 0.10 * 3 is 0.30000000000000004 as a JS number.
    expect(multiplyDecimal('0.10', 3)).toBe('0.30');
  });

  it('carries into a new digit correctly', () => {
    expect(multiplyDecimal('0.05', 5)).toBe('0.25');
    expect(multiplyDecimal('99.99', 4)).toBe('399.96');
  });

  it('handles an integer amount with no decimal point', () => {
    expect(multiplyDecimal('750', 3)).toBe('2250');
  });

  it('rejects a non-integer seat count', () => {
    expect(() => multiplyDecimal('10.00', 1.5)).toThrowError(/non-negative integer/);
  });
});

describe('formatMoney', () => {
  it('prefixes the Business currency rather than a platform default', () => {
    expect(formatMoney('1500.00', 'NGN')).toBe('NGN 1500.00');
    expect(formatMoney('120.00', 'BWP')).toBe('BWP 120.00');
  });
});

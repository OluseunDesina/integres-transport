import { plural, summaryLine } from './summary-line';

describe('summaryLine', () => {
  it('joins parts with a middot', () => {
    expect(summaryLine(['LAG-IBD', '6 stops'])).toBe('LAG-IBD · 6 stops');
  });

  // The reason this is a function and not a template literal: a route
  // with no code rendered " · 6 stops" when it was inlined per screen.
  it('drops empty parts rather than leaving a dangling separator', () => {
    expect(summaryLine([null, '6 stops'])).toBe('6 stops');
    expect(summaryLine(['LAG-IBD', undefined, ''])).toBe('LAG-IBD');
    expect(summaryLine(['   ', 'Active'])).toBe('Active');
  });

  it('keeps a zero, which is a real value', () => {
    expect(summaryLine([0, 'seats held'])).toBe('0 · seats held');
  });

  it('returns an empty string when nothing survives', () => {
    expect(summaryLine([null, undefined, ''])).toBe('');
  });
});

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'stop')).toBe('1 stop');
  });

  it('uses the plural otherwise', () => {
    expect(plural(0, 'stop')).toBe('0 stops');
    expect(plural(6, 'stop')).toBe('6 stops');
  });

  it('takes an explicit plural for words the trailing s gets wrong', () => {
    expect(plural(2, 'journey', 'journeys')).toBe('2 journeys');
  });
});

import { addDays, parseIsoDate, toIsoDate, todayIso } from './dates';

describe('dates', () => {
  it('formats a local date without a UTC shift', () => {
    // 00:30 local — toISOString() would name the previous day east of UTC.
    expect(toIsoDate(new Date(2026, 8, 1, 0, 30))).toBe('2026-09-01');
  });

  it('parses as local midnight', () => {
    const date = parseIsoDate('2026-09-01');
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 8, 1, 0]);
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('names today from a given clock', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

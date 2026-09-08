import { expandBuckets, toTrendPoints } from './trend-buckets';

describe('expandBuckets', () => {
  it('lists every day in an inclusive range', () => {
    expect(expandBuckets('2026-08-01', '2026-08-04', 'day')).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
    ]);
  });

  it('crosses a month boundary without drifting', () => {
    expect(expandBuckets('2026-08-30', '2026-09-02', 'day')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('handles a leap day', () => {
    expect(expandBuckets('2028-02-28', '2028-03-01', 'day')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('starts week buckets on the Monday on or before the range start', () => {
    // Postgres date_trunc('week') and therefore Django's TruncWeek both
    // land on Monday; an axis starting anywhere else would match none of
    // the dates the endpoint returns.
    // 2026-08-05 is a Wednesday; its week bucket is Monday 2026-08-03.
    expect(expandBuckets('2026-08-05', '2026-08-20', 'week')).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
  });

  it('leaves a Monday start where it is', () => {
    expect(expandBuckets('2026-08-03', '2026-08-09', 'week')).toEqual(['2026-08-03']);
  });

  it('starts month buckets on the first of the month', () => {
    expect(expandBuckets('2026-06-15', '2026-09-02', 'month')).toEqual([
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('returns nothing for a reversed or unparseable range', () => {
    expect(expandBuckets('2026-08-04', '2026-08-01', 'day')).toEqual([]);
    expect(expandBuckets('not-a-date', '2026-08-01', 'day')).toEqual([]);
  });

  it('does not drift in a negative-offset timezone', () => {
    // The bug this guards: `new Date('2026-08-01')` is UTC midnight, so
    // `getDate()` in UTC-5 reads 31 July and the whole axis shifts a day.
    // Every step here is a getUTC*/setUTC* call, so the result cannot
    // depend on where the browser is.
    const days = expandBuckets('2026-08-01', '2026-08-03', 'day');
    expect(days[0]).toBe('2026-08-01');
  });
});

describe('toTrendPoints', () => {
  it('marks a bucket the endpoint omitted as a gap, never a zero', () => {
    const points = toTrendPoints('2026-08-01', '2026-08-03', 'day', [
      { date: '2026-08-01', value: 100 },
      { date: '2026-08-03', value: 300 },
    ]);

    expect(points).toEqual([
      { label: '2026-08-01', value: 100 },
      { label: '2026-08-02', value: null },
      { label: '2026-08-03', value: 300 },
    ]);
  });

  it('keeps a real zero as a zero', () => {
    const points = toTrendPoints('2026-08-01', '2026-08-01', 'day', [
      { date: '2026-08-01', value: 0 },
    ]);
    expect(points).toEqual([{ label: '2026-08-01', value: 0 }]);
  });

  it('renders an empty period as an all-gap axis', () => {
    const points = toTrendPoints('2026-08-01', '2026-08-02', 'day', []);
    expect(points).toEqual([
      { label: '2026-08-01', value: null },
      { label: '2026-08-02', value: null },
    ]);
  });

  it('falls back to the raw points when a returned date is off the axis', () => {
    // Dropping real data would be far worse than failing to show gaps,
    // so a disagreement resolves in the server's favour.
    const points = toTrendPoints('2026-08-01', '2026-08-02', 'day', [
      { date: '2025-01-01', value: 42 },
    ]);
    expect(points).toEqual([{ label: '2025-01-01', value: 42 }]);
  });
});

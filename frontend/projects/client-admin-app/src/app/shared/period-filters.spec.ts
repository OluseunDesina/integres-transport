import type { ParamMap } from '@angular/router';

import { PeriodFilters } from './period-filters';

function params(values: Record<string, string>): ParamMap {
  return { get: (key: string) => values[key] ?? null } as ParamMap;
}

describe('PeriodFilters', () => {
  let filters: PeriodFilters;

  beforeEach(() => {
    filters = new PeriodFilters();
  });

  describe('seeding from the URL', () => {
    it('takes a well-formed period', () => {
      filters.seed(params({ date_from: '2026-08-01', date_to: '2026-08-31', granularity: 'week' }));

      expect(filters.query()).toEqual({
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        granularity: 'week',
      });
    });

    it('ignores a hand-edited URL rather than sending it as a 400', () => {
      filters.seed(params({ date_from: 'last-tuesday', granularity: 'fortnight' }));

      expect(filters.query()).toEqual({
        date_from: undefined,
        date_to: undefined,
        granularity: 'day',
      });
    });
  });

  describe('what reaches the endpoint', () => {
    it('omits a bucket size for a screen that does not bucket', () => {
      // `GET /payments/` is a record list. A parameter that changes no
      // rows is one a later reader has to disprove.
      filters.seed(params({ date_from: '2026-08-01', granularity: 'month' }));

      expect(filters.dateQuery()).toEqual({ date_from: '2026-08-01', date_to: undefined });
      expect('granularity' in filters.dateQuery()).toBeFalse();
    });
  });

  describe('the URL round-trip', () => {
    it('writes only what the operator changed', () => {
      filters.dateFrom.set('2026-08-01');

      // `null` drops a key from the URL; the default granularity is
      // never spelled out, so a shared link stays about the period.
      expect(filters.urlParams()).toEqual({
        date_from: '2026-08-01',
        date_to: null,
        granularity: null,
      });
    });

    it('does spell out a non-default grouping', () => {
      filters.setGranularity('week');
      expect(filters.urlParams()['granularity']).toBe('week');
    });

    it('refuses a granularity it does not recognise', () => {
      filters.setGranularity('fortnight');
      expect(filters.granularity()).toBe('day');
    });
  });

  describe('chips', () => {
    it('names each active part of the period', () => {
      filters.dateFrom.set('2026-08-01');
      filters.dateTo.set('2026-08-31');
      filters.setGranularity('month');

      expect(filters.chips()).toEqual([
        { id: 'date_from', label: 'From', value: '2026-08-01' },
        { id: 'date_to', label: 'To', value: '2026-08-31' },
        { id: 'granularity', label: 'Grouped', value: 'Monthly' },
      ]);
    });

    it('says nothing about a default grouping, which is not a filter', () => {
      filters.dateFrom.set('2026-08-01');
      expect(filters.chips().map((chip) => chip.id)).toEqual(['date_from']);
    });

    it('removes one at a time, and clears the lot', () => {
      filters.dateFrom.set('2026-08-01');
      filters.dateTo.set('2026-08-31');

      filters.remove('date_from');
      expect(filters.chips().map((chip) => chip.id)).toEqual(['date_to']);

      filters.clear();
      expect(filters.chips()).toEqual([]);
    });
  });
});

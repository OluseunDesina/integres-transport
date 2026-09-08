import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';

import { RevenueReport } from './revenue-report';
import { ExportStore } from '../shared/data/store/export.store';
import { RevenueStore, type RevenueReport as Report } from '../shared/data/store/revenue.store';
import { SelectedBusinessStore } from '../shared/data/store/selected-business.store';

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    period: {
      from: '2026-08-01',
      to: '2026-08-03',
      timezone: 'Africa/Lagos',
      granularity: 'day',
    },
    money: [
      {
        currency: 'NGN',
        revenue: '1900.00',
        gross: '2000.00',
        commission: '100.00',
        transaction_volume: 4,
        average_ticket_value: '500.00',
      },
    ],
    trend: [
      { date: '2026-08-01', currency: 'NGN', amount: '900.00' },
      { date: '2026-08-03', currency: 'NGN', amount: '1000.00' },
    ],
    by_route: [
      { route: 'Ikeja → CMS', currency: 'NGN', amount: '2000.00', transaction_volume: 4 },
    ],
    by_trip_class: [
      { trip_class: 'premium', currency: 'NGN', amount: '2000.00', transaction_volume: 4 },
    ],
    by_channel: [
      { channel: 'card', currency: 'NGN', amount: '1500.00', transaction_volume: 3 },
      { channel: 'wallet', currency: 'NGN', amount: '500.00', transaction_volume: 1 },
    ],
    ...overrides,
  };
}

class FakeRevenueStore {
  data = signal<Report | null>(makeReport());
  loading = signal(false);
  error = signal<string | null>(null);
  load = jasmine.createSpy('load').and.resolveTo();
}

class FakeExportStore {
  error = signal<string | null>(null);
  download = jasmine.createSpy('download').and.resolveTo();
  isPending = () => false;
}

class FakeSelectedBusinessStore {
  selectedBusinessId = signal<string | null>('biz-1');
  items = signal<{ id: string; name: string }[]>([{ id: 'biz-1', name: 'Verify Shuttle' }]);
}

describe('RevenueReport', () => {
  let fixture: ComponentFixture<RevenueReport>;
  let store: FakeRevenueStore;
  let exports: FakeExportStore;
  let queryParams: Record<string, string>;

  function setup(): void {
    fixture = TestBed.createComponent(RevenueReport);
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  beforeEach(() => {
    store = new FakeRevenueStore();
    exports = new FakeExportStore();
    queryParams = {};

    TestBed.configureTestingModule({
      imports: [RevenueReport],
      providers: [
        provideRouter([]),
        { provide: RevenueStore, useValue: store },
        { provide: ExportStore, useValue: exports },
        { provide: SelectedBusinessStore, useValue: new FakeSelectedBusinessStore() },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: { get: (key: string) => queryParams[key] ?? null } },
          },
        },
      ],
    });
  });

  it('loads the report for the active business and the seeded period', () => {
    queryParams = { date_from: '2026-07-01', granularity: 'week' };
    setup();

    expect(store.load).toHaveBeenCalledWith({
      business: 'biz-1',
      date_from: '2026-07-01',
      date_to: undefined,
      granularity: 'week',
    });
  });

  it('renders net revenue and gross side by side, never one alone', () => {
    // "Revenue" is ambiguous on a transport dashboard, and an operator
    // reading a gross figure as money they will receive is a real way to
    // be misled.
    setup();

    expect(text()).toContain('NGN 1900.00');
    expect(text()).toContain('NGN 2000.00');
    expect(text()).toContain('NGN 100.00');
  });

  it('renders the three breakdowns', () => {
    setup();

    expect(text()).toContain('Ikeja → CMS');
    expect(text()).toContain('Premium');
    expect(text()).toContain('card');
  });

  describe('charts', () => {
    it('marks a bucket the endpoint omitted as a gap, not a zero', () => {
      setup();

      const table = fixture.debugElement.query(By.css('ui-chart table'))
        .nativeElement as HTMLElement;
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.children).map((cell) => cell.textContent?.trim())
      );
      expect(rows).toEqual([
        ['2026-08-01', 'NGN 900.00'],
        ['2026-08-02', 'No data'],
        ['2026-08-03', 'NGN 1000.00'],
      ]);
    });

    it('gives every chart an accessible data table', () => {
      setup();

      const charts = fixture.debugElement.queryAll(By.css('ui-chart'));
      expect(charts.length).toBe(2);
      for (const chart of charts) {
        expect(chart.query(By.css('table.sr-only'))).not.toBeNull();
      }
    });
  });

  describe('the three states', () => {
    it('renders an error inline', () => {
      store.error.set('A day trend covers at most 92 days.');
      store.data.set(null);
      setup();

      expect(fixture.debugElement.query(By.css('ui-alert')).nativeElement.textContent).toContain(
        'at most 92 days'
      );
    });

    it('renders skeletons while loading', () => {
      store.loading.set(true);
      store.data.set(null);
      setup();

      expect(fixture.debugElement.queryAll(By.css('ui-skeleton')).length).toBeGreaterThan(0);
    });

    it('distinguishes an answered-but-empty period from an error', () => {
      store.data.set(makeReport({ money: [], trend: [], by_route: [], by_trip_class: [] }));
      setup();

      expect(text()).toContain('No revenue in this period');
      // The period still renders: that is what says the request worked.
      expect(text()).toContain('2026-08-01');
      expect(fixture.debugElement.query(By.css('ui-alert'))).toBeNull();
    });
  });

  describe('export', () => {
    it('sends the active business and period with each resource', () => {
      queryParams = { date_from: '2026-08-01', date_to: '2026-08-31' };
      setup();

      const buttons = fixture.debugElement.queryAll(By.css('ui-export-button'));
      buttons[0].triggerEventHandler('exportRequested', { format: 'csv', scope: 'all' });

      expect(exports.download).toHaveBeenCalledWith('revenue', {
        business: 'biz-1',
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        granularity: 'day',
      });
    });

    it('offers one scope, because the server exports the current filters', () => {
      setup();
      const button = fixture.debugElement.query(By.css('ui-export-button'));
      expect(button.componentInstance.scopes()).toEqual(['all']);
    });

    it('renders an export failure inline, not only transiently', () => {
      exports.error.set('This export would contain 61,204 rows.');
      setup();

      expect(text()).toContain('61,204 rows');
    });
  });
});

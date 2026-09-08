import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Alert,
  Chart,
  EmptyState,
  ExportButton,
  FilterBar,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Table,
  TextField,
  formatMoney,
  type ChartSeries,
} from '@shared-ui';

import {
  ExportStore,
  type ExportQuery,
  type ExportResource,
} from '../shared/data/store/export.store';
import { RevenueStore, type RevenueReport as Report } from '../shared/data/store/revenue.store';
import { SelectedBusinessStore } from '../shared/data/store/selected-business.store';
import { GRANULARITY_OPTIONS, PeriodFilters } from '../shared/period-filters';
import { toTrendPoints } from '../shared/trend-buckets';
import { tripClassLabel } from '../shared/trip-class';

type MoneyEntry = Report['money'][number];

function paymentCount(value: number): string {
  return `${value} payment${value === 1 ? '' : 's'}`;
}

/**
 * Revenue reporting — spec 16 slice 4.
 *
 * The brief calls this "one of the most important features", and the
 * whole of it is `GET /analytics/revenue/`: totals, the trend, and three
 * breakdowns. Nothing is derived in the browser, which is the point —
 * `CLAUDE.md` records four production bugs from "fetch a bounded page,
 * then reduce locally", and a revenue report doing it would be that bug
 * class at its most convincing.
 *
 * ## `revenue` is net and `gross` is what passengers paid
 *
 * Both are shown, always, because "revenue" alone is ambiguous on a
 * transport dashboard and an operator reading a gross figure as money
 * they will receive is a real way to be misled. The three breakdowns
 * below are **gross**, and their column says so — an operator comparing
 * routes is asking where the money comes from, not what each route
 * nets after a commission applied uniformly.
 *
 * ## One chart per currency, never a shared axis
 *
 * Same rule as the dashboard: a Naira total and a Pula total on one
 * value axis is the visual form of the addition the API's
 * array-keyed-by-currency shape exists to prevent.
 */
@Component({
  selector: 'app-revenue-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    Alert,
    Chart,
    EmptyState,
    ExportButton,
    FilterBar,
    PageHeader,
    Select,
    Skeleton,
    Stat,
    Table,
    TextField,
  ],
  templateUrl: './revenue-report.html',
})
export class RevenueReport {
  protected readonly store = inject(RevenueStore);
  protected readonly exports = inject(ExportStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);

  protected readonly granularityOptions = GRANULARITY_OPTIONS;
  protected readonly filters = new PeriodFilters();
  protected readonly skeletonCards = [0, 1, 2, 3];
  protected readonly tripClassLabel = tripClassLabel;

  constructor() {
    this.filters.seed(this.activatedRoute.snapshot.queryParamMap);
  }

  /** Same `untracked()`-wrapped effect every business-scoped screen in
   * this app uses. No `load()` call anywhere else in this class. */
  private readonly loadOnChange = effect(() => {
    const business = this.selectedBusinessStore.selectedBusinessId();
    const query = this.filters.query();
    untracked(() => {
      void this.store.load({ business: business ?? undefined, ...query });
    });
  });

  protected onDateFromChange(value: string): void {
    this.filters.dateFrom.set(value);
    this.syncUrl();
  }

  protected onDateToChange(value: string): void {
    this.filters.dateTo.set(value);
    this.syncUrl();
  }

  protected onGranularityChange(value: string): void {
    this.filters.setGranularity(value);
    this.syncUrl();
  }

  protected onChipRemoved(id: string): void {
    this.filters.remove(id);
    this.syncUrl();
  }

  protected onClearFilters(): void {
    this.filters.clear();
    this.syncUrl();
  }

  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: this.filters.urlParams(),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected readonly period = computed(() => this.store.data()?.period ?? null);

  /** Answered, and empty — a different screen from "failed" and from
   * "still loading". The `period` echo is what makes the three
   * distinguishable at all. */
  protected readonly isEmptyPeriod = computed(() => {
    const data = this.store.data();
    return data !== null && data.money.length === 0 && data.trend.length === 0;
  });

  protected moneyLabel(entry: MoneyEntry, amount: string): string {
    return formatMoney(amount, entry.currency);
  }

  protected trendSeries(entry: MoneyEntry): ChartSeries[] {
    const period = this.period();
    const points = (this.store.data()?.trend ?? [])
      .filter((point) => point.currency === entry.currency)
      .map((point) => ({ date: point.date, value: Number(point.amount) }));
    if (!period) {
      return [{ name: entry.currency, points: [] }];
    }
    return [
      {
        name: entry.currency,
        points: toTrendPoints(period.from, period.to, this.filters.granularity(), points),
      },
    ];
  }

  protected trendFormatter(entry: MoneyEntry): (value: number) => string {
    return (value: number) => formatMoney(value.toFixed(2), entry.currency);
  }

  /** The channel mix, as the one doughnut in this console.
   *
   * Summed across currencies **on purpose and only here**: this is a
   * share-of-methods question ("how do passengers pay"), and the slices
   * are labelled by channel, not by money. The amounts beside them stay
   * per-currency in the table below. */
  protected readonly channelSeries = computed<ChartSeries[]>(() => {
    const rows = this.store.data()?.by_channel ?? [];
    const byChannel = new Map<string, number>();
    for (const row of rows) {
      byChannel.set(row.channel, (byChannel.get(row.channel) ?? 0) + row.transaction_volume);
    }
    return [
      {
        name: 'Payments',
        points: [...byChannel].map(([label, value]) => ({ label, value })),
      },
    ];
  });

  protected readonly countFormatter = (value: number): string => paymentCount(value);
  protected readonly paymentCount = paymentCount;

  protected exportRows(resource: ExportResource): void {
    void this.exports.download(resource, this.exportQuery());
  }

  private exportQuery(): ExportQuery {
    return {
      business: this.selectedBusinessStore.selectedBusinessId() ?? undefined,
      ...this.filters.query(),
    };
  }

  protected isExporting(resource: ExportResource): boolean {
    return this.exports.isPending(resource);
  }
}

import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthStore, PermissionsService } from '@auth';
import {
  Alert,
  Chart,
  EmptyState,
  FilterBar,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  StatusPill,
  Table,
  TextField,
  formatMoney,
  type ChartSeries,
  type StatusPillTone,
} from '@shared-ui';

import {
  AdminDashboardStore,
  type Dashboard as DashboardEnvelope,
} from '../shared/data/store/dashboard.store';
import { SelectedBusinessStore } from '../shared/data/store/selected-business.store';
import { GRANULARITY_OPTIONS, PeriodFilters } from '../shared/period-filters';
import { toTrendPoints } from '../shared/trend-buckets';
import {
  severityLabel,
  severityTone,
  statusLabel,
  statusTone,
} from '../shared/incident-labels';

type MoneyEntry = DashboardEnvelope['money'][number];

/**
 * The client-admin dashboard — spec 16 slice 3, and the first consumer
 * of the aggregation endpoints slice 2 built.
 *
 * It replaces `home`'s static list of permission-gated links at the same
 * `/home` path, so every existing landing redirect keeps working.
 *
 * ## Why the route is not gated on `analytics.view`
 *
 * `/home` is where **every** client-admin user lands after signing in,
 * and the Staff preset deliberately does not carry `analytics.view` —
 * revenue totals are a different sensitivity from the operational lists
 * Staff needs. Gating the route would drop a Staff user on the Forbidden
 * page immediately after a successful login. So the route keeps its
 * `client-admin:access` guard, and this component asks for the codename
 * itself: with it, the analytics; without it, the greeting alone, and no
 * request is made at all.
 *
 * ## Money is rendered per currency, never merged
 *
 * `money` is an array keyed by currency because a Client can run an NGN
 * and a BWP Business at once. Each currency gets its own stat block
 * **and its own trend chart** — which is also why the revenue chart is
 * per-currency rather than one chart with a series each: a shared value
 * axis across two currencies would put a Naira total and a Pula total on
 * the same scale, which is the visual form of the addition the API shape
 * exists to prevent.
 */
@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    Alert,
    Chart,
    EmptyState,
    FilterBar,
    PageHeader,
    Select,
    Skeleton,
    Stat,
    StatusPill,
    Table,
    TextField,
  ],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  protected readonly store = inject(AdminDashboardStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly permissionsService = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);

  protected readonly authStore = inject(AuthStore);
  protected readonly granularityOptions = GRANULARITY_OPTIONS;
  protected readonly skeletonCards = [0, 1, 2, 3];

  protected readonly canViewAnalytics = computed(() =>
    this.permissionsService.permissions().has('analytics.view')
  );

  /** Seeded from the URL so a filtered dashboard is linkable — the
   * period is the one thing on this screen worth sending someone.
   * Shared with the revenue and transactions screens, which filter by
   * exactly the same thing. */
  protected readonly filters = new PeriodFilters();

  /**
   * Same `untracked()`-wrapped effect every business-scoped screen in
   * this app uses: fires once `SelectedBusinessStore` resolves an id,
   * again on every business switch, and again on every filter change.
   * There is no `load()` call anywhere else in this class.
   */
  private readonly loadOnChange = effect(() => {
    if (!this.canViewAnalytics()) {
      return;
    }
    const business = this.selectedBusinessStore.selectedBusinessId();
    const query = this.filters.query();
    untracked(() => {
      void this.store.load({ business: business ?? undefined, ...query });
    });
  });

  constructor() {
    this.filters.seed(this.activatedRoute.snapshot.queryParamMap);
  }

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

  protected onClearFilters(): void {
    this.filters.clear();
    this.syncUrl();
  }

  /** `replaceUrl`, so adjusting a date filter does not bury the previous
   * screen under a dozen back-button entries. */
  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: this.filters.urlParams(),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected onChipRemoved(id: string): void {
    this.filters.remove(id);
    this.syncUrl();
  }

  protected readonly period = computed(() => this.store.data()?.period ?? null);

  /**
   * True only when the endpoint answered *and* had nothing to report —
   * which is a different screen from "the request failed" and from
   * "still loading". The `period` echo is what makes the three
   * distinguishable at all, which is exactly what it is in the envelope
   * for.
   */
  protected readonly isEmptyPeriod = computed(() => {
    const data = this.store.data();
    return (
      data !== null &&
      data.money.length === 0 &&
      data.trends.revenue.length === 0 &&
      data.trends.bookings.length === 0 &&
      data.bookings.total === 0
    );
  });

  protected moneyLabel(entry: MoneyEntry, amount: string): string {
    return formatMoney(amount, entry.currency);
  }

  /** One line series per currency, each in its own chart — see the class
   * docstring on why they are never combined. */
  protected revenueSeries(entry: MoneyEntry): ChartSeries[] {
    const period = this.period();
    const points = (this.store.data()?.trends.revenue ?? [])
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

  protected revenueFormatter(entry: MoneyEntry): (value: number) => string {
    return (value: number) => formatMoney(value.toFixed(2), entry.currency);
  }

  protected readonly bookingSeries = computed<ChartSeries[]>(() => {
    const period = this.period();
    const points = (this.store.data()?.trends.bookings ?? []).map((point) => ({
      date: point.date,
      value: point.count,
    }));
    if (!period) {
      return [{ name: 'Bookings', points: [] }];
    }
    return [
      {
        name: 'Bookings',
        points: toTrendPoints(period.from, period.to, this.filters.granularity(), points),
        color: 'var(--color-brand-400)',
      },
    ];
  });

  protected readonly countFormatter = (value: number): string => String(value);

  protected readonly recentTransactions = computed(
    () => this.store.data()?.recent_transactions ?? []
  );

  /** Real since docs/specs/17-incidents.md slice 1 — the envelope shipped
   * this key as an empty array one spec early so filling it in would be
   * additive rather than a breaking change for a frontend already
   * reading the shape. */
  protected readonly recentIncidents = computed(
    () => this.store.data()?.recent_incidents ?? []
  );

  protected readonly severityLabel = severityLabel;
  protected readonly severityTone = severityTone;
  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;

  protected transactionTone(status: string): StatusPillTone {
    switch (status) {
      case 'succeeded':
        return 'positive';
      case 'pending':
        return 'warning';
      case 'failed':
      case 'cancelled':
        return 'negative';
      default:
        return 'neutral';
    }
  }

  /** Blank is "not captured", which every payment predating spec 16
   * slice 1 is — reported as such, never guessed at. */
  protected channelLabel(channel: string): string {
    return channel || 'unknown';
  }
}

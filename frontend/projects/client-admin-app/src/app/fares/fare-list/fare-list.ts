import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import { Alert, Button, EmptyState, Paginator, Table } from '@shared-ui';

import { FareRuleStore } from '../../shared/data/store/fare-rule.store';
import { FareSegmentRuleStore } from '../../shared/data/store/fare-segment-rule.store';
import { RouteStore } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { StopStore } from '../../shared/data/store/stop.store';

/**
 * Lists whichever of `FareRule`/`FareSegmentRule` applies to the
 * active Business's `fare_pricing_mode` — the backend keeps these as
 * two distinct endpoints (see `apps.fares.serializers`'s own module
 * docstring on why), so this screen picks the one to render rather
 * than merging two shapes into one table.
 */
@Component({
  selector: 'app-fare-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    EmptyState,
    Paginator,
    Table,
  ],
  templateUrl: './fare-list.html',
})
export class FareList implements OnInit {
  protected readonly fareRuleStore = inject(FareRuleStore);
  protected readonly fareSegmentRuleStore = inject(FareSegmentRuleStore);
  private readonly routeStore = inject(RouteStore);
  private readonly stopStore = inject(StopStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly selectedBusiness = computed(() =>
    this.selectedBusinessStore
      .items()
      .find((business) => business.id === this.selectedBusinessStore.selectedBusinessId())
  );

  protected readonly isPerSegment = computed(
    () => this.selectedBusiness()?.fare_pricing_mode === 'per_segment'
  );

  protected readonly routeNames = computed(
    () => new Map(this.routeStore.items().map((route) => [route.id, route.name]))
  );
  protected readonly stopNames = computed(
    () => new Map(this.stopStore.items().map((stop) => [stop.id, stop.name]))
  );

  // See ScheduleList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => {
          void this.fareRuleStore.updateQuery({ business: businessId });
          void this.fareSegmentRuleStore.updateQuery({ business: businessId });
        });
      }
    },
    { allowSignalWrites: true }
  );

  ngOnInit(): void {
    void this.routeStore.getAll();
    void this.stopStore.getAll();
  }

  protected onPageChange(offset: number): void {
    if (this.isPerSegment()) {
      void this.fareSegmentRuleStore.changePage(offset);
    } else {
      void this.fareRuleStore.changePage(offset);
    }
  }

  protected async goToNewFare(): Promise<void> {
    await this.router.navigate(['/fares/new']);
  }
}

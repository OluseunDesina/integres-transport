import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import {
  Alert,
  Button,
  DensityToggle,
  EmptyState,
  PageHeader,
  Paginator,
  StatusPill,
  Table,
} from '@shared-ui';
import type { Density } from '@shared-ui';

import { FareRuleStore } from '../../shared/data/store/fare-rule.store';
import { FareSegmentRuleStore } from '../../shared/data/store/fare-segment-rule.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { tripClassLabel } from '../../shared/trip-class';

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
    DensityToggle,
    EmptyState,
    PageHeader,
    Paginator,
    StatusPill,
    Table,
  ],
  templateUrl: './fare-list.html',
})
export class FareList {
  protected readonly tripClassLabel = tripClassLabel;
  protected readonly fareRuleStore = inject(FareRuleStore);
  protected readonly fareSegmentRuleStore = inject(FareSegmentRuleStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );

  protected readonly selectedBusiness = computed(() =>
    this.selectedBusinessStore
      .items()
      .find((business) => business.id === this.selectedBusinessStore.selectedBusinessId())
  );

  protected readonly isPerSegment = computed(
    () => this.selectedBusiness()?.fare_pricing_mode === 'per_segment'
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

  // No `ngOnInit` loading RouteStore/StopStore any more. This screen
  // used to build route- and stop-name maps from those shared root
  // stores, which meant two things: a fare whose route or stop sat
  // outside their loaded page rendered as a raw UUID, and calling
  // `getAll()` here clobbered the routes and stops list screens' own
  // filter and pagination state. The names now come down on the row
  // (`FareRuleSerializer.route_name` and friends).

  protected onPageChange(offset: number): void {
    if (this.isPerSegment()) {
      void this.fareSegmentRuleStore.changePage(offset);
    } else {
      void this.fareRuleStore.changePage(offset);
    }
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected async goToNewFare(): Promise<void> {
    await this.router.navigate(['/fares/new']);
  }
}

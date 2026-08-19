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
import { Alert, Button, EmptyState, Paginator, StatusPill, Table } from '@shared-ui';

import { RouteStore } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { ScheduleStore } from '../../shared/data/store/schedule.store';

const DAY_ABBREVIATIONS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

@Component({
  selector: 'app-schedule-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    EmptyState,
    Paginator,
    StatusPill,
    Table,
  ],
  templateUrl: './schedule-list.html',
})
export class ScheduleList implements OnInit {
  protected readonly store = inject(ScheduleStore);
  private readonly routeStore = inject(RouteStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  protected readonly routeNames = computed(
    () => new Map(this.routeStore.items().map((route) => [route.id, route.name]))
  );

  // See StopList's identical wiring for the full untracked()/effect()
  // reasoning — required on every business-scoped list screen.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  ngOnInit(): void {
    void this.routeStore.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected formatDays(days: number[]): string {
    return [...days]
      .sort((a, b) => a - b)
      .map((day) => DAY_ABBREVIATIONS[day] ?? String(day))
      .join('/');
  }

  protected async goToNewSchedule(): Promise<void> {
    await this.router.navigate(['/schedules/new']);
  }
}

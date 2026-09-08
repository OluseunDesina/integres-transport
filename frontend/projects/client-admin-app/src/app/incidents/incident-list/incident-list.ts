import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  ActionMenu,
  Alert,
  Button,
  DensityToggle,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  StatusPill,
  Table,
  summaryLine,
} from '@shared-ui';
import type { ActionMenuItem, Density } from '@shared-ui';

import { IncidentStore, type Incident } from '../../shared/data/store/incident.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import {
  CATEGORY_FILTER_OPTIONS,
  SEVERITY_FILTER_OPTIONS,
  SOURCE_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  categoryLabel,
  nextStatuses,
  severityLabel,
  severityTone,
  sourceLabel,
  statusLabel,
  statusTone,
  transitionLabel,
} from '../../shared/incident-labels';
import { ListFilters } from '../../shared/list-filters';

const OPEN_ONLY_OPTIONS = [
  { value: 'true', label: 'Open incidents' },
  { value: '', label: 'All incidents' },
];

/**
 * The operator queue — spec 17 slice 2.
 *
 * ## It opens showing open incidents only, and says so
 *
 * `open_only` is seeded in `IncidentStore`'s initial query *and*
 * rendered as a removable chip here. A queue whose default is
 * "everything ever reported" becomes unusable within a month of real
 * use; a queue that quietly hides rows with nothing on screen saying so
 * is the confusion this codebase has already recorded against the KYB
 * queue and against super-admin's "Business not found".
 *
 * ## Status moves from the row, not only from the detail screen
 *
 * Triaging ten reports should not mean ten round trips. The menu offers
 * `nextStatuses()`, which mirrors the backend's own transition table —
 * see `incident-labels.ts` for why that duplication is acceptable. The
 * backend stays authoritative: an illegal move answers 409 and lands in
 * the alert above the table, which deliberately does **not** replace it,
 * since the row it came from still needs to be visible.
 */
@Component({
  selector: 'app-incident-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    HasPermissionDirective,
    ActionMenu,
    Alert,
    Button,
    DensityToggle,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    Select,
    Skeleton,
    StatusPill,
    Table,
  ],
  templateUrl: './incident-list.html',
})
export class IncidentList {
  protected readonly store = inject(IncidentStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly canManage = computed(() => this.permissions.has('incidents.manage'));

  protected readonly actionError = signal<string | null>(null);
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly statusOptions = STATUS_FILTER_OPTIONS;
  protected readonly severityOptions = SEVERITY_FILTER_OPTIONS;
  protected readonly categoryOptions = CATEGORY_FILTER_OPTIONS;
  protected readonly sourceOptions = SOURCE_FILTER_OPTIONS;
  protected readonly openOnlyOptions = OPEN_ONLY_OPTIONS;

  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;
  protected readonly severityLabel = severityLabel;
  protected readonly severityTone = severityTone;
  protected readonly categoryLabel = categoryLabel;

  protected readonly filters = new ListFilters([
    { key: 'open_only', label: 'Showing', chipValue: () => 'Open only' },
    { key: 'status', label: 'Status', chipValue: statusLabel },
    { key: 'severity', label: 'Severity', chipValue: severityLabel },
    { key: 'category', label: 'Category', chipValue: categoryLabel },
    { key: 'source', label: 'Reported by', chipValue: sourceLabel },
  ]);

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() => (this.density() === 'compact' ? 'py-1' : 'py-3'));
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  constructor() {
    // Mirrors the store's own seeded default so the chip is on screen
    // from the first render. Seeding one without the other is how a
    // narrowing becomes invisible.
    this.filters.setExtra('open_only', 'true');
  }

  // Same untracked()/effect() wiring every business-scoped list uses.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => this.applyFilters());
      }
    },
    { allowSignalWrites: true }
  );

  protected summaryLine(incident: Incident): string {
    return summaryLine([
      severityLabel(incident.severity),
      categoryLabel(incident.category),
      incident.route_name,
    ]);
  }

  protected applyFilters(): void {
    const active = this.filters.query();
    void this.store.updateQuery({
      business: this.selectedBusinessStore.selectedBusinessId() ?? undefined,
      search: active.search,
      status: this.filters.extra('status') || undefined,
      severity: this.filters.extra('severity') || undefined,
      category: this.filters.extra('category') || undefined,
      source: this.filters.extra('source') || undefined,
      // Cleared means the param disappears, never `open_only=false` —
      // that would be a filter on the server, not the absence of one.
      open_only: this.filters.extra('open_only') === 'true' ? true : undefined,
    });
  }

  protected onSearchChange(value: string): void {
    this.filters.setSearch(value);
    this.applyFilters();
  }

  protected onExtraFilterChange(key: string, value: string): void {
    this.filters.setExtra(key, value);
    this.applyFilters();
  }

  protected onChipRemoved(chipId: string): void {
    this.filters.remove(chipId);
    this.applyFilters();
  }

  protected onFiltersCleared(): void {
    this.filters.clear();
    this.applyFilters();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected async goToNewIncident(): Promise<void> {
    await this.router.navigate(['/incidents/new']);
  }

  protected menuItems(incident: Incident): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      { id: 'view', label: 'View details', icon: 'exclamation-triangle' },
    ];
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      for (const next of nextStatuses(incident.status)) {
        items.push({
          id: `transition:${next}`,
          label: transitionLabel(incident.status, next),
          icon: next === 'resolved' || next === 'closed' ? 'check' : 'clock',
        });
      }
    }
    return items;
  }

  protected onMenuSelected(incident: Incident, id: string): void {
    if (id === 'view') {
      void this.router.navigate(['/incidents', incident.id]);
      return;
    }
    if (id === 'edit') {
      void this.router.navigate(['/incidents', incident.id, 'edit']);
      return;
    }
    if (id.startsWith('transition:')) {
      void this.transition(incident, id.slice('transition:'.length));
    }
  }

  private async transition(incident: Incident, status: string): Promise<void> {
    this.actionError.set(null);
    const { error } = await this.api.POST('/api/v1/incidents/{id}/transition/', {
      params: { path: { id: incident.id } },
      body: { status: status as Incident['status'] },
    });
    if (error) {
      this.actionError.set(
        extractFirstErrorMessage(error, `Could not update ${incident.reference}.`)
      );
      return;
    }
    await this.store.getAll();
  }
}

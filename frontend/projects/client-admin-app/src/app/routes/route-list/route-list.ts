import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  ActionMenu,
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  DensityToggle,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  StatusPill,
  Table,
  plural,
  summaryLine,
} from '@shared-ui';
import type { ActionMenuItem, ConfirmDialogData, ConfirmDialogResult, Density } from '@shared-ui';

import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { ListFilters } from '../../shared/list-filters';
import {
  STATUS_FILTER_OPTIONS,
  nextStatuses,
  statusLabel,
  statusTone,
  takesOutOfService,
  transitionLabel,
  type RouteStatus,
} from '../../shared/route-labels';

@Component({
  selector: 'app-route-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
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
  templateUrl: './route-list.html',
})
export class RouteList {
  protected readonly store = inject(RouteStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly permissions = inject(PermissionsService);
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  private readonly densityStore = inject(TableDensityStore);

  protected readonly canManage = computed(() => this.permissions.has('network.manage'));
  protected readonly canViewFares = computed(() => this.permissions.has('fares.view'));

  protected readonly actionError = signal<string | null>(null);
  protected readonly filters = new ListFilters([
    { key: 'status', label: 'Status', chipValue: (value) => statusLabel(value) },
  ]);
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  /** Compact overrides the surface profile's control height for this
   * table, so the row's action button shrinks with the padding — see
   * `ui-action-menu`'s own note for why padding alone is not enough. */
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly statusConfirmBody = viewChild.required<TemplateRef<unknown>>(
    'statusConfirmBody'
  );
  private readonly duplicateConfirmBody =
    viewChild.required<TemplateRef<unknown>>('duplicateConfirmBody');

  protected readonly selected = signal<Route | null>(null);
  protected readonly pendingTarget = signal<RouteStatus | null>(null);
  private readonly duplicatedRoute = signal<Route | null>(null);
  protected readonly confirmLabel = computed(() => {
    const route = this.selected();
    const target = this.pendingTarget();
    return route && target ? transitionLabel(route.status, target) : 'Confirm';
  });
  /** Archiving and deactivating take something out of service;
   * activating, restoring and duplicating do not — see
   * `takesOutOfService`'s own note on why `from` matters as much as
   * `to` here. */
  protected readonly confirmDanger = computed(() => {
    const route = this.selected();
    const target = this.pendingTarget();
    return route && target ? takesOutOfService(route.status, target) : false;
  });
  protected readonly confirmDisabled = signal(false);

  // AppShell's constructor already kicked off SelectedBusinessStore's
  // one-shot load for the whole session; this effect just reacts to
  // whatever it settles on (including the first resolution) and
  // re-scopes the Route query — it never calls store.getAll() itself,
  // ListStore.updateQuery() already does that internally.
  //
  // `updateQuery()` synchronously reads and writes RouteStore's own
  // `state` signal before its first `await` (see ListStore.updateQuery/
  // getAll). Called directly from an effect, that read gets swept into
  // *this* effect's dependency tracking too (Angular attributes any
  // signal read/write during an effect's synchronous execution window
  // to that effect, even across nested function calls) — the write then
  // retriggers the very effect that just ran, forever. Confirmed
  // empirically: this hung and crashed a real browser tab in e2e,
  // silently, with no thrown error to catch (Karma's zone/scheduler
  // handling masked it, so unit tests stayed green regardless).
  // `untracked()` is the standard fix — it excludes the wrapped call
  // from dependency tracking entirely, so only `selectedBusinessId()`
  // remains a real dependency. `allowSignalWrites` is still required
  // alongside it since the write itself is still a write, just no
  // longer a *tracked* one.
  //
  // This is the *only* fetch trigger on this screen — there is no
  // ngOnInit calling getAll(), deliberately: an unscoped fetch there
  // would race this scoped one and the table would briefly show every
  // Route across every Business.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.store.updateQuery({ business: businessId }));
      }
    },
    { allowSignalWrites: true }
  );

  /**
   * Below `md` the Code and Stops columns are hidden and their values
   * appear here instead, under the route's name. See `ui-table`'s note
   * on the responsive-column tiers.
   */
  protected summaryLine(route: Route): string {
    return summaryLine([route.code, plural(route.stops.length, 'stop')]);
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected async goToNewRoute(): Promise<void> {
    await this.router.navigate(['/routes/new']);
  }

  /** Merges the filter state into the query the business effect owns.
   * `updateQuery` resets to page 1, which is what a changed filter
   * should do — staying on page 4 of a narrower result set is how a
   * search that matched shows "no routes". */
  protected applyFilters(): void {
    void this.store.updateQuery({
      business: this.selectedBusinessStore.selectedBusinessId() ?? undefined,
      ...this.filters.query(),
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

  /**
   * The row's actions. Built per row, because the legal next statuses
   * depend on the row's own current one — and because the read-only
   * subset a viewer without `network.manage` gets is expressed once
   * here rather than repeated around each control in the template.
   *
   * "Fares" is gated on `fares.view`, not the same permission as the
   * rest: reading what a route charges is not a network edit
   * (docs/specs/12-fare-matrix.md). "Duplicate" is offered from any
   * status, including `archived` — resurrecting an old route as a new
   * draft is a real workflow docs/specs/19-route-lifecycle.md names
   * explicitly.
   */
  protected menuItems(route: Route): ActionMenuItem[] {
    const items: ActionMenuItem[] = [{ id: 'details', label: 'View details', icon: 'map' }];
    if (this.canViewFares()) {
      items.push({ id: 'fares', label: 'Fares', icon: 'tag' });
    }
    if (!this.canManage()) {
      return items;
    }
    items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
    for (const target of nextStatuses(route.status)) {
      const outOfService = takesOutOfService(route.status, target);
      items.push({
        id: `status:${target}`,
        label: transitionLabel(route.status, target),
        icon: outOfService ? 'x-mark' : 'check',
        danger: outOfService,
      });
    }
    // No icon: nothing in the current set (`icon.ts`) reads as
    // "duplicate" without forcing a poor fit, and `icon` is optional.
    items.push({ id: 'duplicate', label: 'Duplicate' });
    return items;
  }

  protected onMenuSelected(route: Route, id: string): void {
    if (id === 'details') {
      void this.router.navigate(['/routes', route.id]);
      return;
    }
    if (id === 'fares') {
      void this.router.navigate(['/fares/fare-matrix', route.id]);
      return;
    }
    if (id === 'edit') {
      void this.router.navigate(['/routes', route.id, 'edit']);
      return;
    }
    if (id === 'duplicate') {
      this.confirmDuplicate(route);
      return;
    }
    const target = id.replace('status:', '') as RouteStatus;
    this.confirmStatusChange(route, target);
  }

  private confirmStatusChange(route: Route, target: RouteStatus): void {
    this.selected.set(route);
    this.pendingTarget.set(target);
    this.actionError.set(null);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${transitionLabel(route.status, target)} ${route.name}?`,
        bodyTemplate: this.statusConfirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitStatusChange(route, target),
      },
    });

    // Deferred one tick — see trip-list.ts's identical reasoning:
    // refetching in the same synchronous tick as the dialog's own
    // close/focus-restoration sequence races it.
    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  private async submitStatusChange(
    route: Route,
    target: RouteStatus
  ): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/routes/{id}/status/', {
      params: { path: { id: route.id } },
      body: { status: target },
    });

    // The backend is authoritative on the guards (a currently-effective
    // fare and two stops to activate, no future trips to archive) and
    // answers 409/400 naming exactly what refused the move — that
    // message is what the operator sees, not a generic fallback.
    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${transitionLabel(route.status, target).toLowerCase()} ${route.name}.`
          ),
        }
      : { ok: true };
  }

  private confirmDuplicate(route: Route): void {
    this.selected.set(route);
    this.actionError.set(null);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Duplicate ${route.name}?`,
        bodyTemplate: this.duplicateConfirmBody(),
        confirmLabel: signal('Duplicate'),
        danger: signal(false),
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitDuplicate(route),
      },
    });

    // The copy is a draft nobody can book yet — landing on its edit
    // screen (stops, fares, activation) is the useful next step, the
    // same reasoning `RouteForm.onSubmit`'s own create path already
    // acts on. Deferred one tick for the same reason as the status
    // dialog above.
    ref.closed.subscribe((confirmed) => {
      const copy = this.duplicatedRoute();
      if (confirmed && copy) {
        setTimeout(() => void this.router.navigate(['/routes', copy.id, 'edit']));
      }
    });
  }

  private async submitDuplicate(route: Route): Promise<ConfirmDialogResult> {
    const { data, error } = await this.api.POST('/api/v1/routes/{id}/duplicate/', {
      params: { path: { id: route.id } },
    });
    if (!data) {
      return {
        ok: false,
        error: extractFirstErrorMessage(error, `Could not duplicate ${route.name}.`),
      };
    }
    this.duplicatedRoute.set(data);
    return { ok: true };
  }
}

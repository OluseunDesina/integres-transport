import { Dialog } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  ViewChild,
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
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  DensityToggle,
  DrawerService,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  RadioGroup,
  StatusPill,
  Table,
  TextField,
  Textarea,
  summaryLine,
} from '@shared-ui';
import type {
  ActionMenuItem,
  ConfirmDialogData,
  ConfirmDialogResult,
  Density,
  SelectOption,
  StatusPillTone,
} from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { TripStore, type Trip } from '../../shared/data/store/trip.store';
import { ListFilters } from '../../shared/list-filters';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { TRIP_CLASS_OPTIONS, tripClassLabel, type TripClass } from '../../shared/trip-class';

const NONE_OPTION: SelectOption = { value: '', label: '— None —' };

const ALL_ROUTES_OPTION: SelectOption = { value: '', label: 'All routes' };
const ALL_SCHEDULES_OPTION: SelectOption = {
  value: '',
  label: 'All schedules',
};
// "All classes" here, not the fare screens' "Any class", and the two
// must not be unified: this is a *filter*, where the empty value
// genuinely means "don't narrow". On a fare, the empty value names a
// wildcard rule that a class-specific rule overrides — a weaker claim
// that "All" would misstate.
const TRIP_CLASS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All classes' },
  ...TRIP_CLASS_OPTIONS,
];

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const STATUS_TONE: Record<string, StatusPillTone> = {
  scheduled: 'neutral',
  in_progress: 'warning',
  completed: 'positive',
  cancelled: 'negative',
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

interface StatusTransitionOption {
  target: 'in_progress' | 'completed' | 'cancelled';
  label: string;
}

// Mirrors apps.scheduling.services.TRIP_TRANSITIONS client-side — no
// shared code with the backend, just the same two legal-next-status
// entries per state, used only to decide which two radio options this
// dialog offers for the row's *current* status.
function transitionOptionsFor(status: string): StatusTransitionOption[] {
  if (status === 'scheduled') {
    return [
      { target: 'in_progress', label: 'Start trip' },
      { target: 'cancelled', label: 'Cancel trip' },
    ];
  }
  if (status === 'in_progress') {
    return [
      { target: 'completed', label: 'Complete trip' },
      { target: 'cancelled', label: 'Cancel trip' },
    ];
  }
  return [];
}

/**
 * Top-level Trip screen — not nested under Schedule/Route, per the
 * spec: a nested-only view would hide manual one-off trips and
 * wouldn't provide one place to assign vehicle/driver or transition
 * status. "Trips visible under a Schedule" is satisfied by filtering
 * this same list via the Schedule dropdown, not a separate screen.
 */
@Component({
  selector: 'app-trip-list',
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
    RadioGroup,
    Select,
    Skeleton,
    StatusPill,
    Table,
    TextField,
    Textarea,
  ],
  templateUrl: './trip-list.html',
})
export class TripList {
  private readonly permissionsService = inject(PermissionsService);

  /**
   * Whether the route name links to this departure's performance.
   *
   * Read here rather than through `*appHasPermission` because the cell
   * needs an `@else` — a user without the codename still sees the route
   * name, just not as a link — and that directive has no else binding.
   */
  protected readonly canViewPerformance = computed(() =>
    this.permissionsService.permissions().has('analytics.view')
  );

  /**
   * Spec 18 slice 1. `booking.view`, which the **Staff** preset holds
   * and `analytics.view` is deliberately withheld from — the manifest
   * is the list read at the bus door, not revenue reporting.
   *
   * Read here for the same reason as `canViewPerformance` above, and
   * rendered as a row link rather than an action-menu item for the same
   * reason too: that menu is wrapped in
   * `*appHasPermission="'scheduling.manage'"` in its entirety, so an
   * item inside it would be invisible to precisely the people this
   * screen exists for.
   */
  protected readonly canViewManifest = computed(() =>
    this.permissionsService.permissions().has('booking.view')
  );

  protected readonly store = inject(TripStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);
  private readonly densityStore = inject(TableDensityStore);
  private readonly drawers = inject(DrawerService);

  @ViewChild('statusBody') private readonly statusBody!: TemplateRef<unknown>;
  @ViewChild('classBody') private readonly classBody!: TemplateRef<unknown>;
  @ViewChild('assignBody') private readonly assignBody!: TemplateRef<unknown>;
  @ViewChild('detailBody') private readonly detailBody!: TemplateRef<unknown>;

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly tripClassFilterOptions = TRIP_CLASS_FILTER_OPTIONS;
  protected readonly tripClassOptions = TRIP_CLASS_OPTIONS;
  protected readonly tripClassLabel = tripClassLabel;
  protected readonly routeFilterOptions = signal<SelectOption[]>([ALL_ROUTES_OPTION]);
  protected readonly scheduleFilterOptions = signal<SelectOption[]>([ALL_SCHEDULES_OPTION]);

  protected readonly filters = new ListFilters([
    {
      key: 'route',
      label: 'Route',
      // A UUID on a chip tells an operator nothing — resolve it back to
      // the label the dropdown showed.
      chipValue: (id) => this.routeFilterOptions().find((o) => o.value === id)?.label ?? id,
    },
    {
      key: 'schedule',
      label: 'Schedule',
      chipValue: (id) => this.scheduleFilterOptions().find((o) => o.value === id)?.label ?? id,
    },
    { key: 'service_date', label: 'Date' },
    {
      key: 'trip_class',
      label: 'Class',
      chipValue: (value) => tripClassLabel(value),
    },
    {
      key: 'status',
      label: 'Status',
      chipValue: (value) => STATUS_LABEL[value] ?? value,
    },
  ]);
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  /** The trip the read-only detail drawer is showing. Separate from
   * `assigning`, so opening details never looks like an edit in
   * progress. */
  protected readonly viewing = signal<Trip | null>(null);

  /** The trip the assignment drawer is editing. */
  protected readonly assigning = signal<Trip | null>(null);
  protected readonly pendingVehicleId = signal('');
  protected readonly pendingDriverId = signal('');
  protected readonly assignSaving = signal(false);

  protected readonly assignmentError = signal<string | null>(null);
  private readonly vehicleOptionsCache = signal<Map<string, SelectOption[]>>(new Map());
  private readonly driverOptionsCache = signal<Map<string, SelectOption[]>>(new Map());

  /** The class the class dialog is offering to move a trip to. */
  protected readonly pendingClass = signal<TripClass>('standard');
  protected readonly classConfirmLabel = computed(() => 'Change class');
  // Not destructive in itself — it is refused outright once anything is
  // sold, rather than being allowed and doing damage.
  protected readonly classDanger = computed(() => false);
  protected readonly classConfirmDisabled = computed(() => false);

  protected readonly statusOptions = signal<StatusTransitionOption[]>([]);
  protected readonly statusTarget = signal<StatusTransitionOption['target'] | ''>('');
  protected readonly statusReason = signal('');
  protected readonly confirmDisabled = computed(
    () => this.statusTarget() === 'cancelled' && !this.statusReason().trim()
  );
  protected readonly danger = computed(() => this.statusTarget() === 'cancelled');
  protected readonly confirmLabel = computed(
    () => this.statusOptions().find((o) => o.target === this.statusTarget())?.label ?? 'Confirm'
  );

  /** `statusOptions` in the shape `ui-radio-group` takes. The transition
   * list stays the source of truth — it is the part with the rules. */
  protected readonly statusSelectOptions = computed<SelectOption[]>(() =>
    this.statusOptions().map((option) => ({ value: option.target, label: option.label }))
  );

  // Scopes both the rows *and* the Route/Schedule filter dropdowns to
  // whichever Business is active — the same effect()/untracked()
  // pattern every other business-scoped screen already uses.
  //
  // Previously only the dropdowns were scoped, because GET /trips/ had
  // no `?business=` param of its own: the table itself still listed
  // every Trip across every Business under the Client, which is what
  // made this screen the odd one out. The param exists now
  // (`TripListQuerySerializer.business`), so the query is scoped too.
  //
  // This is the only fetch trigger on this screen — the ngOnInit that
  // used to call getAll() is gone, deliberately: an unscoped fetch
  // there would race this scoped one and the table would briefly show
  // every Business's Trips.
  private readonly syncBusinessFilter = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => {
          void this.store.updateQuery({ business: businessId });
          void this.loadFilterOptions(businessId);
        });
      }
    },
    { allowSignalWrites: true }
  );

  // Lazily fetch-and-cache Vehicle/Driver options per business id seen
  // on the current page, rather than a shared options service (no
  // pagination/query needs of its own) or a per-row fetch-on-render.
  // `loadingBusinessIds` is a plain in-flight guard, not a signal — it
  // must not itself retrigger this effect.
  //
  // Now that the list is scoped by `?business=`, a page resolves to a
  // single id in practice; this stays keyed by id anyway so switching
  // the active Business reuses the cache instead of refetching, and so
  // nothing breaks if the scoping is ever relaxed.
  private readonly loadingBusinessIds = new Set<string>();

  private readonly loadMissingAssignmentOptions = effect(
    () => {
      const businessIds = new Set(this.store.items().map((trip) => trip.business));
      untracked(() => {
        for (const businessId of businessIds) {
          if (
            !this.vehicleOptionsCache().has(businessId) &&
            !this.loadingBusinessIds.has(businessId)
          ) {
            this.loadingBusinessIds.add(businessId);
            void this.fetchAssignmentOptions(businessId);
          }
        }
      });
    },
    { allowSignalWrites: true }
  );

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  /** Every filter goes through here, so the business scope is never
   * dropped and the chips stay in step with the query. */
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

  protected async goToNewTrip(): Promise<void> {
    await this.router.navigate(['/trips/new']);
  }

  // Gates the row's assignment <ui-select>s in the template — they must
  // not mount until their Business's option lists have actually
  // resolved. Angular's [value] binding on a <select> only re-applies
  // when the bound expression changes; if the select mounts with
  // trip.vehicle's id before the matching <option> exists (still
  // NONE_OPTION-only), the browser silently falls back to "no
  // selection" and adding the right <option> later never retroactively
  // re-selects it. Loading state is shown as plain text instead.
  protected assignmentOptionsReady(businessId: string): boolean {
    return this.vehicleOptionsCache().has(businessId);
  }

  protected vehicleOptionsFor(businessId: string): SelectOption[] {
    return this.vehicleOptionsCache().get(businessId) ?? [NONE_OPTION];
  }

  protected driverOptionsFor(businessId: string): SelectOption[] {
    return this.driverOptionsCache().get(businessId) ?? [NONE_OPTION];
  }

  protected setPendingVehicle(value: string): void {
    this.pendingVehicleId.set(value);
  }

  protected setPendingDriver(value: string): void {
    this.pendingDriverId.set(value);
  }

  /**
   * The row's actions. Assignment and status both used to live in the
   * row itself — assignment as two inline `<select>`s in a `max-w-40`
   * cell that reassigned a vehicle or driver the moment they changed,
   * with no confirmation. That is the same write-control-in-a-read-
   * surface shape docs/specs/14 replaced on six other lists, and worse
   * than a toggle: the options are long and a mis-selection silently
   * moves a vehicle off one trip and onto another.
   */
  /** The Service date and Departure columns, hidden below `md` — see
   * `ui-table`'s note on the responsive-column tiers. Vehicle, driver
   * and compliance are tier 3; the row menu's "View details" reaches
   * them at any width. */
  protected summaryLine(trip: Trip): string {
    return summaryLine([
      trip.service_date,
      this.departureTime(trip),
      tripClassLabel(trip.trip_class),
    ]);
  }

  private departureTime(trip: Trip): string {
    return new Date(trip.scheduled_departure_at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected menuItems(trip: Trip): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      // First, and unconditional: from `lg` down this row hides its
      // vehicle, driver and compliance columns, and this is where they
      // are recoverable. Every other action on this menu is a write.
      { id: 'details', label: 'View details', icon: 'clock' },
      { id: 'assign', label: 'Assign vehicle & driver', icon: 'truck' },
      // Offered on every trip, not gated on status or on anything else
      // this screen can see. Whether a trip is sold is knowable only to
      // the backend, and a `409` carrying its own sentence is a better
      // answer than an action that is mysteriously missing on some rows
      // and present on others.
      { id: 'class', label: 'Change service class', icon: 'tag' },
    ];
    if (this.canTransition(trip.status)) {
      items.push({
        id: 'status',
        label: 'Change status',
        icon: 'clock',
        danger: trip.status === 'in_progress',
      });
    }
    return items;
  }

  protected onMenuSelected(trip: Trip, id: string): void {
    if (id === 'details') {
      this.openDetails(trip);
      return;
    }
    if (id === 'assign') {
      this.openAssignment(trip);
      return;
    }
    if (id === 'class') {
      this.changeClass(trip);
      return;
    }
    this.changeStatus(trip);
  }

  protected setPendingClass(value: string): void {
    this.pendingClass.set(value as TripClass);
  }

  /**
   * Moves a trip between service classes —
   * docs/specs/15-trip-classes.md.
   *
   * Deliberately the same `ConfirmDialog` + `ui-radio-group` shape as
   * `changeStatus` below, because it is the same kind of act: a guarded
   * single-field write that changes what a departure *is*. The rules it
   * can fall foul of — a sold trip, a route that does not offer the
   * class, an assigned vehicle of the wrong class — all live in the
   * backend, so this offers every class and lets the refusal explain
   * itself.
   */
  protected changeClass(trip: Trip): void {
    this.pendingClass.set((trip.trip_class ?? 'standard') as TripClass);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Change service class — ${trip.route.name} (${trip.service_date})`,
        bodyTemplate: this.classBody,
        confirmLabel: this.classConfirmLabel,
        danger: this.classDanger,
        confirmDisabled: this.classConfirmDisabled,
        onConfirm: () => this.submitClassChange(trip.id),
      },
    });

    // Deferred one tick, same as changeStatus: refetching inside the
    // dialog's own close/focus-restoration sequence races it.
    ref.closed.subscribe(() => {
      setTimeout(() => void this.store.getAll());
    });
  }

  private async submitClassChange(tripId: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/trips/{id}/class/', {
      params: { path: { id: tripId } },
      body: { trip_class: this.pendingClass() },
    });

    // The backend's own sentence, not a rewrite of it: a 409 here says
    // "this trip already has bookings, so its class can no longer be
    // changed", which is more specific than anything this screen knows.
    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            'Could not change this trip’s service class. Try again.'
          ),
        }
      : { ok: true };
  }

  /** Read-only counterpart to the assignment drawer — what the row
   * cannot show at this width, in full. */
  private openDetails(trip: Trip): void {
    this.viewing.set(trip);
    this.drawers.open({
      title: `${trip.route.name} — ${trip.service_date}`,
      description: 'Everything recorded against this trip.',
      bodyTemplate: this.detailBody,
    });
  }

  /** Opens the assignment drawer, seeded with what the trip already
   * has, so opening and saving without touching anything is a no-op. */
  private openAssignment(trip: Trip): void {
    this.assigning.set(trip);
    this.pendingVehicleId.set(trip.vehicle?.id ?? '');
    this.pendingDriverId.set(trip.driver?.id ?? '');
    this.assignmentError.set(null);

    const ref = this.drawers.open({
      title: `${trip.route.name} — ${trip.service_date}`,
      description: 'Assign a vehicle and driver to this trip.',
      bodyTemplate: this.assignBody,
    });

    ref.closed.subscribe(() => this.assigning.set(null));
  }

  protected async saveAssignment(): Promise<void> {
    const trip = this.assigning();
    if (!trip) {
      return;
    }
    this.assignSaving.set(true);
    await this.patchAssignment(
      trip,
      this.pendingVehicleId() || null,
      this.pendingDriverId() || null
    );
    this.assignSaving.set(false);
  }

  protected canTransition(status: string): boolean {
    return transitionOptionsFor(status).length > 0;
  }

  protected setStatusTarget(target: string): void {
    this.statusTarget.set(target as StatusTransitionOption['target']);
  }

  protected setStatusReason(value: string): void {
    this.statusReason.set(value);
  }

  protected changeStatus(trip: Trip): void {
    const options = transitionOptionsFor(trip.status);
    if (options.length === 0) {
      return;
    }
    this.statusOptions.set(options);
    this.statusTarget.set(options[0].target);
    this.statusReason.set('');

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Change status — ${trip.route.name} (${trip.service_date})`,
        bodyTemplate: this.statusBody,
        confirmLabel: this.confirmLabel,
        danger: this.danger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitStatusChange(trip.id),
      },
    });

    // Deferred one tick — see kyc-queue.ts's identical reasoning:
    // refetching in the same synchronous tick as the dialog's own
    // close/focus-restoration sequence races it.
    ref.closed.subscribe(() => {
      setTimeout(() => void this.store.getAll());
    });
  }

  private async loadFilterOptions(businessId: string): Promise<void> {
    const query = { limit: 100, offset: 0, business: businessId };
    const [routes, schedules] = await Promise.all([
      this.api.GET('/api/v1/routes/', {
        params: { query },
      }),
      this.api.GET('/api/v1/schedules/', {
        params: { query },
      }),
    ]);
    const routeNameById = new Map((routes.data?.results ?? []).map((r) => [r.id, r.name]));
    this.routeFilterOptions.set([
      ALL_ROUTES_OPTION,
      ...(routes.data?.results ?? []).map((r) => ({
        value: r.id,
        label: r.name,
      })),
    ]);
    this.scheduleFilterOptions.set([
      ALL_SCHEDULES_OPTION,
      ...(schedules.data?.results ?? []).map((s) => ({
        value: s.id,
        label: `${routeNameById.get(s.route) ?? s.route} @ ${s.departure_time}`,
      })),
    ]);
  }

  private async fetchAssignmentOptions(businessId: string): Promise<void> {
    const query = { limit: 100, offset: 0, business: businessId };
    const [vehicles, drivers] = await Promise.all([
      this.api.GET('/api/v1/vehicles/', {
        params: { query },
      }),
      this.api.GET('/api/v1/drivers/', {
        params: { query },
      }),
    ]);

    // Both caches are populated together, only once the real data has
    // resolved — see assignmentOptionsReady()'s docstring for why.
    this.vehicleOptionsCache.update((map) =>
      new Map(map).set(businessId, [
        NONE_OPTION,
        ...(vehicles.data?.results ?? []).map((v) => ({
          value: v.id,
          label: v.registration_number,
        })),
      ])
    );
    this.driverOptionsCache.update((map) =>
      new Map(map).set(businessId, [
        NONE_OPTION,
        ...(drivers.data?.results ?? []).map((d) => ({
          value: d.id,
          label: d.name,
        })),
      ])
    );
    this.loadingBusinessIds.delete(businessId);
  }

  private async patchAssignment(
    trip: Trip,
    vehicle: string | null,
    driver: string | null
  ): Promise<void> {
    this.assignmentError.set(null);

    const { data, error } = await this.api.PATCH('/api/v1/trips/{id}/', {
      params: { path: { id: trip.id } },
      body: { vehicle, driver },
    });

    if (!data) {
      this.assignmentError.set(
        extractFirstErrorMessage(error, "Could not update this trip's assignment.")
      );
      return;
    }

    await this.store.getAll();
  }

  private async submitStatusChange(tripId: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/trips/{id}/status/', {
      params: { path: { id: tripId } },
      body: {
        status: this.statusTarget() as 'in_progress' | 'completed' | 'cancelled',
        reason: this.statusReason(),
      },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(error, 'Could not change this trip’s status. Try again.'),
        }
      : { ok: true };
  }
}

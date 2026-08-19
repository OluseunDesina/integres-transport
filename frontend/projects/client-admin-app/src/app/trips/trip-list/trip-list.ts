import { Dialog } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore, HasPermissionDirective } from '@auth';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  Paginator,
  Select,
  StatusPill,
  Table,
  TextField,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult, SelectOption, StatusPillTone } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { TripStore, type Trip } from '../../shared/data/store/trip.store';

const NONE_OPTION: SelectOption = { value: '', label: '— None —' };

const ALL_ROUTES_OPTION: SelectOption = { value: '', label: 'All routes' };
const ALL_SCHEDULES_OPTION: SelectOption = { value: '', label: 'All schedules' };
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

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
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
    HasPermissionDirective,
    Alert,
    Button,
    EmptyState,
    Paginator,
    Select,
    StatusPill,
    Table,
    TextField,
  ],
  templateUrl: './trip-list.html',
})
export class TripList implements OnInit {
  protected readonly store = inject(TripStore);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  private readonly router = inject(Router);

  @ViewChild('statusBody') private readonly statusBody!: TemplateRef<unknown>;

  protected readonly statusTone = STATUS_TONE;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusFilterOptions = STATUS_FILTER_OPTIONS;
  protected readonly routeFilterOptions = signal<SelectOption[]>([ALL_ROUTES_OPTION]);
  protected readonly scheduleFilterOptions = signal<SelectOption[]>([ALL_SCHEDULES_OPTION]);

  protected readonly assignmentError = signal<string | null>(null);
  private readonly vehicleOptionsCache = signal<Map<string, SelectOption[]>>(new Map());
  private readonly driverOptionsCache = signal<Map<string, SelectOption[]>>(new Map());

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

  // Keeps the Route/Schedule filter dropdowns scoped to whichever
  // Business is active — a client-side convenience only (GET /trips/
  // has no ?business= param of its own), same effect()/untracked()
  // pattern every other business-scoped screen already uses.
  private readonly syncFilterOptions = effect(
    () => {
      const businessId = this.selectedBusinessStore.selectedBusinessId();
      if (businessId) {
        untracked(() => void this.loadFilterOptions(businessId));
      }
    },
    { allowSignalWrites: true }
  );

  // A page of Trips can span multiple Businesses (GET /trips/ has no
  // ?business= filter) — lazily fetch-and-cache Vehicle/Driver options
  // per business id actually seen on the current page, rather than a
  // shared options service (no pagination/query needs of its own) or a
  // per-row fetch-on-render. `loadingBusinessIds` is a plain in-flight
  // guard, not a signal — it must not itself retrigger this effect.
  private readonly loadingBusinessIds = new Set<string>();

  private readonly loadMissingAssignmentOptions = effect(
    () => {
      const businessIds = new Set(this.store.items().map((trip) => trip.business));
      untracked(() => {
        for (const businessId of businessIds) {
          if (!this.vehicleOptionsCache().has(businessId) && !this.loadingBusinessIds.has(businessId)) {
            this.loadingBusinessIds.add(businessId);
            void this.fetchAssignmentOptions(businessId);
          }
        }
      });
    },
    { allowSignalWrites: true }
  );

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onRouteFilterChange(value: string): void {
    void this.store.updateQuery({ route: value || undefined });
  }

  protected onScheduleFilterChange(value: string): void {
    void this.store.updateQuery({ schedule: value || undefined });
  }

  protected onServiceDateFilterChange(value: string): void {
    void this.store.updateQuery({ service_date: value || undefined });
  }

  protected onStatusFilterChange(value: string): void {
    void this.store.updateQuery({ status: value || undefined });
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

  protected async onVehicleChange(trip: Trip, vehicleId: string): Promise<void> {
    await this.patchAssignment(trip, vehicleId || null, trip.driver?.id ?? null);
  }

  protected async onDriverChange(trip: Trip, driverId: string): Promise<void> {
    await this.patchAssignment(trip, trip.vehicle?.id ?? null, driverId || null);
  }

  protected canTransition(status: string): boolean {
    return transitionOptionsFor(status).length > 0;
  }

  protected setStatusTarget(target: StatusTransitionOption['target']): void {
    this.statusTarget.set(target);
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
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const query = { limit: 100, offset: 0, business: businessId };
    const [routes, schedules] = await Promise.all([
      this.api.GET('/api/v1/routes/', { params: { query }, headers: authHeader }),
      this.api.GET('/api/v1/schedules/', { params: { query }, headers: authHeader }),
    ]);
    const routeNameById = new Map((routes.data?.results ?? []).map((r) => [r.id, r.name]));
    this.routeFilterOptions.set([
      ALL_ROUTES_OPTION,
      ...(routes.data?.results ?? []).map((r) => ({ value: r.id, label: r.name })),
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
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const query = { limit: 100, offset: 0, business: businessId };
    const [vehicles, drivers] = await Promise.all([
      this.api.GET('/api/v1/vehicles/', { params: { query }, headers: authHeader }),
      this.api.GET('/api/v1/drivers/', { params: { query }, headers: authHeader }),
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
        ...(drivers.data?.results ?? []).map((d) => ({ value: d.id, label: d.name })),
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
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
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
      body: { status: this.statusTarget() as 'in_progress' | 'completed' | 'cancelled', reason: this.statusReason() },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    return error ? { ok: false, error: extractFirstErrorMessage(error, 'Could not change this trip’s status. Try again.') } : { ok: true };
  }
}

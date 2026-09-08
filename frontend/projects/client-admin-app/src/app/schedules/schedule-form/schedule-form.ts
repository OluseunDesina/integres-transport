import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  Select,
  TextField,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { ScheduleStore } from '../../shared/data/store/schedule.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import { allowedTripClassOptions, type TripClass } from '../../shared/trip-class';

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

/**
 * One component for create (`schedules/new`) and edit
 * (`schedules/:id/edit`) — mirrors VehicleForm's dual-mode shape and its
 * Business→(scoped child) live-refetch pattern for the Route picker.
 * Days-of-week is a local checkbox group, not a reactive form control —
 * same "used once, local" precedent RouteForm's stop-picker set.
 */
@Component({
  selector: 'app-schedule-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, Select, TextField],
  templateUrl: './schedule-form.html',
})
export class ScheduleForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(ScheduleStore);

  protected readonly dayLabels = DAY_LABELS;

  protected readonly scheduleId = signal<string | null>(null);
  protected readonly editing = computed(() => this.scheduleId() !== null);
  protected readonly notFound = signal(false);

  protected readonly routeOptionsList = signal<SelectOption[]>([]);
  protected readonly selectedDays = signal<number[]>([]);

  /**
   * Each route's own `available_trip_classes`, kept from the fetch that
   * already populates the Route picker — no extra request.
   *
   * Offering a class the chosen route refuses would produce a
   * guaranteed 400 the operator can only discover by submitting. This
   * turns it into an option that was never there.
   */
  private readonly classesByRoute = signal<ReadonlyMap<string, string[]>>(new Map());

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher.
  // Re-asking was redundant (it was pre-filled from this same value)
  // and let a user create a record under a Business other than the one
  // every other screen was showing them. The control stays purely as
  // the value carrier for create.
  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    departure_time: ['', Validators.required],
    effective_from: ['', Validators.required],
    effective_until: [''],
    // docs/specs/15-trip-classes.md. Snapshotted onto every Trip this
    // schedule generates, so this is the field with the widest
    // downstream reach on the screen.
    trip_class: ['standard' as TripClass, Validators.required],
  });

  /**
   * Declared **after** `form`, and read through `toSignal` rather than
   * `form.controls.route.value`.
   *
   * Order matters: a field initialiser touching `this.form` before it
   * exists throws. And a `computed()` over a plain control value
   * depends on no signal at all, so it caches its first result forever
   * — the class list would freeze on whatever was selected at first
   * render, which is nothing. Both validator screens carried exactly
   * that bug for months (docs/specs/10-booking-modes.md).
   */
  private readonly selectedRouteId = toSignal(this.form.controls.route.valueChanges, {
    initialValue: '',
  });

  protected readonly tripClassOptions = computed<SelectOption[]>(() =>
    allowedTripClassOptions(this.classesByRoute().get(this.selectedRouteId()) ?? [])
  );

  /**
   * Keeps the selected class inside the options actually offered.
   *
   * Narrowing the list is only half the job: a control still holding
   * `standard` while the route offers Premium alone renders a `<select>`
   * with no matching `<option>` — which *looks* empty, keeps its old
   * value, and 400s on submit with "this route does not offer standard
   * services". That is the exact failure the narrowing exists to
   * prevent, arrived at from the other direction. Caught by
   * `e2e/client-admin-app/trip-classes.spec.ts`, not by any unit test.
   */
  private readonly keepClassWithinAllowed = effect(() => {
    const allowed = this.tripClassOptions();
    if (allowed.length === 0) {
      return;
    }
    const current = untracked(() => this.form.controls.trip_class.value);
    if (!allowed.some((option) => option.value === current)) {
      this.form.controls.trip_class.setValue(allowed[0].value as TripClass);
    }
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.form.controls.business.valueChanges.subscribe((businessId) => {
        void this.onBusinessChange(businessId);
      });
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a schedule.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      await this.loadRouteOptions(activeBusinessId);
      return;
    }
    this.scheduleId.set(id);

    // Paged full-list lookup, not one bounded page plus `.find()`:
    // the bounded form reported "not found" for any record outside
    // the store's current page, which on a refresh or a pasted link
    // is page 1. See `ListStore.findByIdPaged`.
    const schedule = await this.store.findById(id);

    if (!schedule) {
      this.notFound.set(true);
      return;
    }

    await this.loadRouteOptions(schedule.business);
    this.selectedDays.set([...schedule.days_of_week]);
    this.form.patchValue({
      business: schedule.business,
      route: schedule.route,
      departure_time: schedule.departure_time,
      effective_from: schedule.effective_from,
      effective_until: schedule.effective_until ?? '',
      // See VehicleTypeForm's note: `patchValue` applies an explicit
      // `undefined`, and this control is required.
      trip_class: schedule.trip_class ?? 'standard',
    });
    this.form.controls.business.disable();
    this.form.controls.route.disable();
  }

  protected async onBusinessChange(businessId: string): Promise<void> {
    this.form.patchValue({ route: '' });
    await this.loadRouteOptions(businessId);
  }

  private async loadRouteOptions(businessId: string): Promise<void> {
    if (!businessId) {
      this.routeOptionsList.set([]);
      return;
    }
    const { data } = await this.api.GET('/api/v1/routes/', {
      params: { query: { limit: 100, offset: 0, business: businessId } },
    });
    const routes = data?.results ?? [];
    this.routeOptionsList.set(
      routes.map((route) => ({
        value: route.id,
        label: route.name,
      }))
    );
    // The allow-list rides along on a fetch that already happens.
    this.classesByRoute.set(
      new Map(routes.map((route) => [route.id, route.available_trip_classes ?? []]))
    );
  }

  protected isDaySelected(day: number): boolean {
    return this.selectedDays().includes(day);
  }

  protected toggleDay(day: number): void {
    this.selectedDays.update((days) =>
      days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b)
    );
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.selectedDays().length === 0) {
      this.errorMessage.set('Select at least one day of the week.');
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    clearServerErrors(this.form);
    const values = this.form.getRawValue();
    const id = this.scheduleId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/schedules/{id}/', {
          params: { path: { id } },
          body: {
            days_of_week: this.selectedDays(),
            departure_time: values.departure_time,
            effective_from: values.effective_from,
            effective_until: values.effective_until || null,
            trip_class: values.trip_class,
          },
        })
      : await this.api.POST('/api/v1/schedules/', {
          body: {
            route: values.route,
            days_of_week: this.selectedDays(),
            departure_time: values.departure_time,
            effective_from: values.effective_from,
            effective_until: values.effective_until || null,
            trip_class: values.trip_class,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this schedule. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/schedules']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(
    field:
      | 'business'
      | 'route'
      | 'departure_time'
      | 'effective_from'
      | 'effective_until'
      | 'trip_class'
  ): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }

  // A Business with no Routes yet renders the Route <select> with zero
  // <option>s — nothing to pick, so Validators.required always fails.
  // Without this, that reads exactly like a broken dropdown ("I selected
  // one and it still says required") rather than what it actually is:
  // there's genuinely nothing to select yet.
  protected noRoutesAvailable(): boolean {
    return !!this.form.controls.business.value && this.routeOptionsList().length === 0;
  }
}

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { ScheduleStore } from '../../shared/data/store/schedule.store';

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

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
 * One component for create (`schedules/new`) and edit
 * (`schedules/:id/edit`) — mirrors VehicleForm's dual-mode shape and its
 * Business→(scoped child) live-refetch pattern for the Route picker.
 * Days-of-week is a local checkbox group, not a reactive form control —
 * same "used once, local" precedent RouteForm's stop-picker set.
 */
@Component({
  selector: 'app-schedule-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './schedule-form.html',
})
export class ScheduleForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(ScheduleStore);

  protected readonly dayLabels = DAY_LABELS;

  protected readonly scheduleId = signal<string | null>(null);
  protected readonly editing = computed(() => this.scheduleId() !== null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly routeOptionsList = signal<SelectOption[]>([]);
  protected readonly selectedDays = signal<number[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    departure_time: ['', Validators.required],
    effective_from: ['', Validators.required],
    effective_until: [''],
    is_active: [true],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.businessOptionsList.set(await this.businessOptions.loadOptions());
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load businesses.');
    }

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.form.controls.business.valueChanges.subscribe((businessId) => {
        void this.onBusinessChange(businessId);
      });
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (activeBusinessId) {
        this.form.patchValue({ business: activeBusinessId });
        await this.loadRouteOptions(activeBusinessId);
      }
      return;
    }
    this.scheduleId.set(id);

    let schedule = this.store.items().find((s) => s.id === id) ?? null;
    if (!schedule) {
      await this.store.getAll();
      schedule = this.store.items().find((s) => s.id === id) ?? null;
    }

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
      is_active: schedule.is_active ?? true,
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
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.routeOptionsList.set(
      (data?.results ?? []).map((route) => ({ value: route.id, label: route.name }))
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
    const values = this.form.getRawValue();
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const id = this.scheduleId();

    const { data, error } = id
      ? await this.api.PATCH('/api/v1/schedules/{id}/', {
          params: { path: { id } },
          body: {
            days_of_week: this.selectedDays(),
            departure_time: values.departure_time,
            effective_from: values.effective_from,
            effective_until: values.effective_until || null,
            is_active: values.is_active,
          },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/schedules/', {
          body: {
            route: values.route,
            days_of_week: this.selectedDays(),
            departure_time: values.departure_time,
            effective_from: values.effective_from,
            effective_until: values.effective_until || null,
          },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(
          error,
          'Could not save this schedule. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/schedules']);
  }

  protected fieldError(field: 'business' | 'route' | 'departure_time' | 'effective_from'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
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

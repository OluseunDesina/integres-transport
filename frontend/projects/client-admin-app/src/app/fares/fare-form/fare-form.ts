import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import type { Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

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
 * Create-only — `PATCH .../{id}/` *supersedes* a fare (closes the old
 * row, returns a new successor with a different id) rather than
 * editing in place, so there's no separate edit route: adding a new
 * fare here is also how you change a price going forward. Which of
 * `FareRule`/`FareSegmentRule` gets created is decided by the chosen
 * Business's `fare_pricing_mode` — mirrors `ScheduleForm`'s
 * Business→(scoped child) live-refetch pattern for the Route picker,
 * with a second refetch for the Route's own stops once per-segment
 * mode needs a from/to pair.
 */
@Component({
  selector: 'app-fare-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './fare-form.html',
})
export class FareForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly businessOptionsList = computed<SelectOption[]>(() =>
    this.selectedBusinessStore.items().map((business) => ({ value: business.id, label: business.name }))
  );
  protected readonly routeOptionsList = signal<SelectOption[]>([]);
  protected readonly stopOptionsList = signal<SelectOption[]>([]);
  // The Routes fetched for the currently-chosen Business (above), kept
  // around so onRouteChange can read a route's ordered `.stops` without
  // a second endpoint — there's no bare `GET /routes/{id}/` (see
  // apps.network.urls), so this is the only place that data comes from.
  private routesForBusiness: Route[] = [];

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    from_stop: [''],
    to_stop: [''],
    amount: ['', Validators.required],
  });

  protected readonly isPerSegment = computed(() => {
    const businessId = this.form.controls.business.value;
    const business = this.selectedBusinessStore.items().find((b) => b.id === businessId);
    return business?.fare_pricing_mode === 'per_segment';
  });

  ngOnInit(): void {
    const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
    if (activeBusinessId) {
      this.form.patchValue({ business: activeBusinessId });
      void this.onBusinessChange(activeBusinessId);
    }

    this.form.controls.business.valueChanges.subscribe((businessId) => {
      void this.onBusinessChange(businessId);
    });
    this.form.controls.route.valueChanges.subscribe((routeId) => {
      this.onRouteChange(routeId);
    });
  }

  protected async onBusinessChange(businessId: string): Promise<void> {
    this.form.patchValue({ route: '', from_stop: '', to_stop: '' });
    this.stopOptionsList.set([]);
    this.routesForBusiness = [];
    if (!businessId) {
      this.routeOptionsList.set([]);
      return;
    }
    const { data } = await this.api.GET('/api/v1/routes/', {
      params: { query: { limit: 100, offset: 0, business: businessId } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.routesForBusiness = data?.results ?? [];
    this.routeOptionsList.set(this.routesForBusiness.map((route) => ({ value: route.id, label: route.name })));
  }

  protected onRouteChange(routeId: string): void {
    this.form.patchValue({ from_stop: '', to_stop: '' });
    if (!routeId) {
      this.stopOptionsList.set([]);
      return;
    }
    const route = this.routesForBusiness.find((r) => r.id === routeId);
    if (route) {
      this.setStopOptionsFromRoute(route);
    }
  }

  private setStopOptionsFromRoute(route: Route): void {
    this.stopOptionsList.set(
      [...route.stops]
        .sort((a, b) => a.sequence - b.sequence)
        .map((stop) => ({ value: stop.id, label: stop.name }))
    );
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const perSegment = this.isPerSegment();
    if (perSegment && (!this.form.controls.from_stop.value || !this.form.controls.to_stop.value)) {
      this.errorMessage.set('Select both a from and to stop.');
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    const values = this.form.getRawValue();
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };

    const { data, error } = perSegment
      ? await this.api.POST('/api/v1/fare-segment-rules/', {
          body: {
            business: values.business,
            route: values.route,
            from_stop: values.from_stop,
            to_stop: values.to_stop,
            amount: values.amount,
          },
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/fare-rules/', {
          body: { business: values.business, route: values.route, amount: values.amount },
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save this fare. Check your details and try again.')
      );
      return;
    }

    await this.router.navigate(['/fares']);
  }

  protected fieldError(field: 'business' | 'route' | 'amount'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}

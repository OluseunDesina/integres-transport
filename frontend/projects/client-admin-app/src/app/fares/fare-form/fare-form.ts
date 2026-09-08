import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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

import type { Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import {
  ANY_TRIP_CLASS,
  TRIP_CLASS_OPTIONS_WITH_ANY,
  type FareTripClass,
} from '../../shared/trip-class';

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
  imports: [ReactiveFormsModule, RouterLink, Alert,
    FormSection,
    PageHeader, Button, Select, TextField],
  templateUrl: './fare-form.html',
})
export class FareForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly businessOptionsList = computed<SelectOption[]>(() =>
    this.selectedBusinessStore
      .items()
      .map((business) => ({ value: business.id, label: business.name }))
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

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher.
  // Re-asking was redundant (it was pre-filled from this same value)
  // and let a user create a record under a Business other than the one
  // every other screen was showing them. The control stays purely as
  // the value carrier for create.
  protected readonly tripClassOptions = TRIP_CLASS_OPTIONS_WITH_ANY;

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    route: ['', Validators.required],
    from_stop: [''],
    to_stop: [''],
    // Defaults to the wildcard, which is what every fare created before
    // spec 15 effectively was — so a fare entered without thinking
    // about classes still prices all of them, exactly as before.
    //
    // Deliberately **not** narrowed by the route's allow-list, unlike
    // ScheduleForm and TripForm: that list constrains which classes may
    // *run*, and pricing a class ahead of allowing it is a legitimate
    // order to work in. Nothing breaks — an unused rule simply never
    // resolves.
    trip_class: [ANY_TRIP_CLASS as FareTripClass],
    amount: ['', Validators.required],
  });

  protected readonly isPerSegment = computed(() => {
    const businessId = this.form.controls.business.value;
    const business = this.selectedBusinessStore.items().find((b) => b.id === businessId);
    return business?.fare_pricing_mode === 'per_segment';
  });

  ngOnInit(): void {
    const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
    if (!activeBusinessId) {
      this.errorMessage.set('Select a business from the header before creating a fare.');
      return;
    }
    this.form.patchValue({ business: activeBusinessId });
    void this.onBusinessChange(activeBusinessId);

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
    });
    this.routesForBusiness = data?.results ?? [];
    this.routeOptionsList.set(
      this.routesForBusiness.map((route) => ({
        value: route.id,
        label: route.name,
      }))
    );
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
    clearServerErrors(this.form);
    const values = this.form.getRawValue();

    const { data, error } = perSegment
      ? await this.api.POST('/api/v1/fare-segment-rules/', {
          body: {
            business: values.business,
            route: values.route,
            from_stop: values.from_stop,
            to_stop: values.to_stop,
            trip_class: values.trip_class,
            amount: values.amount,
          },
        })
      : await this.api.POST('/api/v1/fare-rules/', {
          body: {
            business: values.business,
            route: values.route,
            trip_class: values.trip_class,
            amount: values.amount,
          },
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this fare. Check your details and try again.'
        )
      );
      return;
    }

    await this.router.navigate(['/fares']);
  }

  /** Every field, not just those with a validator: any of them can
   * come back rejected by the server, and `fieldErrorMessage`
   * surfaces that the same way it surfaces a client-side failure. */
  protected fieldError(
    field: 'business' | 'route' | 'amount' | 'from_stop' | 'to_stop' | 'trip_class'
  ): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}

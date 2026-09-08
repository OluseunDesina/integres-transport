import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  Select,
  TextField,
  Textarea,
  applyServerErrors,
  clearServerErrors,
  fieldErrorMessage,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BookingStore } from '../shared/data/store/booking.store';
import { GeolocationService, type LocationResult } from '../shared/geolocation';
import { CATEGORY_OPTIONS } from '../shared/incident-labels';

type RouteBrowse = components['schemas']['RouteBrowse'];

/** `/routes/browse/` is the same source `wallet.ts` and `trip-search.ts`
 * already use to name operators; one page is plenty to populate a
 * picker, and this app has no operator-list endpoint of its own. */
const MAX_ROUTES = 200;

// "Select an operator", the wording `record-tap`'s trip picker
// already uses, rather than a question echoing the label above it.
const PICK_OPERATOR: SelectOption = { value: '', label: 'Select an operator' };
const ANY_ROUTE: SelectOption = { value: '', label: 'Not sure, or not on a route' };
const ANY_STOP: SelectOption = { value: '', label: 'Not sure, or not at a stop' };

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * A passenger reports a problem (`POST /incidents/report/`) —
 * docs/specs/17-incidents.md slice 3.
 *
 * ## Two entry modes, one component
 *
 * - `/report-issue?booking=<id>`, from a row in `my-bookings`. The
 *   Booking names the trip and the operator, so neither is asked for;
 *   the trip is shown as read-only context instead. Resolved through
 *   `BookingStore.findById` — the standing `findByIdPaged` rule applies
 *   here, unlike on client-admin's incident screens, because
 *   `/bookings/mine/` has no single-record GET.
 * - `/report-issue` on its own, from "My reports" or the nav. The
 *   passenger picks the operator, and optionally a route and a stop.
 *
 * The operator list comes from `GET /routes/browse/` deduped by
 * `business.id`, exactly as `wallet.ts` derives its own — customer-app
 * has no `SelectedBusinessStore` and this is not a new endpoint. The
 * route and stop pickers then cost nothing extra: `RouteBrowse` already
 * carries its stops.
 *
 * ## What is deliberately not asked
 *
 * **Severity.** `IncidentReportSerializer` does not accept it, and that
 * is the backend's call rather than this screen's: a passenger able to
 * declare their own report critical is a one-tap way to ring every
 * operator's notification bell.
 *
 * **A title.** `report_incident` derives one from the category when it
 * is absent, so asking for a headline before the description would be
 * asking the passenger to summarise something they have not written
 * yet.
 */
@Component({
  selector: 'app-report-issue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    Alert,
    Button,
    FormSection,
    PageHeader,
    Select,
    TextField,
    Textarea,
  ],
  templateUrl: './report-issue.html',
})
export class ReportIssue implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly bookings = inject(BookingStore);
  private readonly geolocation = inject(GeolocationService);

  protected readonly categoryOptions = CATEGORY_OPTIONS;

  protected readonly form = this.fb.nonNullable.group({
    // A value-carrier in booking mode (patched from the Booking, no
    // control on screen) and a real control otherwise. Named in
    // `unplaceableFields()` for the first case, so a server rejection of
    // it lands in the page alert rather than on an invisible control.
    business: ['', Validators.required],
    category: ['', Validators.required],
    description: ['', Validators.required],
    route: [''],
    stop: [''],
    device_reference: [''],
  });

  private readonly routes = signal<RouteBrowse[]>([]);
  protected readonly loadingRoutes = signal(false);
  protected readonly routesError = signal<string | null>(null);

  /** The trip this report is about, when the passenger arrived from a
   * booking. `null` in standalone mode. */
  protected readonly bookingContext = signal<{
    tripId: string;
    businessId: string;
    label: string;
  } | null>(null);
  protected readonly loadingBooking = signal(false);
  protected readonly bookingError = signal<string | null>(null);

  protected readonly location = signal<LocationResult | null>(null);
  protected readonly locating = signal(false);

  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);

  /**
   * One key for the life of this form, not one per attempt.
   *
   * That is the whole point of the header: a passenger standing on a
   * platform with one bar taps "Send report", sees nothing happen, and
   * taps again. A fresh key on the second tap would file a second
   * incident, which is precisely the failure `apps.core.idempotency`
   * exists to prevent. Matches `booking-confirm.ts`.
   */
  private readonly idempotencyKey = crypto.randomUUID();

  /**
   * The selected values as signals.
   *
   * `toSignal(control.valueChanges)`, never a `computed()` reading
   * `control.value` — a computed over a plain form-control value
   * depends on no signal at all and caches its first result forever.
   */
  private readonly selectedBusiness = toSignal(this.form.controls.business.valueChanges, {
    initialValue: '',
  });
  private readonly selectedRoute = toSignal(this.form.controls.route.valueChanges, {
    initialValue: '',
  });

  protected readonly businessOptions = computed<SelectOption[]>(() => {
    const seen = new Map<string, string>();
    for (const route of this.routes()) {
      seen.set(route.business.id, route.business.name);
    }
    return [PICK_OPERATOR, ...Array.from(seen, ([value, label]) => ({ value, label }))];
  });

  protected readonly routeOptions = computed<SelectOption[]>(() => {
    const business = this.selectedBusiness();
    return [
      ANY_ROUTE,
      ...this.routes()
        .filter((route) => route.business.id === business)
        .map((route) => ({ value: route.id, label: route.name })),
    ];
  });

  protected readonly stopOptions = computed<SelectOption[]>(() => {
    const routeId = this.selectedRoute();
    const route = this.routes().find((candidate) => candidate.id === routeId);
    return [
      ANY_STOP,
      ...(route?.stops ?? []).map((stop) => ({ value: stop.id, label: stop.name })),
    ];
  });

  constructor() {
    // Narrowing a `<select>`'s options does not move its value into
    // them. Operator -> Route -> Stop is a cascade, so switching
    // operator leaves a route id belonging to the operator the
    // passenger just moved away from — and the form would submit it.
    // Reconciled here rather than in the change handler because the
    // options can also narrow when `routes` finishes loading, which no
    // handler observes.
    effect(
      () => {
        const legalRoutes = new Set(this.routeOptions().map((option) => option.value));
        if (!legalRoutes.has(this.form.controls.route.value)) {
          this.form.controls.route.setValue('');
        }
        const legalStops = new Set(this.stopOptions().map((option) => option.value));
        if (!legalStops.has(this.form.controls.stop.value)) {
          this.form.controls.stop.setValue('');
        }
      },
      { allowSignalWrites: true }
    );
  }

  async ngOnInit(): Promise<void> {
    const bookingId = this.route.snapshot.queryParamMap.get('booking');
    if (bookingId) {
      await this.loadBookingContext(bookingId);
      return;
    }
    await this.loadRoutes();
  }

  /**
   * Booking mode needs no route list at all — the operator is known and
   * the route is the booked one — so it does not fetch one. The two
   * modes are exclusive, and loading both would mean a request whose
   * result nothing renders.
   */
  private async loadBookingContext(bookingId: string): Promise<void> {
    this.loadingBooking.set(true);
    const booking = await this.bookings.findById(bookingId);
    this.loadingBooking.set(false);
    if (!booking) {
      this.bookingError.set(
        'That booking could not be found. You can still report an issue below.'
      );
      await this.loadRoutes();
      return;
    }
    this.bookingContext.set({
      tripId: booking.trip.id,
      businessId: booking.business,
      label: `${booking.trip.route.name} — ${new Date(
        booking.trip.scheduled_departure_at
      ).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    });
    this.form.controls.business.setValue(booking.business);
  }

  private async loadRoutes(): Promise<void> {
    this.loadingRoutes.set(true);
    const { data, error } = await this.api.GET('/api/v1/routes/browse/', {
      params: { query: { limit: MAX_ROUTES, offset: 0 } },
    });
    this.loadingRoutes.set(false);
    if (!data) {
      this.routesError.set(toErrorMessage(error, 'Could not load operators. Try again.'));
      return;
    }
    this.routes.set(data.results);
  }

  protected fieldError(field: 'business' | 'category' | 'description'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      messages: {
        required: {
          business: 'Choose the operator this happened with.',
          category: 'Choose what went wrong.',
          description: 'Tell the operator what happened.',
        }[field],
      },
    });
  }

  protected async attachLocation(): Promise<void> {
    this.locating.set(true);
    this.location.set(await this.geolocation.current());
    this.locating.set(false);
  }

  protected clearLocation(): void {
    this.location.set(null);
  }

  /**
   * What the location control says right now.
   *
   * A refusal is stated plainly and is **not** an error banner: the
   * spec is explicit that a report with no location is normal, not
   * degraded, and the form submits either way.
   */
  protected locationStatus(): string {
    const result = this.location();
    if (!result) {
      return 'Not attached. Sharing it helps the operator find the right vehicle or stop.';
    }
    if (result.ok) {
      return `Attached: ${result.latitude}, ${result.longitude}`;
    }
    switch (result.reason) {
      case 'denied':
        return 'Not attached — your browser declined. Your report will be sent without it.';
      case 'unsupported':
        return 'Not attached — this browser cannot share a location.';
      default:
        return 'Not attached — your location could not be read just now.';
    }
  }

  /** `business` has no control on screen in booking mode, so its server
   * errors must go to the page alert instead of onto something nobody
   * can see or correct. */
  private unplaceableFields(): readonly string[] {
    return this.bookingContext() ? ['business'] : [];
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    clearServerErrors(this.form);
    this.submitError.set(null);
    this.submitting.set(true);

    const value = this.form.getRawValue();
    const context = this.bookingContext();
    const location = this.location();

    const { data, error } = await this.api.POST('/api/v1/incidents/report/', {
      // A declared header *parameter* on this operation, so it travels
      // in params.header — unlike Authorization, which `@auth`'s
      // middleware attaches centrally.
      params: { header: { 'Idempotency-Key': this.idempotencyKey } },
      body: {
        business: value.business,
        category: value.category as components['schemas']['CategoryEnum'],
        description: value.description,
        // Omitted rather than sent blank. An empty string is a value the
        // serializer accepts and stores; the absent key is what "the
        // passenger did not say" looks like.
        ...(context ? { trip: context.tripId } : {}),
        ...(value.route ? { route: value.route } : {}),
        ...(value.stop ? { stop: value.stop } : {}),
        ...(value.device_reference ? { device_reference: value.device_reference } : {}),
        ...(location?.ok
          ? { latitude: location.latitude, longitude: location.longitude }
          : {}),
      },
    });

    this.submitting.set(false);

    if (!data) {
      this.submitError.set(
        applyServerErrors(this.form, error, 'Could not send your report. Try again.', {
          unplaceable: this.unplaceableFields(),
        })
      );
      return;
    }

    await this.router.navigate(['/my-reports'], {
      queryParams: { filed: data.reference },
    });
  }

  protected async cancel(): Promise<void> {
    await this.router.navigate(['/my-reports']);
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, StatusPill, TextField, Toggle } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { CURRENCY_SELECT_OPTIONS } from '../../shared/currency-options';
import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { documentReviewStatusTone } from '../../shared/status-tone';
import { TIMEZONE_SELECT_OPTIONS } from '../../shared/timezone-options';

const VERTICAL_OPTIONS: SelectOption[] = [
  { value: 'shuttle', label: 'Shuttle' },
  { value: 'intercity', label: 'Intercity' },
  { value: 'metro', label: 'Metro' },
];

// docs/specs/10-booking-modes.md. `tap_and_go` is gone from this list
// because it was never a booking mode — it bundled "no assigned seat"
// with "pay after travel", which are now independent, and each has its
// own control below.
const BOOKING_MODE_OPTIONS: SelectOption[] = [
  { value: 'reservation', label: 'Reservation — passengers pick a seat' },
  { value: 'open_seating', label: 'Open seating — any seat, no reservation' },
];

const FARE_COLLECTION_MODE_OPTIONS: SelectOption[] = [
  { value: 'prepaid', label: 'Prepaid — passengers pay before travelling' },
  { value: 'pay_as_you_go', label: 'Pay as you go — fare charged after travel' },
];

/** The axis most often confused with "Fare pricing mode" directly
 * below it. One is *when* money is collected, the other is *how much*
 * — naming them apart in the hint costs a line and saves the mix-up. */
const FARE_COLLECTION_MODE_HINT =
  'When the fare is collected, not how it is calculated. Pay as you go prices a journey ' +
  'from a board and alight tap, so those passengers book nothing in advance.';

const SEAT_SELECTION_HINT =
  'Off means passengers buy a place on the departure and are allocated a seat, without ' +
  'choosing one themselves.';

const CAPACITY_ENFORCED_HINT =
  'On refuses new bookings once every place on the vehicle is sold. Off keeps selling — ' +
  'use it only where standing room is normal.';

const FARE_PRICING_MODE_OPTIONS: SelectOption[] = [
  { value: 'flat', label: 'Flat — one fare per route' },
  { value: 'per_segment', label: 'Per segment — a fare per stop pair' },
];

/**
 * Said at the point of change, not in a help page. `get_fare()` picks
 * the rule *type* from this field at lookup time, so switching does not
 * migrate or delete anything — the other mode's rules simply stop being
 * consulted, and come back if the mode is switched back. Without this
 * stated, the obvious reading of the control is that it converts
 * existing prices, which it does not.
 */
const FARE_PRICING_MODE_HINT =
  'Switching keeps the fares you already entered for the other mode — they stop being ' +
  'used for pricing, and apply again if you switch back. Per-segment routes need a fare ' +
  'for every stop pair before they can be booked.';

type BusinessWriteFields = Omit<Business, 'id' | 'kyb_status' | 'kyb_submitted_at' | 'created_at'>;

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
 * One component for both create (`businesses/new`) and edit
 * (`businesses/:id/edit`) — see plan §"Design decisions". There's no
 * `GET /businesses/{id}/` endpoint (deliberate, Phase 1 Slice 3 §4) —
 * edit mode resolves the business through `BusinessStore.findById()`,
 * which checks the already-loaded page and then pages the full list.
 *
 * That lookup used to be one bounded `getAll()` plus `.find()`, with
 * this docstring recording the resulting "outside the current page
 * falls through to not-found" as an accepted limitation. It wasn't
 * acceptable in practice: against 77 Businesses, a real (non-fixture)
 * record at index 32 could not be opened at all, and spec 11 made it
 * worse by hanging the KYB screen off a link on this page.
 */
@Component({
  selector: 'app-business-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Alert,
    Button,
    Select,
    StatusPill,
    TextField,
    Toggle,
  ],
  templateUrl: './business-form.html',
})
export class BusinessForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  protected readonly store = inject(BusinessStore);

  protected readonly verticalOptions = VERTICAL_OPTIONS;
  protected readonly bookingModeOptions = BOOKING_MODE_OPTIONS;
  protected readonly farePricingModeOptions = FARE_PRICING_MODE_OPTIONS;
  protected readonly farePricingModeHint = FARE_PRICING_MODE_HINT;
  protected readonly fareCollectionModeOptions = FARE_COLLECTION_MODE_OPTIONS;
  protected readonly fareCollectionModeHint = FARE_COLLECTION_MODE_HINT;
  protected readonly seatSelectionHint = SEAT_SELECTION_HINT;
  protected readonly capacityEnforcedHint = CAPACITY_ENFORCED_HINT;
  // A leading empty option, not just the raw list: the form control
  // defaults to '' and a <select> with no matching <option> would
  // render the first real currency as if it were chosen while the
  // model still held '' — the user would see "NGN" and get a required
  // -field error on submit. The placeholder keeps what's shown and
  // what's stored in agreement.
  protected readonly currencyOptions = [
    { value: '', label: 'Select a currency' },
    ...CURRENCY_SELECT_OPTIONS,
  ];
  protected readonly timezoneOptions = [
    { value: '', label: 'Select a timezone' },
    ...TIMEZONE_SELECT_OPTIONS,
  ];
  protected readonly kybStatusTone = documentReviewStatusTone;

  protected readonly businessId = signal<string | null>(null);
  protected readonly editing = computed(() => this.businessId() !== null);
  protected readonly existingBusiness = signal<Business | null>(null);
  protected readonly notFound = signal(false);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);



  protected readonly form = this.fb.nonNullable.group({
    vertical: ['shuttle', Validators.required],
    name: ['', Validators.required],
    currency: ['', Validators.required],
    timezone: ['', Validators.required],
    booking_mode_default: ['reservation', Validators.required],
    fare_collection_mode: ['prepaid', Validators.required],
    fare_pricing_mode: ['flat', Validators.required],
    seat_selection_enabled: [true],
    capacity_enforced: [true],
  });

  /**
   * Which of the two mode-specific switches applies. Each is meaningful
   * in exactly one booking mode, and the backend deliberately does not
   * validate them against it — an inert value is harmless and keeps a
   * Business's settings stable across a mode switch and back
   * (docs/specs/10-booking-modes.md). So this hides rather than
   * disables or resets: the stored value must survive being irrelevant.
   *
   * `toSignal`, not a read of `form.controls.….value`: a `computed`
   * over a plain form-control value depends on no signal at all and
   * caches its first result forever — the exact bug both validator
   * screens carried until slice 3.
   */
  private readonly bookingMode = toSignal(this.form.controls.booking_mode_default.valueChanges, {
    initialValue: 'reservation',
  });
  protected readonly isOpenSeating = computed(() => this.bookingMode() === 'open_seating');

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      return;
    }
    this.businessId.set(id);

    const business = await this.store.findById(id);
    if (!business) {
      this.notFound.set(true);
      return;
    }

    this.existingBusiness.set(business);
    this.form.patchValue({
      vertical: business.vertical,
      name: business.name,
      currency: business.currency,
      timezone: business.timezone,
      booking_mode_default: business.booking_mode_default,
      // Optional in the generated type, so defaulted rather than left
      // as `undefined`, which `patchValue` would treat as "no change"
      // and silently leave showing 'flat' regardless of the real value.
      fare_pricing_mode: business.fare_pricing_mode ?? 'flat',
      fare_collection_mode: business.fare_collection_mode ?? 'prepaid',
      // `?? true` matches the model default. Defaulting a *boolean* to
      // the wrong value is worse than defaulting a select: a switch
      // silently reading "on" while the record says off would be saved
      // back as on by an unrelated edit.
      seat_selection_enabled: business.seat_selection_enabled ?? true,
      capacity_enforced: business.capacity_enforced ?? true,
    });
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    const values = this.form.getRawValue();
    const body: BusinessWriteFields = {
      vertical: values.vertical as Business['vertical'],
      name: values.name,
      currency: values.currency as Business['currency'],
      timezone: values.timezone,
      booking_mode_default: values.booking_mode_default as Business['booking_mode_default'],
      fare_pricing_mode: values.fare_pricing_mode as Business['fare_pricing_mode'],
      fare_collection_mode: values.fare_collection_mode as Business['fare_collection_mode'],
      // Both are always sent, including the one the current mode makes
      // inert. The backend stores it deliberately (see `isOpenSeating`),
      // and omitting it here would let a mode switch quietly reset the
      // other mode's setting to its default.
      seat_selection_enabled: values.seat_selection_enabled,
      capacity_enforced: values.capacity_enforced,
    };

    const authHeader = {
      Authorization: `Bearer ${this.authStore.accessToken()}`,
    };
    const id = this.businessId();
    const { data, error } = id
      ? await this.api.PATCH('/api/v1/businesses/{id}/', {
          params: { path: { id } },
          body,
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/businesses/', {
          body: body as Business,
          headers: authHeader,
        });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(
          error,
          'Could not save this business. Check your details and try again.',
        ),
      );
      return;
    }

    await this.router.navigate(['/businesses']);
  }

  protected fieldError(
    field:
      | 'vertical'
      | 'name'
      | 'currency'
      | 'timezone'
      | 'booking_mode_default'
      | 'fare_pricing_mode'
      | 'fare_collection_mode',
  ): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }

  /** `ui-toggle` is deliberately not a `ControlValueAccessor` (see its
   * own docstring), so it is bound by hand here rather than through
   * `formControlName`. That stays within its contract — state in via
   * `checked`, intent out via `toggled` — and keeps one switch
   * component across the app instead of introducing a second. */
  protected setFlag(field: 'seat_selection_enabled' | 'capacity_enforced', value: boolean): void {
    this.form.controls[field].setValue(value);
    this.form.controls[field].markAsTouched();
  }

  protected flag(field: 'seat_selection_enabled' | 'capacity_enforced'): boolean {
    return this.form.controls[field].value;
  }
}

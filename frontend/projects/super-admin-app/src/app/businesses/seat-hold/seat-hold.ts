import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { Alert, Button, PageHeader, Skeleton, TextField, fieldErrorMessage } from '@shared-ui';

import {
  BusinessSuperAdminStore,
  type BusinessSuperAdmin,
} from '../../shared/data/store/business-super-admin.store';

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
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
 * Configure how long a Business's seat holds last before the expiry
 * sweep releases them (`GET`/`PATCH
 * /super-admin/businesses/{id}/seat-hold/`, docs/adr/0004) — mirrors
 * `PaystackConfig`'s GET-before-show shape exactly, minus that
 * screen's "not yet configured" branch: `seat_hold_minutes` is a plain
 * non-nullable field with a model default, so there's no
 * unconfigured state to render around, only a value to show and edit.
 *
 * **It does nothing for an open-seating Business.** Nothing holds a
 * seat there — a place is counted when a ticket is issued, not
 * reserved on the way to payment (docs/specs/10-booking-modes.md). The
 * field is still editable, because a Business can switch modes and the
 * stored value should survive that; it is the screen's job to say the
 * setting is currently inert rather than to let platform staff tune a
 * number that changes nothing.
 */
@Component({
  selector: 'app-seat-hold',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Alert, Button, PageHeader, Skeleton, TextField],
  templateUrl: './seat-hold.html',
})
export class SeatHold implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly businessStore = inject(BusinessSuperAdminStore);

  protected readonly businessId = signal('');
  protected readonly business = signal<BusinessSuperAdmin | null>(null);
  protected readonly notFound = signal(false);
  protected readonly loading = signal(true);
  protected readonly submitting = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly successMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    seat_hold_minutes: ['', Validators.required],
  });

  protected readonly inert = computed(
    () => this.business()?.booking_mode_default === 'open_seating'
  );

  /** The Business name lives in the heading rather than in a suffixed
   * `<h1>` fragment, so the page has one title rather than a title and
   * a trailing em-dash clause. */
  protected readonly heading = computed(() => {
    const business = this.business();
    return business ? `Seat-hold duration — ${business.name}` : 'Seat-hold duration';
  });

  /**
   * The error that actually failed, not a hardcoded sentence.
   *
   * This field bound `errorMessage="This field is required."`
   * literally — the exact defect slice 4 removed seventeen copies of.
   * It says the right thing today only because `required` is the field's
   * only validator, which is itself worth noting: nothing here rejects
   * `0`, `-5` or `abc`, so those reach the API. Named, not fixed —
   * adding validation is behaviour, and this slice changes none.
   */
  protected fieldError(): string | null {
    return fieldErrorMessage(this.form.controls.seat_hold_minutes, { label: 'Minutes' });
  }

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      return;
    }
    this.businessId.set(id);

    const business = await this.businessStore.findById(id);
    if (!business) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.business.set(business);

    const { data, error } = await this.api.GET('/api/v1/super-admin/businesses/{id}/seat-hold/', {
      params: { path: { id } },
    });

    if (data) {
      this.form.patchValue({ seat_hold_minutes: String(data.seat_hold_minutes) });
    } else {
      this.loadError.set(
        extractFirstErrorMessage(error, 'Could not load the current seat-hold duration.')
      );
    }
    this.loading.set(false);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.successMessage.set(null);
    this.loadError.set(null);

    const { data, error } = await this.api.PATCH('/api/v1/super-admin/businesses/{id}/seat-hold/', {
      params: { path: { id: this.businessId() } },
      body: { seat_hold_minutes: Number(this.form.getRawValue().seat_hold_minutes) },
    });

    this.submitting.set(false);

    if (!data) {
      this.loadError.set(
        extractFirstErrorMessage(error, 'Could not save this seat-hold duration.')
      );
      return;
    }

    this.successMessage.set('Seat-hold duration saved.');
    this.form.patchValue({ seat_hold_minutes: String(data.seat_hold_minutes) });
  }
}

import { ChangeDetectionStrategy, Component, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore, HasPermissionDirective } from '@auth';
import { Alert, Button, Select, StatusPill, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { DOCUMENT_TYPE_OPTIONS } from '../../shared/document-type-options';
import { FileUploadField } from '../../shared/file-upload-field';
import { documentReviewStatusTone } from '../../shared/status-tone';

const VERTICAL_OPTIONS: SelectOption[] = [
  { value: 'shuttle', label: 'Shuttle' },
  { value: 'intercity', label: 'Intercity' },
  { value: 'metro', label: 'Metro' },
];

const BOOKING_MODE_OPTIONS: SelectOption[] = [
  { value: 'reservation', label: 'Reservation' },
  { value: 'tap_and_go', label: 'Tap and go' },
];

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
 * edit mode looks the business up in `BusinessStore`'s already-loaded
 * items rather than fetching it individually, re-running `getAll()`
 * once if it isn't there yet. A direct deep link to an edit URL for a
 * business outside the store's current page falls through to the
 * not-found state below rather than paging through the whole list.
 */
@Component({
  selector: 'app-business-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    Select,
    StatusPill,
    TextField,
    FileUploadField,
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
  protected readonly documentTypeOptions = DOCUMENT_TYPE_OPTIONS;
  protected readonly kybStatusTone = documentReviewStatusTone;

  protected readonly businessId = signal<string | null>(null);
  protected readonly editing = computed(() => this.businessId() !== null);
  protected readonly existingBusiness = signal<Business | null>(null);
  protected readonly notFound = signal(false);

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly kybDocumentType = signal('certificate_of_incorporation');
  protected readonly kybSelectedFile = signal<File | null>(null);
  protected readonly kybUploading = signal(false);
  protected readonly kybUploadError = signal<string | null>(null);

  @ViewChild(FileUploadField) private readonly kybFileField!: FileUploadField;

  protected readonly form = this.fb.nonNullable.group({
    vertical: ['shuttle', Validators.required],
    name: ['', Validators.required],
    currency: ['', Validators.required],
    timezone: ['', Validators.required],
    booking_mode_default: ['reservation', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      return;
    }
    this.businessId.set(id);

    let business = this.store.items().find((b) => b.id === id) ?? null;
    if (!business) {
      await this.store.getAll();
      business = this.store.items().find((b) => b.id === id) ?? null;
    }

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
      currency: values.currency,
      timezone: values.timezone,
      booking_mode_default: values.booking_mode_default as Business['booking_mode_default'],
    };

    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const id = this.businessId();
    const { data, error } = id
      ? await this.api.PATCH('/api/v1/businesses/{id}/', {
          params: { path: { id } },
          body,
          headers: authHeader,
        })
      : await this.api.POST('/api/v1/businesses/', { body: body as Business, headers: authHeader });

    this.submitting.set(false);

    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save this business. Check your details and try again.')
      );
      return;
    }

    await this.router.navigate(['/businesses']);
  }

  protected onKybFileSelected(file: File | null): void {
    this.kybSelectedFile.set(file);
  }

  protected setKybDocumentType(value: string): void {
    this.kybDocumentType.set(value);
  }

  protected async onKybUpload(): Promise<void> {
    const business = this.existingBusiness();
    const file = this.kybSelectedFile();
    if (!business || !file) {
      this.kybUploadError.set('Choose a file to upload.');
      return;
    }

    this.kybUploading.set(true);
    this.kybUploadError.set(null);
    const formData = new FormData();
    formData.append('document_type', this.kybDocumentType());
    formData.append('file', file);

    const { data, error } = await this.api.POST('/api/v1/businesses/{business_id}/kyb-documents/', {
      params: { path: { business_id: business.id } },
      body: formData as unknown as components['schemas']['KybDocument'],
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.kybUploading.set(false);

    if (!data) {
      this.kybUploadError.set(extractFirstErrorMessage(error, 'Could not upload this document. Try again.'));
      return;
    }

    this.kybSelectedFile.set(null);
    this.kybFileField.reset();
    await this.refreshExistingBusiness(business.id);
  }

  private async refreshExistingBusiness(id: string): Promise<void> {
    await this.store.getAll();
    const refreshed = this.store.items().find((b) => b.id === id);
    if (refreshed) {
      this.existingBusiness.set(refreshed);
    }
  }

  protected fieldError(
    field: 'vertical' | 'name' | 'currency' | 'timezone' | 'booking_mode_default'
  ): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}

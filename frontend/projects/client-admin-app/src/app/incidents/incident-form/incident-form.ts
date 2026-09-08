import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { Alert, Button, FormSection, PageHeader, Select, TextField, Textarea } from '@shared-ui';

import { IncidentStore } from '../../shared/data/store/incident.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import { CATEGORY_OPTIONS, SEVERITY_OPTIONS } from '../../shared/incident-labels';

/**
 * Report or edit an incident — spec 17 slice 2.
 *
 * ## `status` is not on this form
 *
 * It is not on the PATCH serializer either, and the backend answers 400
 * naming the transition endpoint if a request tries. Status is a
 * lifecycle moved from the queue or the detail screen, not a field
 * edited alongside a title — which is what stops an operator "correcting"
 * an incident into a state its history never passed through.
 *
 * ## Every control binds `[invalid]` *and* `[errorMessage]`
 *
 * `ui-text-field` and `ui-select` render a validation message only when
 * the parent binds both. A form binding neither silently does nothing on
 * an invalid submit, which is exactly how a previous form in this app
 * shipped broken — so the spec asserts rendered `[role="alert"]` text,
 * not merely that no request fired.
 */
@Component({
  selector: 'app-incident-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Alert,
    Button,
    FormSection,
    PageHeader,
    Select,
    TextField,
    Textarea,
  ],
  templateUrl: './incident-form.html',
})
export class IncidentForm {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(API_CLIENT);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly store = inject(IncidentStore);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);

  protected readonly severityOptions = SEVERITY_OPTIONS;
  protected readonly categoryOptions = CATEGORY_OPTIONS;

  protected readonly incidentId = signal<string | null>(null);
  protected readonly reference = signal<string | null>(null);
  protected readonly editing = computed(() => this.incidentId() !== null);
  protected readonly notFound = signal(false);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    // Hidden value-carrier, like every other business-scoped form here:
    // resolved from the header switcher on create, disabled on edit.
    business: ['', Validators.required],
    title: ['', Validators.required],
    category: ['hardware', Validators.required],
    severity: ['medium', Validators.required],
    description: [''],
    device_reference: [''],
    resolution_notes: [''],
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.activatedRoute.snapshot.paramMap.get('id');
    if (!id) {
      this.form.patchValue({
        business: this.selectedBusinessStore.selectedBusinessId() ?? '',
      });
      return;
    }

    this.incidentId.set(id);
    const incident = await this.store.findDetail(id);
    if (!incident) {
      this.notFound.set(true);
      return;
    }
    this.reference.set(incident.reference);
    this.form.patchValue({
      business: incident.business,
      title: incident.title,
      // `?? <default>` on every field: DRF marks anything with a model
      // default `required=False`, so the generated read type admits
      // `undefined`, and `patchValue` applies an explicit `undefined`
      // rather than skipping the key — blanking a required control and
      // making the form silently unsubmittable.
      category: incident.category ?? 'hardware',
      severity: incident.severity ?? 'medium',
      description: incident.description ?? '',
      device_reference: incident.device_reference ?? '',
      resolution_notes: incident.resolution_notes ?? '',
    });
    this.form.controls.business.disable();
  }

  protected fieldError(field: 'title' | 'category' | 'severity'): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set(null);
    clearServerErrors(this.form);

    const raw = this.form.getRawValue();
    const id = this.incidentId();
    const { data, error } = id
      ? await this.api.PATCH('/api/v1/incidents/{id}/', {
          params: { path: { id } },
          body: {
            title: raw.title,
            category: raw.category as 'hardware',
            severity: raw.severity as 'medium',
            description: raw.description,
            device_reference: raw.device_reference,
            resolution_notes: raw.resolution_notes,
          },
        })
      : await this.api.POST('/api/v1/incidents/', {
          // Idempotency-Key is required by this endpoint: a retried
          // create must return the original rather than filing a second
          // incident with a second reference. It is a documented header
          // parameter, so it goes through `params.header` — the same way
          // customer-app's booking and wallet calls pass theirs.
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            business: raw.business,
            title: raw.title,
            category: raw.category as 'hardware',
            severity: raw.severity as 'medium',
            description: raw.description,
            device_reference: raw.device_reference,
          },
        });

    this.submitting.set(false);
    if (!data) {
      this.errorMessage.set(
        applyServerErrors(this.form, error, 'Could not save this incident. Please try again.')
      );
      return;
    }
    await this.router.navigate(['/incidents', data.id]);
  }
}

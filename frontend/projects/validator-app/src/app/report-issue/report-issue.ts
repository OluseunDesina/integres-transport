import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  Alert,
  Button,
  FormSection,
  PageHeader,
  Select,
  TextField,
  Textarea,
  fieldErrorMessage,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';
import type { components } from '@api-client';

import { OpenTripsService, type Trip } from '../shared/open-trips.service';
import { ReportIssueService } from './report-issue.service';

type Category = components['schemas']['CategoryEnum'];
type Severity = components['schemas']['SeverityEnum'];

/**
 * The operator vocabulary, not the passenger one. A conductor filing
 * this is the person the queue's category filter is written for, so the
 * labels match `client-admin-app`'s own.
 */
const CATEGORY_OPTIONS: SelectOption[] = [
  // Not "What kind of problem?": the control is labelled "Kind of
  // problem", and a prompt that restates its own label is read out
  // twice.
  { value: '', label: 'Choose one' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'safety', label: 'Safety' },
  { value: 'service', label: 'Service quality' },
  { value: 'gps', label: 'GPS / location' },
  { value: 'announcement', label: 'Stop announcement' },
  { value: 'other', label: 'Other' },
];

const SEVERITY_OPTIONS: SelectOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDeparture(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A conductor reports a problem with the trip they are working —
 * docs/specs/17-incidents.md slice 3.
 *
 * A third screen with its own trip picker rather than a dialog on the
 * other two, because that is the shape this app already has: `/record`
 * and `/validate-ticket` each pick their own trip, and a report is not
 * something you should have to start a tap or a scan to reach.
 *
 * **Severity is on this form and defaults to Medium.** A conductor is
 * staff, and slice 1 notifies on `high`/`critical` creates — a
 * frontline report of something dangerous should ring the bell, and a
 * broken reader should not. That is a judgement only the person
 * standing there can make.
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
  private readonly fb = inject(FormBuilder);
  private readonly openTrips = inject(OpenTripsService);
  private readonly reports = inject(ReportIssueService);

  protected readonly categoryOptions = CATEGORY_OPTIONS;
  protected readonly severityOptions = SEVERITY_OPTIONS;

  protected readonly form = this.fb.nonNullable.group({
    tripId: ['', Validators.required],
    category: ['', Validators.required],
    title: ['', Validators.required],
    severity: ['medium', Validators.required],
    description: [''],
    deviceReference: [''],
  });

  protected readonly trips = signal<Trip[]>([]);
  protected readonly loadingTrips = signal(false);
  protected readonly tripsError = signal<string | null>(null);

  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);
  /** The reference of the report just filed, so the conductor has
   * something to quote on the radio. Cleared by "Report something
   * else". */
  protected readonly filedReference = signal<string | null>(null);

  protected readonly tripOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.loadingTrips() ? 'Loading trips…' : 'Select a trip' },
    ...this.trips().map((trip) => ({
      value: trip.id,
      label: `${trip.route.name} — ${formatDeparture(trip.scheduled_departure_at)}`,
    })),
  ]);

  /** A `computed()` reading `form.controls.tripId.value` would depend on
   * no signal and cache its first result — the trap CLAUDE.md records,
   * and the same seam `record-tap.ts` uses for the identical reason. */
  private readonly selectedTripId = toSignal(this.form.controls.tripId.valueChanges, {
    initialValue: '',
  });

  protected readonly selectedTrip = computed<Trip | null>(
    () => this.trips().find((trip) => trip.id === this.selectedTripId()) ?? null
  );

  /**
   * What the report will carry beyond what the conductor typed.
   *
   * Stated on screen rather than left implicit: a form that silently
   * attaches a vehicle registration is a form whose author knows
   * something the user does not.
   */
  protected readonly attachmentSummary = computed<string | null>(() => {
    const trip = this.selectedTrip();
    if (!trip) {
      return null;
    }
    const parts = [`route ${trip.route.name}`];
    if (trip.vehicle) {
      parts.push(`vehicle ${trip.vehicle.registration_number}`);
    }
    return `This report will name ${parts.join(' and ')}.`;
  });

  async ngOnInit(): Promise<void> {
    this.loadingTrips.set(true);
    try {
      this.trips.set(await this.openTrips.loadForDate(todayISO()));
    } catch {
      this.tripsError.set('Could not load today’s trips. Check your connection and try again.');
    } finally {
      this.loadingTrips.set(false);
    }
  }

  protected fieldError(field: 'tripId' | 'category' | 'title'): string | null {
    return fieldErrorMessage(this.form.controls[field], {
      messages: {
        required: {
          tripId: 'Choose the trip this happened on.',
          category: 'Choose what kind of problem this is.',
          title: 'Give the report a short heading.',
        }[field],
      },
    });
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const trip = this.selectedTrip();
    if (!trip) {
      return;
    }

    this.submitError.set(null);
    this.submitting.set(true);
    const value = this.form.getRawValue();
    const result = await this.reports.report({
      trip,
      category: value.category as Category,
      title: value.title,
      severity: value.severity as Severity,
      description: value.description,
      deviceReference: value.deviceReference,
    });
    this.submitting.set(false);

    if (!result.ok) {
      this.submitError.set(result.message);
      return;
    }
    this.filedReference.set(result.data.reference);
  }

  /** Keeps the trip selected. A conductor who has just found one broken
   * reader is more likely than anyone to be about to report a second
   * thing on the same bus. */
  protected reportAnother(): void {
    this.filedReference.set(null);
    this.submitError.set(null);
    this.form.patchValue({
      category: '',
      title: '',
      severity: 'medium',
      description: '',
      deviceReference: '',
    });
    this.form.markAsUntouched();
  }
}

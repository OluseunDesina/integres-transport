import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import {
  Alert,
  Button,
  Checkbox,
  FormSection,
  Icon,
  PageHeader,
  Select,
  StatusPill,
  Tabs,
  TextField,
} from '@shared-ui';
import type { SelectOption, TabItem } from '@shared-ui';

import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import { statusLabel, statusTone } from '../../shared/route-labels';
import { TRIP_CLASS_OPTIONS, type TripClass } from '../../shared/trip-class';

type RouteStopEntry = components['schemas']['RouteStopEntry'];

const TABS: TabItem[] = [
  { id: 'details', label: 'Details' },
  { id: 'stops', label: 'Stops' },
];

/**
 * One component for create (`routes/new`) and edit (`routes/:id/edit`) —
 * mirrors BusinessForm's dual-mode shape. Edit mode also carries the
 * ordered stop-picker (add-via-select + up/down reorder), local to this
 * app and used only here — matching the "used once, local" precedent the
 * KYC/KYB approve-reject form set in Phase 2.
 */
@Component({
  selector: 'app-route-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    FormsModule,
    RouterLink,
    Alert,
    Button,
    Checkbox,
    FormSection,
    Icon,
    PageHeader,
    Select,
    StatusPill,
    Tabs,
    TextField,
  ],
  templateUrl: './route-form.html',
})
export class RouteForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(RouteStore);

  protected readonly routeId = signal<string | null>(null);
  protected readonly editing = computed(() => this.routeId() !== null);
  protected readonly existingRoute = signal<Route | null>(null);
  protected readonly notFound = signal(false);
  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;
  /** docs/specs/19-route-lifecycle.md edge case: "Editing an archived
   * route: 400; restore first." The form disables itself rather than
   * letting an operator fill it in only to meet that rejection on
   * submit — restoring is the Routes list's row menu action, not
   * anything this screen can do. */
  protected readonly isArchived = computed(() => this.existingRoute()?.status === 'archived');

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  // Unlike create (which navigates to the new route's edit page) and
  // unlike Business/Stop's edit mode (which navigates back to their
  // list), Route's edit mode deliberately stays in place afterward so
  // the stop-order section below stays usable — nothing else in the UI
  // would otherwise signal that a details save actually completed.
  protected readonly detailsSaved = signal(false);

  /** Details and Stops are two unrelated panels of one record, and both
   * are already loaded by the time either renders — which is the model
   * `ui-tabs` is built for. Create mode has no stops yet, so the tab
   * list only appears once editing. */
  protected readonly tabs = TABS;
  protected readonly activeTab = signal('details');

  protected readonly routeStops = signal<RouteStopEntry[]>([]);
  protected readonly availableStops = signal<{ id: string; name: string }[]>([]);
  protected readonly stopToAdd = signal('');
  protected readonly savingStops = signal(false);
  protected readonly stopsError = signal<string | null>(null);
  protected readonly stopsSaved = signal(false);

  protected readonly addStopOptions = computed<SelectOption[]>(() => {
    const added = new Set(this.routeStops().map((s) => s.id));
    return this.availableStops()
      .filter((stop) => !added.has(stop.id))
      .map((stop) => ({ value: stop.id, label: stop.name }));
  });

  // `business` has no field in the template any more — it's resolved
  // from whichever Business is active in the header switcher. It stays
  // a form control purely as the value carrier for create.
  //
  // `status` is gone entirely: the Routes list's row menu owns every
  // transition (docs/specs/19-route-lifecycle.md — the backend rejects
  // a PATCH naming it, and this form never sends the key). Leaving it
  // here would mean a details-only save silently re-sent whatever value
  // this form loaded with, clobbering a status change made elsewhere in
  // the meantime.
  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    code: [''],
    description: [''],
    // Both optional and both plain strings, not `type="number"` —
    // `ui-text-field` doesn't offer that type (spinners, scroll-wheel
    // capture and locale-dependent parsing), so these use
    // `inputMode="decimal"`/`"numeric"` instead, same as
    // `seat-hold.ts`'s `seat_hold_minutes`.
    distance_km: [''],
    estimated_duration_minutes: [''],
  });

  /**
   * `available_trip_classes` — docs/specs/15-trip-classes.md.
   *
   * A local signal rather than a form control, mirroring
   * `ScheduleForm`'s `selectedDays` exactly: a checkbox group over a
   * fixed list is the same shape, and both are "used once, local".
   *
   * **Empty means every class is allowed**, not "none" — that reading
   * is what keeps every Route created before spec 15 schedulable, and
   * inverting it here would silently empty the class picker on
   * `ScheduleForm` and `TripForm` for every existing route. The
   * template says so rather than leaving it to be inferred from an
   * all-unchecked group.
   */
  protected readonly tripClassOptions = TRIP_CLASS_OPTIONS;
  protected readonly selectedClasses = signal<TripClass[]>([]);
  protected readonly allClassesAllowed = computed(() => this.selectedClasses().length === 0);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      // Create mode: the Route belongs to whichever Business is active
      // in the header switcher — there's no field to pick one any more.
      // Re-asking here was redundant (it was pre-filled from this same
      // value) and let a user create a Route under a Business other
      // than the one every other screen was showing them.
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (!activeBusinessId) {
        this.errorMessage.set('Select a business from the header before creating a route.');
        return;
      }
      this.form.patchValue({ business: activeBusinessId });
      return;
    }
    this.routeId.set(id);

    // The real single-record GET added in docs/specs/19-route-lifecycle.md
    // slice 1 — no bounded-page lookup needed any more.
    const route = await this.store.findById(id);

    if (!route) {
      this.notFound.set(true);
      return;
    }

    this.setExistingRoute(route);
    await this.loadAvailableStops(route.business);
  }

  protected isClassSelected(value: string): boolean {
    return this.selectedClasses().includes(value as TripClass);
  }

  protected toggleClass(value: string, checked: boolean): void {
    const entry = value as TripClass;
    this.selectedClasses.update((classes) =>
      checked
        ? [...classes, entry]
        : classes.filter((existing) => existing !== entry)
    );
  }

  private setExistingRoute(route: Route): void {
    this.existingRoute.set(route);
    this.routeStops.set([...route.stops].sort((a, b) => a.sequence - b.sequence));
    // `?? []` because the field is optional on write, so the generated
    // type admits `undefined` even though a read always carries it.
    // Empty is the right fallback either way: it means "every class".
    this.selectedClasses.set((route.available_trip_classes ?? []) as TripClass[]);
    this.form.patchValue({
      business: route.business,
      name: route.name,
      code: route.code,
      description: route.description,
      distance_km: route.distance_km ?? '',
      estimated_duration_minutes:
        route.estimated_duration_minutes != null ? String(route.estimated_duration_minutes) : '',
    });
    if (route.status === 'archived') {
      this.form.disable();
    } else {
      this.form.enable();
      this.form.controls.business.disable();
    }
  }

  private async loadAvailableStops(businessId: string): Promise<void> {
    const { data } = await this.api.GET('/api/v1/stops/', {
      params: { query: { limit: 100, offset: 0 } },
    });
    if (data) {
      this.availableStops.set(
        data.results
          .filter((stop) => stop.business === businessId)
          .map((stop) => ({ id: stop.id, name: stop.name }))
      );
    }
  }

  protected async onSubmit(): Promise<void> {
    // A disabled FormGroup reports `invalid: false` regardless of its
    // controls' own state, so `isArchived()` needs its own guard here —
    // the backend's own 400 for this case names the fix, but there is
    // no reason to round-trip for it when the screen already knows.
    if (this.isArchived() || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.detailsSaved.set(false);
    // Clear last attempt's server errors, or a field the server no
    // longer objects to keeps showing why it once did.
    clearServerErrors(this.form);
    const values = this.form.getRawValue();
    const id = this.routeId();

    if (id) {
      const { data, error } = await this.api.PATCH('/api/v1/routes/{id}/', {
        params: { path: { id } },
        body: {
          name: values.name,
          code: values.code,
          description: values.description,
          available_trip_classes: this.selectedClasses(),
          // Blank means "not set", not "zero" — an empty control sends
          // `null`, never `0` or an empty string, so a route with no
          // recorded depth stays that way rather than reporting a
          // distance/duration of nothing.
          distance_km: values.distance_km.trim() || null,
          estimated_duration_minutes: values.estimated_duration_minutes.trim()
            ? Number(values.estimated_duration_minutes)
            : null,
        },
      });
      this.submitting.set(false);
      if (!data) {
        this.errorMessage.set(
          applyServerErrors(
            this.form,
            error,
            'Could not save this route. Check your details and try again.'
          )
        );
        return;
      }
      this.setExistingRoute(data);
      this.detailsSaved.set(true);
      return;
    }

    const { data, error } = await this.api.POST('/api/v1/routes/', {
      body: {
        business: values.business,
        name: values.name,
        code: values.code,
        description: values.description,
        available_trip_classes: this.selectedClasses(),
      },
    });
    this.submitting.set(false);
    if (!data) {
      this.errorMessage.set(
        applyServerErrors(
          this.form,
          error,
          'Could not save this route. Check your details and try again.'
        )
      );
      return;
    }
    await this.router.navigate(['/routes', data.id, 'edit']);
  }

  protected setStopToAdd(value: string): void {
    this.stopToAdd.set(value);
  }

  protected addStop(): void {
    const stopId = this.stopToAdd();
    const stop = this.availableStops().find((s) => s.id === stopId);
    if (!stop) {
      return;
    }
    this.routeStops.update((stops) => [
      ...stops,
      { ...stop, sequence: stops.length + 1 } as RouteStopEntry,
    ]);
    this.stopToAdd.set('');
    this.stopsSaved.set(false);
  }

  protected removeStop(stopId: string): void {
    this.routeStops.update((stops) => stops.filter((s) => s.id !== stopId));
    this.stopsSaved.set(false);
  }

  protected moveStop(index: number, direction: -1 | 1): void {
    const target = index + direction;
    const stops = [...this.routeStops()];
    if (target < 0 || target >= stops.length) {
      return;
    }
    [stops[index], stops[target]] = [stops[target], stops[index]];
    this.routeStops.set(stops);
    this.stopsSaved.set(false);
  }

  protected async saveStopOrder(): Promise<void> {
    const routeId = this.routeId();
    if (!routeId) {
      return;
    }
    this.savingStops.set(true);
    this.stopsError.set(null);
    this.stopsSaved.set(false);

    const { data, error } = await this.api.PUT('/api/v1/routes/{id}/stops/', {
      params: { path: { id: routeId } },
      body: { stops: this.routeStops().map((s) => s.id) },
    });

    this.savingStops.set(false);

    if (!data) {
      this.stopsError.set(
        extractFirstErrorMessage(error, 'Could not save the stop order. Try again.')
      );
      return;
    }

    this.setExistingRoute(data);
    this.stopsSaved.set(true);
  }

  protected setActiveTab(id: string): void {
    this.activeTab.set(id);
  }

  /** Every field, not just the two with validators: any of them can come
   * back rejected by the server, and `fieldErrorMessage` surfaces that
   * the same way it surfaces a client-side failure. */
  protected fieldError(
    field:
      | 'business'
      | 'name'
      | 'code'
      | 'description'
      | 'distance_km'
      | 'estimated_duration_minutes'
  ): string | null {
    return fieldErrorMessage(this.form.controls[field]);
  }
}

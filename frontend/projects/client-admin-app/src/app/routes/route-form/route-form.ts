import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, TextField } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { BusinessOptionsService } from '../../shared/business-options.service';
import { RouteStore, type Route } from '../../shared/data/store/route.store';
import { SelectedBusinessStore } from '../../shared/data/store/selected-business.store';

type RouteStopEntry = components['schemas']['RouteStopEntry'];

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
 * One component for create (`routes/new`) and edit (`routes/:id/edit`) —
 * mirrors BusinessForm's dual-mode shape. Edit mode also carries the
 * ordered stop-picker (add-via-select + up/down reorder), local to this
 * app and used only here — matching the "used once, local" precedent the
 * KYC/KYB approve-reject form set in Phase 2.
 */
@Component({
  selector: 'app-route-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, FormsModule, RouterLink, Alert, Button, Select, TextField],
  templateUrl: './route-form.html',
})
export class RouteForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly businessOptions = inject(BusinessOptionsService);
  private readonly selectedBusinessStore = inject(SelectedBusinessStore);
  protected readonly store = inject(RouteStore);

  protected readonly routeId = signal<string | null>(null);
  protected readonly editing = computed(() => this.routeId() !== null);
  protected readonly existingRoute = signal<Route | null>(null);
  protected readonly notFound = signal(false);

  protected readonly businessOptionsList = signal<SelectOption[]>([]);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  // Unlike create (which navigates to the new route's edit page) and
  // unlike Business/Stop's edit mode (which navigates back to their
  // list), Route's edit mode deliberately stays in place afterward so
  // the stop-order section below stays usable — nothing else in the UI
  // would otherwise signal that a details save actually completed.
  protected readonly detailsSaved = signal(false);

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

  protected readonly form = this.fb.nonNullable.group({
    business: ['', Validators.required],
    name: ['', Validators.required],
    code: [''],
    description: [''],
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
      // Create mode: default the Business select to whichever one the
      // user currently has active, so a user working "inside" one
      // Business doesn't have to keep re-specifying it — still fully
      // changeable before submit.
      const activeBusinessId = this.selectedBusinessStore.selectedBusinessId();
      if (activeBusinessId) {
        this.form.patchValue({ business: activeBusinessId });
      }
      return;
    }
    this.routeId.set(id);

    let route = this.store.items().find((r) => r.id === id) ?? null;
    if (!route) {
      await this.store.getAll();
      route = this.store.items().find((r) => r.id === id) ?? null;
    }

    if (!route) {
      this.notFound.set(true);
      return;
    }

    this.setExistingRoute(route);
    this.form.controls.business.disable();
    await this.loadAvailableStops(route.business);
  }

  private setExistingRoute(route: Route): void {
    this.existingRoute.set(route);
    this.routeStops.set([...route.stops].sort((a, b) => a.sequence - b.sequence));
    this.form.patchValue({
      business: route.business,
      name: route.name,
      code: route.code,
      description: route.description,
      is_active: route.is_active ?? true,
    });
  }

  private async loadAvailableStops(businessId: string): Promise<void> {
    const { data } = await this.api.GET('/api/v1/stops/', {
      params: { query: { limit: 100, offset: 0 } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
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
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.detailsSaved.set(false);
    const values = this.form.getRawValue();
    const authHeader = { Authorization: `Bearer ${this.authStore.accessToken()}` };
    const id = this.routeId();

    if (id) {
      const { data, error } = await this.api.PATCH('/api/v1/routes/{id}/', {
        params: { path: { id } },
        body: {
          name: values.name,
          code: values.code,
          description: values.description,
          is_active: values.is_active,
        },
        headers: authHeader,
      });
      this.submitting.set(false);
      if (!data) {
        this.errorMessage.set(
          extractFirstErrorMessage(error, 'Could not save this route. Check your details and try again.')
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
      },
      headers: authHeader,
    });
    this.submitting.set(false);
    if (!data) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, 'Could not save this route. Check your details and try again.')
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
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.savingStops.set(false);

    if (!data) {
      this.stopsError.set(extractFirstErrorMessage(error, 'Could not save the stop order. Try again.'));
      return;
    }

    this.setExistingRoute(data);
    this.stopsSaved.set(true);
  }

  protected fieldError(field: 'business' | 'name'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) {
      return null;
    }
    return 'This field is required.';
  }
}

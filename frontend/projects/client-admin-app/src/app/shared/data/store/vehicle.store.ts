import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type Vehicle = components['schemas']['Vehicle'];

export interface VehicleQuery {
  business?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load vehicles.';
}

@Injectable({ providedIn: 'root' })
export class VehicleStore extends ListStore<Vehicle, VehicleQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: VehicleQuery,
    page: Page
  ): Promise<{ items: Vehicle[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/vehicles/', {
      params: { query: { limit: page.limit, offset: page.offset, business: query.business } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}

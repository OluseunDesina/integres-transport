import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type VehicleType = components['schemas']['VehicleType'];

export interface VehicleTypeQuery {
  business?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load vehicle types.';
}

@Injectable({ providedIn: 'root' })
export class VehicleTypeStore extends ListStore<VehicleType, VehicleTypeQuery> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: VehicleTypeQuery,
    page: Page
  ): Promise<{ items: VehicleType[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/vehicle-types/', {
      params: { query: { limit: page.limit, offset: page.offset, business: query.business } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /**
   * Resolves one VehicleType by id for its edit screen, which has no
   * single-record `GET` to call. Paging, the early exit and the
   * "never touch browse state" rule all live in
   * `ListStore.findByIdPaged`.
   *
   * Scoped with `{}`, not the live query: a deep link must resolve
   * whichever Business the record belongs to, regardless of which one
   * the header switcher happens to have selected. The list stays
   * Client-scoped server-side either way.
   */
  findById(id: string): Promise<VehicleType | null> {
    return this.findByIdPaged(id, {});
  }
}

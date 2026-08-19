import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { ListStore, type Page } from '@shared-data';

export type Staff = components['schemas']['Staff'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load staff.';
}

@Injectable({ providedIn: 'root' })
export class StaffStore extends ListStore<Staff> {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: Staff[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/staff/', {
      params: { query: { limit: page.limit, offset: page.offset } },
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}

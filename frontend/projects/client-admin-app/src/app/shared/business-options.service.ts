import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { SelectOption } from '@shared-ui';

/**
 * Not a `ListStore` subclass — same "small unpaginated helper" reasoning
 * as `RoleOptionsService`: Route/Stop creation needs a Business picker
 * (a Client can run several), but there's no need for pagination UI in
 * a `<select>`. One-shot fetch (limit=100 — proportionate for how many
 * Businesses a single Client realistically runs), mapped straight to
 * `SelectOption[]`.
 */
@Injectable({ providedIn: 'root' })
export class BusinessOptionsService {
  private readonly api = inject(API_CLIENT);

  async loadOptions(): Promise<SelectOption[]> {
    const { data, error } = await this.api.GET('/api/v1/businesses/', {
      params: { query: { limit: 100, offset: 0 } },
    });
    if (!data) {
      throw new Error(
        error && typeof error === 'object' && 'detail' in error
          ? String((error as { detail?: unknown }).detail)
          : 'Failed to load businesses.'
      );
    }
    return data.results.map((business) => ({
      value: business.id,
      label: business.name,
    }));
  }
}

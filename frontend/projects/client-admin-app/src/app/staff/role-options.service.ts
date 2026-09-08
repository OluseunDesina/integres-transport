import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { SelectOption } from '@shared-ui';

/**
 * Not a `ListStore` subclass — `GET /staff/roles/` is paginated like
 * every other list endpoint, but there are only 3 fixed Role presets per
 * Client ever (no create-role feature this phase), so a picker doesn't
 * need pagination UI. One-shot fetch, mapped straight to `SelectOption[]`.
 */
@Injectable({ providedIn: 'root' })
export class RoleOptionsService {
  private readonly api = inject(API_CLIENT);

  async loadOptions(): Promise<SelectOption[]> {
    const { data, error } = await this.api.GET('/api/v1/staff/roles/', {});
    if (!data) {
      throw new Error(
        error && typeof error === 'object' && 'detail' in error
          ? String((error as { detail?: unknown }).detail)
          : 'Failed to load roles.'
      );
    }
    return data.results.map((role) => ({ value: role.id, label: role.name }));
  }
}

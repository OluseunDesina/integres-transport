import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type TapCredential = components['schemas']['TapCredential'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load your tap-and-go credentials.';
}

/**
 * The passenger's own tap-and-go credentials — docs/specs/4b-tap-and-go.md.
 * Same shape as `BookingStore`: no `TQuery`, since `GET
 * /tap-credentials/mine/` is already scoped to `request.user` server-side.
 * `token` never appears in this list response — only the one-off issuance
 * response the component holds locally exposes it.
 */
@Injectable({ providedIn: 'root' })
export class TapCredentialStore extends ListStore<TapCredential> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: TapCredential[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/tap-credentials/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}

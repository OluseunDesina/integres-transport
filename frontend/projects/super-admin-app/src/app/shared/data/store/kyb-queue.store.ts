import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type BusinessKybQueueItem = components['schemas']['BusinessKybQueue'];

export interface KybQueueQuery {
  search?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load the KYB queue.';
}

@Injectable({ providedIn: 'root' })
export class KybQueueStore extends ListStore<BusinessKybQueueItem, KybQueueQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    query: KybQueueQuery,
    page: Page
  ): Promise<{ items: BusinessKybQueueItem[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/super-admin/kyb-queue/', {
      params: {
        query: { limit: page.limit, offset: page.offset, search: query.search || undefined },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}

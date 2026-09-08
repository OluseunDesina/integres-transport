import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type PassengerIncident = components['schemas']['PassengerIncident'];

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load your reports.';
}

/**
 * The passenger's own incident reports —
 * docs/specs/17-incidents.md slice 3.
 *
 * The second `ListStore` subclass in this app with no `TQuery`, for the
 * same reason `booking.store.ts` (which documents it) has none:
 * server-side scoping to `request.user` is the entire filter, and a
 * passenger's own handful of reports has nothing to narrow by. Contrast
 * client-admin's `IncidentStore`, which takes eleven filters because
 * staff are looking across everybody's.
 *
 * `PassengerIncident` is a **different serializer** from the staff
 * `Incident`, not a subset of one — it carries no assignee, no
 * resolution notes and no activity trail, because staff discussion of a
 * safety report is not passenger-facing (the spec's visibility rule).
 * There is deliberately no `findById` here either: `/incidents/mine/`
 * already returns the whole reduced record, so there is nothing a
 * detail screen could add.
 */
@Injectable({ providedIn: 'root' })
export class IncidentReportStore extends ListStore<PassengerIncident> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    super({}, 25);
  }

  protected override async fetchPage(
    _query: Record<string, never>,
    page: Page
  ): Promise<{ items: PassengerIncident[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/incidents/mine/', {
      params: { query: { limit: page.limit, offset: page.offset } },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }
}

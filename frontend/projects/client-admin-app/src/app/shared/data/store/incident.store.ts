import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { ListStore, type Page } from '@shared-data';

export type Incident = components['schemas']['Incident'];
export type IncidentDetail = components['schemas']['IncidentDetail'];
export type IncidentActivity = components['schemas']['IncidentActivity'];
export type AssignableUser = components['schemas']['AssignableUser'];

export interface IncidentQuery {
  business?: string;
  route?: string;
  trip?: string;
  vehicle?: string;
  driver?: string;
  assigned_to?: string;
  status?: string;
  severity?: string;
  category?: string;
  source?: string;
  /** "Still someone's problem" — open, acknowledged or investigating.
   * The server reads `apps.incidents.models.OPEN_STATUSES`, the same
   * constant its dashboard count uses, so the queue and the stat above
   * it cannot disagree about what open means. */
  open_only?: boolean;
  date_from?: string;
  date_to?: string;
  search?: string;
}

function toErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return 'Failed to load incidents.';
}

/**
 * The incident queue — spec 17 slice 2.
 *
 * ## Why this does not use `findByIdPaged`
 *
 * The standing rule is that a detail or edit screen resolves its record
 * through `ListStore.findByIdPaged`. That rule exists because no domain
 * had a single-record endpoint: the seven screens that adopted it page
 * up to fifty times to find one row.
 *
 * `GET /incidents/{id}/` exists, and it is the **only** source of the
 * activity trail — no list response carries `activities`. So `findDetail`
 * calls it directly: one request instead of up to fifty, and the only
 * way to get the data the detail screen is for. `findByIdPaged` remains
 * the rule for domains without a detail endpoint.
 */
@Injectable({ providedIn: 'root' })
export class IncidentStore extends ListStore<Incident, IncidentQuery> {
  private readonly api = inject(API_CLIENT);

  constructor() {
    // `open_only` is seeded here *and* rendered as a removable chip by
    // the list screen. A queue whose default is "everything ever
    // reported" becomes unusable within a month of real use, but a
    // narrowing nobody can see is the bug this codebase has recorded
    // against the KYB queue and against "Business not found".
    super({ open_only: true }, 25);
  }

  protected override async fetchPage(
    query: IncidentQuery,
    page: Page
  ): Promise<{ items: Incident[]; total: number }> {
    const { data, error } = await this.api.GET('/api/v1/incidents/', {
      params: {
        query: {
          limit: page.limit,
          offset: page.offset,
          business: query.business,
          route: query.route,
          trip: query.trip,
          vehicle: query.vehicle,
          driver: query.driver,
          assigned_to: query.assigned_to,
          status: query.status,
          severity: query.severity,
          category: query.category,
          source: query.source,
          open_only: query.open_only ? 'true' : undefined,
          date_from: query.date_from,
          date_to: query.date_to,
          search: query.search,
        },
      },
    });
    if (!data) {
      throw new Error(toErrorMessage(error));
    }
    return { items: data.results, total: data.count };
  }

  /** One incident with its activity trail. `null` when it does not exist
   * or belongs to another Client — the API answers 404 for both, and the
   * screen renders one "not found" either way rather than leaking which
   * it was. */
  async findDetail(id: string): Promise<IncidentDetail | null> {
    const { data } = await this.api.GET('/api/v1/incidents/{id}/', {
      params: { path: { id } },
    });
    return data ?? null;
  }

  /** Who an incident can be handed to.
   *
   * Not `GET /staff/`, which is gated on `staff.manage` — an Owner-only
   * codename. Every holder of `incidents.manage` can read this one, which
   * is the point: Manager and Staff are who triage incidents. */
  async assignableUsers(): Promise<AssignableUser[]> {
    const { data } = await this.api.GET('/api/v1/incidents/assignable-users/', {
      params: { query: { limit: 100, offset: 0 } },
    });
    return data?.results ?? [];
  }
}

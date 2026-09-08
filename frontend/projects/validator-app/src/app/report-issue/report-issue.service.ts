import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import type { Trip } from '../shared/open-trips.service';

export type Incident = components['schemas']['Incident'];
type Category = components['schemas']['CategoryEnum'];
type Severity = components['schemas']['SeverityEnum'];

export interface ReportIssueRequest {
  trip: Trip;
  category: Category;
  title: string;
  severity: Severity;
  description: string;
  deviceReference: string;
}

export type ReportIssueResult =
  | { ok: true; data: Incident }
  | { ok: false; status: number; message: string };

function toErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

/**
 * A conductor files an incident against the trip they are working —
 * docs/specs/17-incidents.md slice 3.
 *
 * ## Why the operator endpoint, not `/incidents/report/`
 *
 * `POST /incidents/` is gated on `incidents.manage`, which the **Staff**
 * preset holds (slice 1 granted both incident codenames to all three
 * presets, precisely because frontline staff are who notices a broken
 * reader). A conductor is an operator, so the incident lands with
 * `source=operator` and the queue shows it for what it is. The
 * passenger endpoint would have filed the same fault as a passenger
 * report and dropped `severity` on the way, leaving a conductor unable
 * to say that something is urgent.
 *
 * ## What is attached automatically, and what is not
 *
 * The selected `Trip` already names its business, route and vehicle, so
 * all three are sent without asking — a fault report that does not say
 * which bus it is about is a fault report nobody can act on.
 *
 * **`driver` is deliberately omitted**, although `Trip` carries it and
 * `POST /incidents/` accepts it. Attaching a named person to every
 * hardware fault turns "this reader is dead" into a record about
 * whoever happened to be driving. An operator can add that in the queue
 * when it is actually relevant; the conductor is reporting a fault, not
 * filing about a colleague.
 */
@Injectable({ providedIn: 'root' })
export class ReportIssueService {
  private readonly api = inject(API_CLIENT);

  async report(request: ReportIssueRequest): Promise<ReportIssueResult> {
    const { trip } = request;
    const { data, error, response } = await this.api.POST('/api/v1/incidents/', {
      // A declared header *parameter* on this operation, so it travels
      // in `params.header`. A fresh key per submit, matching
      // `RecordTapService.recordTap`: each report is its own deliberate
      // action rather than a form resubmitted after a timeout.
      params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: {
        business: trip.business,
        title: request.title,
        category: request.category,
        severity: request.severity,
        description: request.description,
        trip: trip.id,
        route: trip.route.id,
        ...(trip.vehicle ? { vehicle: trip.vehicle.id } : {}),
        ...(request.deviceReference ? { device_reference: request.deviceReference } : {}),
      },
    });

    if (!data) {
      return {
        ok: false,
        status: response.status,
        message: toErrorMessage(error, 'Could not file the report. Try again.'),
      };
    }
    return { ok: true, data };
  }
}

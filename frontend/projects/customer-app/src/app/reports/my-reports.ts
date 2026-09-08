import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Paginator,
  StatusPill,
  Table,
  summaryLine,
} from '@shared-ui';
import type { StatusPillTone } from '@shared-ui';

import {
  IncidentReportStore,
  type PassengerIncident,
} from '../shared/data/store/incident-report.store';
import { categoryLabel, statusLabel, statusTone } from '../shared/incident-labels';

/**
 * The passenger's own reports (`GET /incidents/mine/`) —
 * docs/specs/17-incidents.md slice 3.
 *
 * List-only, the same posture `my-bookings` and `journeys` take. There
 * is no detail screen because there is nothing one could show: the
 * reduced serializer returns the whole record already, and it withholds
 * the assignee, the resolution notes and the activity trail on purpose
 * — staff discussion of a safety report is not passenger-facing. There
 * is no row action either; a filed report is not something the person
 * who filed it can change.
 *
 * What this screen is actually for is the answer to "did anything
 * happen to what I sent you", which before this slice was unanswerable
 * from inside the product.
 */
@Component({
  selector: 'app-my-reports',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Alert, Button, EmptyState, PageHeader, Paginator, StatusPill, Table],
  templateUrl: './my-reports.html',
})
export class MyReports implements OnInit {
  protected readonly store = inject(IncidentReportStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Set from `?filed=<reference>`, which `report-issue` navigates with
   * after a successful submit.
   *
   * Carried in the URL rather than in router state so that the
   * confirmation survives a reload — a passenger on a flaky connection
   * who refreshes the moment the page appears should still be told
   * their report went through, and a reference they can quote is the
   * only thing this screen gives them to quote.
   */
  protected readonly filedReference = signal<string | null>(null);

  ngOnInit(): void {
    this.filedReference.set(this.route.snapshot.queryParamMap.get('filed'));
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected statusLabelFor(incident: PassengerIncident): string {
    return statusLabel(incident.status);
  }

  protected statusToneFor(incident: PassengerIncident): StatusPillTone {
    return statusTone(incident.status);
  }

  /**
   * The **category**, not `incident.title`.
   *
   * This form never asks for a title, so the backend derives one —
   * `passenger_report_title` returns "Passenger report: Hardware". That
   * is right where it was written for, the operator queue, whose first
   * column would otherwise be a list of blanks. On *this* screen it is
   * noise twice over: "Passenger report" is the only kind of report a
   * passenger can see here, and the rest is the category, which the row
   * already carried in its own column. The visual pass photographed six
   * rows reading "Passenger report: Hardware" beside a Category column
   * reading "Hardware".
   *
   * A staff-edited title is not shown, and that is fine: the title is a
   * queue label, and what the reporter wants back is their own words —
   * `descriptionFor` below.
   */
  protected categoryFor(incident: PassengerIncident): string {
    return categoryLabel(incident.category);
  }

  /** What the passenger actually wrote, which is the most useful thing
   * in the row and was not shown at all before. Clamped in the cell
   * rather than truncated here, so nothing is lost to a copy-paste. */
  protected descriptionFor(incident: PassengerIncident): string {
    return incident.description || '—';
  }

  /** The columns hidden below `md`, re-flowed under the category. */
  protected summaryFor(incident: PassengerIncident): string {
    return summaryLine([
      incident.reference,
      new Date(incident.created_at).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    ]);
  }

  protected async reportIssue(): Promise<void> {
    await this.router.navigate(['/report-issue']);
  }
}

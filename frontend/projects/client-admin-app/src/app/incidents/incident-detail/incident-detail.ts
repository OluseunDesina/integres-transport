import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { HasPermissionDirective } from '@auth';
import {
  Alert,
  Button,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
} from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import {
  IncidentStore,
  type AssignableUser,
  type IncidentActivity,
  type IncidentDetail as Detail,
} from '../../shared/data/store/incident.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import {
  categoryLabel,
  nextStatuses,
  severityLabel,
  severityTone,
  sourceLabel,
  statusLabel,
  statusTone,
  transitionLabel,
} from '../../shared/incident-labels';

/** What every unknown relation renders. Never a blank cell and never a
 * zero — a passenger reporting a broken reader on a platform may know
 * none of them, and "not recorded" is a different fact from "none". */
const NOT_RECORDED = 'Not recorded';

/**
 * One incident, its context and its history — spec 17 slice 2.
 *
 * Reads `GET /incidents/{id}/`, which is the only source of the activity
 * trail; no list response carries `activities`. That is also why this
 * screen does not use `ListStore.findByIdPaged` — see `IncidentStore`.
 *
 * Every lifecycle control sits behind `incidents.manage`. A
 * `incidents.view`-only user still sees the whole record and its
 * history, which is the point of splitting the two codenames.
 */
@Component({
  selector: 'app-incident-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    PageHeader,
    Select,
    Skeleton,
    StatusPill,
    Textarea,
  ],
  templateUrl: './incident-detail.html',
})
export class IncidentDetail {
  private readonly store = inject(IncidentStore);
  private readonly api = inject(API_CLIENT);
  private readonly activatedRoute = inject(ActivatedRoute);

  protected readonly notRecorded = NOT_RECORDED;
  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;
  protected readonly severityLabel = severityLabel;
  protected readonly severityTone = severityTone;
  protected readonly categoryLabel = categoryLabel;
  protected readonly sourceLabel = sourceLabel;

  protected readonly incident = signal<Detail | null>(null);
  protected readonly activities = signal<IncidentActivity[]>([]);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly working = signal(false);

  protected readonly assignees = signal<AssignableUser[]>([]);
  protected readonly transitionTo = signal('');
  protected readonly transitionNote = signal('');
  protected readonly note = signal('');

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.activatedRoute.snapshot.paramMap.get('id') ?? '';
    const detail = await this.store.findDetail(id);
    this.loading.set(false);
    if (!detail) {
      this.notFound.set(true);
      return;
    }
    this.incident.set(detail);
    this.activities.set(detail.activities);
    // Best-effort: a `incidents.view`-only reader gets an empty list and
    // no assignee control, rather than an error they cannot act on.
    this.assignees.set(await this.store.assignableUsers());
  }

  protected readonly transitionOptions = computed<SelectOption[]>(() => {
    const current = this.incident()?.status;
    if (!current) {
      return [];
    }
    return [
      { value: '', label: 'Choose an action…' },
      ...nextStatuses(current).map((next) => ({
        value: next,
        label: transitionLabel(current, next),
      })),
    ];
  });

  protected readonly assigneeOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'Unassigned' },
    ...this.assignees().map((user) => ({
      value: user.id,
      label: user.email,
    })),
  ]);

  protected readonly currentAssignee = computed(() => this.incident()?.assigned_to ?? '');

  protected activityLabel(activity: IncidentActivity): string {
    if (activity.kind === 'status_change') {
      return `${statusLabel(activity.from_status)} → ${statusLabel(activity.to_status)}`;
    }
    return { assignment: 'Assignment', severity_change: 'Severity changed', note: 'Note' }[
      activity.kind
    ];
  }

  private apply(detail: Detail): void {
    this.incident.set(detail);
    this.activities.set(detail.activities);
  }

  protected async onTransition(): Promise<void> {
    const incident = this.incident();
    const to = this.transitionTo();
    if (!incident || !to) {
      return;
    }
    this.working.set(true);
    this.actionError.set(null);
    const { data, error } = await this.api.POST('/api/v1/incidents/{id}/transition/', {
      params: { path: { id: incident.id } },
      body: { status: to as Detail['status'], note: this.transitionNote() || undefined },
    });
    this.working.set(false);
    if (!data) {
      // The backend is authoritative on the lifecycle and answers 409 on
      // an illegal move; this menu is a convenience, so its message is
      // what the operator sees.
      this.actionError.set(extractFirstErrorMessage(error, 'Could not update this incident.'));
      return;
    }
    this.transitionTo.set('');
    this.transitionNote.set('');
    this.apply(data);
  }

  protected async onAssign(userId: string): Promise<void> {
    const incident = this.incident();
    if (!incident) {
      return;
    }
    this.working.set(true);
    this.actionError.set(null);
    const { data, error } = await this.api.PATCH('/api/v1/incidents/{id}/', {
      params: { path: { id: incident.id } },
      body: { assigned_to: userId || null },
    });
    this.working.set(false);
    if (!data) {
      this.actionError.set(extractFirstErrorMessage(error, 'Could not assign this incident.'));
      return;
    }
    this.apply(data);
  }

  protected async onAddNote(): Promise<void> {
    const incident = this.incident();
    const note = this.note().trim();
    if (!incident || !note) {
      return;
    }
    this.working.set(true);
    this.actionError.set(null);
    const { error } = await this.api.POST('/api/v1/incidents/{id}/notes/', {
      params: { path: { id: incident.id } },
      body: { note },
    });
    this.working.set(false);
    if (error) {
      this.actionError.set(extractFirstErrorMessage(error, 'Could not add this note.'));
      return;
    }
    this.note.set('');
    const refreshed = await this.store.findDetail(incident.id);
    if (refreshed) {
      this.apply(refreshed);
    }
  }
}

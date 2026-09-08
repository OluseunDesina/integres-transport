import { Dialog } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, TemplateRef, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  PageHeader,
  Skeleton,
  StatusPill,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult } from '@shared-ui';

import { RouteStore, type RouteDetail as Detail } from '../../shared/data/store/route.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import {
  nextStatuses,
  statusLabel,
  statusTone,
  takesOutOfService,
  transitionLabel,
  type RouteStatus,
} from '../../shared/route-labels';

const NOT_SET = '—';

/**
 * One route, its network/fare context and its status actions —
 * docs/specs/19-route-lifecycle.md slice 2.
 *
 * Reads `GET /routes/{id}/` directly, the real single-record GET added
 * in slice 1 — no `ListStore.findByIdPaged`, per frontend-patterns.md's
 * note on checking for one before reaching for the paged lookup.
 */
@Component({
  selector: 'app-route-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    PageHeader,
    Skeleton,
    StatusPill,
  ],
  templateUrl: './route-detail.html',
})
export class RouteDetail {
  private readonly store = inject(RouteStore);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly permissions = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);

  protected readonly notSet = NOT_SET;
  protected readonly statusLabel = statusLabel;
  protected readonly statusTone = statusTone;
  protected readonly canManage = computed(() => this.permissions.has('network.manage'));

  protected readonly route = signal<Detail | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly working = signal(false);

  private readonly statusConfirmBody = viewChild.required<TemplateRef<unknown>>(
    'statusConfirmBody'
  );
  private readonly duplicateConfirmBody =
    viewChild.required<TemplateRef<unknown>>('duplicateConfirmBody');

  protected readonly pendingTarget = signal<RouteStatus | null>(null);
  protected readonly confirmLabel = computed(() => {
    const route = this.route();
    const target = this.pendingTarget();
    return route && target ? transitionLabel(route.status, target) : 'Confirm';
  });
  protected readonly confirmDanger = computed(() => {
    const route = this.route();
    const target = this.pendingTarget();
    return route && target ? takesOutOfService(route.status, target) : false;
  });
  protected readonly confirmDisabled = signal(false);

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
    this.route.set(detail);
  }

  protected readonly transitionTargets = computed<readonly RouteStatus[]>(() => {
    const route = this.route();
    return route ? nextStatuses(route.status) : [];
  });

  protected actionLabel(target: RouteStatus): string {
    const route = this.route();
    return route ? transitionLabel(route.status, target) : '';
  }

  protected transitionDanger(target: RouteStatus): boolean {
    const route = this.route();
    return route ? takesOutOfService(route.status, target) : false;
  }

  protected confirmStatusChange(target: RouteStatus): void {
    const route = this.route();
    if (!route) {
      return;
    }
    this.pendingTarget.set(target);
    this.actionError.set(null);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${transitionLabel(route.status, target)} ${route.name}?`,
        bodyTemplate: this.statusConfirmBody(),
        confirmLabel: this.confirmLabel,
        danger: this.confirmDanger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitStatusChange(route, target),
      },
    });

    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.load());
      }
    });
  }

  private async submitStatusChange(
    route: Detail,
    target: RouteStatus
  ): Promise<ConfirmDialogResult> {
    const { error } = await this.api.POST('/api/v1/routes/{id}/status/', {
      params: { path: { id: route.id } },
      body: { status: target },
    });

    // The backend is authoritative on the guards (a currently-effective
    // fare and two stops to activate, no future trips to archive) and
    // answers 409/400 naming exactly what refused the move.
    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(
            error,
            `Could not ${transitionLabel(route.status, target).toLowerCase()} ${route.name}.`
          ),
        }
      : { ok: true };
  }

  protected confirmDuplicate(): void {
    const route = this.route();
    if (!route) {
      return;
    }
    this.actionError.set(null);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Duplicate ${route.name}?`,
        bodyTemplate: this.duplicateConfirmBody(),
        confirmLabel: signal('Duplicate'),
        danger: signal(false),
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitDuplicate(route),
      },
    });

    ref.closed.subscribe((confirmed) => {
      const copy = this.duplicatedRoute();
      if (confirmed && copy) {
        setTimeout(() => void this.router.navigate(['/routes', copy.id, 'edit']));
      }
    });
  }

  private readonly duplicatedRoute = signal<{ id: string } | null>(null);

  private async submitDuplicate(route: Detail): Promise<ConfirmDialogResult> {
    const { data, error } = await this.api.POST('/api/v1/routes/{id}/duplicate/', {
      params: { path: { id: route.id } },
    });
    if (!data) {
      return {
        ok: false,
        error: extractFirstErrorMessage(error, `Could not duplicate ${route.name}.`),
      };
    }
    this.duplicatedRoute.set(data);
    return { ok: true };
  }
}

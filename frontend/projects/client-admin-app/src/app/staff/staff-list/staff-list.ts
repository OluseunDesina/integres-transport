import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore, HasPermissionDirective, PermissionsService } from '@auth';
import {
  ActionMenu,
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  DensityToggle,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Select,
  Skeleton,
  StatusPill,
  Table,
} from '@shared-ui';
import type {
  ActionMenuItem,
  ConfirmDialogData,
  ConfirmDialogResult,
  Density,
  SelectOption,
} from '@shared-ui';

import { StaffStore, type Staff } from '../../shared/data/store/staff.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { ListFilters } from '../../shared/list-filters';
import { RoleOptionsService } from '../role-options.service';

function extractDetail(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
  }
  return fallback;
}

@Component({
  selector: 'app-staff-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    HasPermissionDirective,
    ActionMenu,
    Alert,
    Button,
    DensityToggle,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    Select,
    Skeleton,
    StatusPill,
    Table,
  ],
  templateUrl: './staff-list.html',
})
export class StaffList implements OnInit {
  protected readonly store = inject(StaffStore);
  private readonly api = inject(API_CLIENT);
  private readonly roleOptionsService = inject(RoleOptionsService);
  private readonly router = inject(Router);
  private readonly dialog = inject(Dialog);
  private readonly densityStore = inject(TableDensityStore);
  private readonly permissions = inject(PermissionsService);
  private readonly authStore = inject(AuthStore);

  protected readonly roleOptions = signal<SelectOption[]>([]);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly canManage = computed(() => this.permissions.has('staff.manage'));

  protected readonly filters = new ListFilters();
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  private readonly roleBody = viewChild.required<TemplateRef<unknown>>('roleBody');
  private readonly activeBody = viewChild.required<TemplateRef<unknown>>('activeBody');

  /** The member the open dialog is about. */
  protected readonly selected = signal<Staff | null>(null);
  /** The role the role dialog will submit — seeded from the member's
   * current one, so confirming without touching it is a no-op. */
  protected readonly pendingRoleId = signal('');

  protected readonly roleConfirmLabel = computed(() => 'Change role');
  protected readonly roleDanger = computed(() => false);
  /** A role change to the role they already hold is not a change. */
  protected readonly roleConfirmDisabled = computed(
    () => !this.pendingRoleId() || this.pendingRoleId() === this.selected()?.role.id
  );

  protected readonly activeConfirmLabel = computed(() =>
    this.selected()?.is_active ? 'Deactivate' : 'Activate'
  );
  protected readonly activeDanger = computed(() => !!this.selected()?.is_active);
  protected readonly activeConfirmDisabled = signal(false);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.store.getAll(), this.loadRoleOptions()]);
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
  }

  protected goToInvite(): void {
    void this.router.navigate(['/staff/invite']);
  }

  protected applyFilters(): void {
    void this.store.updateQuery({ ...this.filters.query() });
  }

  protected onSearchChange(value: string): void {
    this.filters.setSearch(value);
    this.applyFilters();
  }

  protected onChipRemoved(chipId: string): void {
    this.filters.remove(chipId);
    this.applyFilters();
  }

  protected onFiltersCleared(): void {
    this.filters.clear();
    this.applyFilters();
  }

  protected onPendingRoleChange(roleId: string): void {
    this.pendingRoleId.set(roleId);
  }

  /**
   * Row actions.
   *
   * **A member cannot deactivate or re-role themselves from here.** The
   * backend already rejects it (`StaffUpdateSerializer`), but offering an
   * action that always fails is worse than not offering it — and locking
   * yourself out of your own console is the specific accident worth
   * making impossible to start.
   */
  protected menuItems(member: Staff): ActionMenuItem[] {
    if (!this.canManage()) {
      return [];
    }
    const isSelf = member.id === this.authStore.user()?.id;
    return [
      {
        id: 'role',
        label: 'Change role',
        icon: 'identification',
        disabled: isSelf,
      },
      member.is_active
        ? {
            id: 'deactivate',
            label: 'Deactivate',
            icon: 'x-mark',
            danger: true,
            disabled: isSelf,
          }
        : {
            id: 'activate',
            label: 'Activate',
            icon: 'check',
            disabled: isSelf,
          },
    ];
  }

  protected onMenuSelected(member: Staff, id: string): void {
    if (id === 'role') {
      this.confirmRoleChange(member);
      return;
    }
    this.confirmActiveChange(member);
  }

  /**
   * Replaces the inline role `ui-select` this row used to carry, which
   * changed someone's permissions the moment it changed — no
   * confirmation, no undo, and adjacent to a bare checkbox doing the
   * same for their access. `docs/specs/14`'s one behavioural change,
   * applied to a screen the spec never named because it is worse than
   * the six it did.
   *
   * The dialog body is a role select, the same shape `trip-list`'s
   * status change already uses.
   */
  private confirmRoleChange(member: Staff): void {
    this.selected.set(member);
    this.pendingRoleId.set(member.role.id);
    this.errorMessage.set(null);

    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Change role for ${member.email}?`,
        bodyTemplate: this.roleBody(),
        confirmLabel: this.roleConfirmLabel,
        danger: this.roleDanger,
        confirmDisabled: this.roleConfirmDisabled,
        onConfirm: () => this.submit(member, { role: this.pendingRoleId() }),
      },
    });

    // Deferred one tick — see trip-list.ts's identical reasoning.
    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  /** Replaces the bare in-row `<input type="checkbox">`. */
  private confirmActiveChange(member: Staff): void {
    this.selected.set(member);
    this.errorMessage.set(null);

    const next = !member.is_active;
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `${next ? 'Activate' : 'Deactivate'} ${member.email}?`,
        bodyTemplate: this.activeBody(),
        confirmLabel: this.activeConfirmLabel,
        danger: this.activeDanger,
        confirmDisabled: this.activeConfirmDisabled,
        onConfirm: () => this.submit(member, { is_active: next }),
      },
    });

    ref.closed.subscribe((confirmed) => {
      if (confirmed) {
        setTimeout(() => void this.store.getAll());
      }
    });
  }

  private async submit(
    member: Staff,
    body: { role?: string; is_active?: boolean }
  ): Promise<ConfirmDialogResult> {
    const { data, error } = await this.api.PATCH('/api/v1/staff/{user_id}/', {
      params: { path: { user_id: member.id } },
      body,
    });

    return data
      ? { ok: true }
      : {
          ok: false,
          error: extractDetail(error, 'Could not update this team member.'),
        };
  }

  private async loadRoleOptions(): Promise<void> {
    try {
      this.roleOptions.set(await this.roleOptionsService.loadOptions());
    } catch {
      // The role select just renders with no options if this fails —
      // it's secondary to the staff list itself loading, so it doesn't
      // share the page-level error signal.
    }
  }
}

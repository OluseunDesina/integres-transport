import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { API_CLIENT } from '@api-client';
import { AuthStore, HasPermissionDirective } from '@auth';
import { Alert, Button, EmptyState, Paginator, Select, Table } from '@shared-ui';
import type { SelectOption } from '@shared-ui';

import { StaffStore, type Staff } from '../../shared/data/store/staff.store';
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
  imports: [FormsModule, HasPermissionDirective, Alert, Button, EmptyState, Paginator, Select, Table],
  templateUrl: './staff-list.html',
})
export class StaffList implements OnInit {
  protected readonly store = inject(StaffStore);
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);
  private readonly roleOptionsService = inject(RoleOptionsService);
  private readonly router = inject(Router);

  protected readonly roleOptions = signal<SelectOption[]>([]);
  protected readonly errorMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.store.getAll(), this.loadRoleOptions()]);
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async onRoleChange(member: Staff, roleId: string): Promise<void> {
    await this.patchMember(member, { role: roleId });
  }

  protected async onActiveChange(member: Staff, isActive: boolean): Promise<void> {
    await this.patchMember(member, { is_active: isActive });
  }

  protected goToInvite(): void {
    void this.router.navigate(['/staff/invite']);
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

  private async patchMember(
    member: Staff,
    body: { role?: string; is_active?: boolean }
  ): Promise<void> {
    this.errorMessage.set(null);

    const { data, error } = await this.api.PATCH('/api/v1/staff/{user_id}/', {
      params: { path: { user_id: member.id } },
      body,
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    if (!data) {
      this.errorMessage.set(extractDetail(error, 'Could not update this team member.'));
      return;
    }

    await this.store.getAll();
  }
}

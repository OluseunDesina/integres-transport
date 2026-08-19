import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HasPermissionDirective } from '@auth';
import { Alert, Button, EmptyState, Paginator, StatusPill, Table } from '@shared-ui';

import { BusinessStore } from '../../shared/data/store/business.store';
import { documentReviewStatusTone } from '../../shared/status-tone';

@Component({
  selector: 'app-business-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HasPermissionDirective,
    Alert,
    Button,
    EmptyState,
    Paginator,
    StatusPill,
    Table,
  ],
  templateUrl: './business-list.html',
})
export class BusinessList implements OnInit {
  protected readonly store = inject(BusinessStore);
  protected readonly kybStatusTone = documentReviewStatusTone;
  private readonly router = inject(Router);

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected async goToNewBusiness(): Promise<void> {
    await this.router.navigate(['/businesses/new']);
  }
}

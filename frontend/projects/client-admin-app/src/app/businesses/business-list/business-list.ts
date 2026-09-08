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
import { Router } from '@angular/router';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  ActionMenu,
  Alert,
  Button,
  DensityToggle,
  DrawerService,
  EmptyState,
  FilterBar,
  PageHeader,
  Paginator,
  Skeleton,
  StatusPill,
  Table,
} from '@shared-ui';
import type { ActionMenuItem, Density } from '@shared-ui';

import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { TableDensityStore } from '../../shared/data/store/table-density.store';
import { ListFilters } from '../../shared/list-filters';
import { documentReviewStatusTone } from '../../shared/status-tone';

@Component({
  selector: 'app-business-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HasPermissionDirective,
    ActionMenu,
    Alert,
    Button,
    DensityToggle,
    EmptyState,
    FilterBar,
    PageHeader,
    Paginator,
    Skeleton,
    StatusPill,
    Table,
  ],
  templateUrl: './business-list.html',
})
export class BusinessList implements OnInit {
  protected readonly store = inject(BusinessStore);
  protected readonly kybStatusTone = documentReviewStatusTone;
  private readonly router = inject(Router);
  private readonly densityStore = inject(TableDensityStore);
  private readonly permissions = inject(PermissionsService);

  protected readonly canManage = computed(() => this.permissions.has('business.manage'));
  private readonly drawers = inject(DrawerService);
  private readonly detailBody = viewChild.required<TemplateRef<unknown>>('detailBody');
  protected readonly selected = signal<Business | null>(null);
  protected readonly filters = new ListFilters();
  protected readonly skeletonRows = [0, 1, 2, 3, 4];

  protected readonly density = this.densityStore.density;
  protected readonly cellClass = computed(() =>
    this.density() === 'compact' ? 'py-1' : 'py-3'
  );
  protected readonly densityStyle = computed(() =>
    this.density() === 'compact' ? '--ui-control-height: 1.75rem' : null
  );

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected onDensityChange(next: Density): void {
    this.densityStore.set(next);
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

  protected async goToNewBusiness(): Promise<void> {
    await this.router.navigate(['/businesses/new']);
  }

  /** KYB documents are a separate route rather than a drawer: the screen
   * uploads files and shows a review decision, which is more than a
   * panel's worth and is bookmarkable.
   *
   * "View details" is unconditional, and is why this menu now renders
   * for a viewer who cannot manage anything: currency, timezone and
   * booking mode are hidden below `lg`, and the drawer is where they
   * are recoverable. A read-only user who could not open it would
   * simply lose those three values on a laptop.
   */
  protected menuItems(): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      { id: 'details', label: 'View details', icon: 'building-office' },
    ];
    if (this.canManage()) {
      items.push({ id: 'edit', label: 'Edit', icon: 'swatch' });
      items.push({ id: 'kyb', label: 'KYB documents', icon: 'document-check' });
    }
    return items;
  }

  protected onMenuSelected(business: Business, id: string): void {
    if (id === 'details') {
      this.selected.set(business);
      this.drawers.open({
        title: business.name,
        description: 'How this business is configured.',
        bodyTemplate: this.detailBody(),
      });
      return;
    }
    void this.router.navigate(['/businesses', business.id, id === 'kyb' ? 'kyb' : 'edit']);
  }
}

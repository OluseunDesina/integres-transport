import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { Page } from '@shared-data';

import { Button } from './button';

@Component({
  selector: 'ui-paginator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [Button],
  template: `
    <div
      style="font-size: var(--ui-text-body)"
      class="flex items-center justify-between gap-4 text-muted"
    >
      <span>{{ rangeLabel() }}</span>
      <div class="flex gap-2">
        <ui-button
          variant="secondary"
          [disabled]="!hasPrevious()"
          (pressed)="pageChange.emit(previousOffset())"
        >
          Previous
        </ui-button>
        <ui-button variant="secondary" [disabled]="!hasNext()" (pressed)="pageChange.emit(nextOffset())">
          Next
        </ui-button>
      </div>
    </div>
  `,
})
export class Paginator {
  readonly total = input.required<number>();
  readonly page = input.required<Page>();
  readonly pageChange = output<number>();

  protected readonly hasPrevious = computed(() => this.page().offset > 0);
  protected readonly hasNext = computed(() => this.page().offset + this.page().limit < this.total());
  protected readonly previousOffset = computed(() =>
    Math.max(0, this.page().offset - this.page().limit)
  );
  protected readonly nextOffset = computed(() => this.page().offset + this.page().limit);

  protected readonly rangeLabel = computed(() => {
    const total = this.total();
    if (total === 0) {
      return '0 of 0';
    }
    const { offset, limit } = this.page();
    const start = offset + 1;
    const end = Math.min(offset + limit, total);
    return `${start}–${end} of ${total}`;
  });
}

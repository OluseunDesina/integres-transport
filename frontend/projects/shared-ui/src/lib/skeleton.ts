import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type SkeletonVariant = 'text' | 'block' | 'circle';

/**
 * A loading placeholder shaped like the content it stands in for,
 * replacing the bare "Loading…" text every list currently renders.
 *
 * **Deliberately invisible to assistive technology.** The shimmer is
 * decorative: it conveys nothing a screen-reader user can act on, and a
 * table skeleton emits eight of them at once, which would be eight
 * announcements of the same fact. The announcement belongs on the
 * *region* being loaded — the caller sets `aria-busy="true"` there, which
 * is one announcement for one wait, and is why this component takes no
 * `label` input to tempt anyone otherwise.
 *
 * The pulse honours `prefers-reduced-motion` through the global rule in
 * `theme.css`, not through a check here — the animation is a plain
 * Tailwind `animate-pulse`, and that rule flattens every animation in
 * the app to 0.01ms.
 */
@Component({
  selector: 'ui-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div aria-hidden="true" class="flex flex-col gap-2">
      @for (line of lineIndexes(); track line) {
        <div
          class="animate-pulse bg-surface-sunken"
          [class.rounded-full]="variant() === 'circle'"
          [class.rounded-md]="variant() !== 'circle'"
          [style.width]="lineWidth($index)"
          [style.height]="resolvedHeight()"
        ></div>
      }
    </div>
  `,
})
export class Skeleton {
  readonly variant = input<SkeletonVariant>('text');
  /** Number of placeholder lines. Only meaningful for `text`. */
  readonly lines = input(1);
  /** Any CSS length. Defaults per variant; see `resolvedHeight`. */
  readonly height = input<string | null>(null);
  readonly width = input('100%');

  protected readonly lineIndexes = computed(() =>
    Array.from({ length: Math.max(1, this.lines()) }, (_, i) => i),
  );

  protected readonly resolvedHeight = computed(() => {
    const explicit = this.height();
    if (explicit) {
      return explicit;
    }
    switch (this.variant()) {
      case 'circle':
        return this.width();
      case 'block':
        return '8rem';
      default:
        // Matches the line-height of body text at the current surface
        // profile, so a text skeleton occupies exactly the space the
        // real text will and the layout does not jump when it arrives.
        return 'calc(var(--ui-text-body) * 1.5)';
    }
  });

  /**
   * The last line of a multi-line text skeleton is short, because real
   * paragraphs end mid-line. A stack of identical full-width bars reads
   * as a table, not as prose.
   */
  protected lineWidth(index: number): string {
    const total = Math.max(1, this.lines());
    if (this.variant() !== 'text' || total === 1 || index < total - 1) {
      return this.width();
    }
    return '60%';
  }
}

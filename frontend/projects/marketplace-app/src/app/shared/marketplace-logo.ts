import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The marketplace's own wordmark — docs/specs/24-marketplace-redesign.md.
 * Not `@layout`'s `BrandMark`: that resolves a tenant's white-label
 * branding and falls back to "Integra Travel" in `text-strong`, which is
 * both the wrong name here and illegible on the navy header. The
 * marketplace has no tenant to resolve.
 *
 * `tone="light"` is for navy backgrounds, `tone="dark"` for white ones.
 */
@Component({
  selector: 'app-marketplace-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center gap-2' },
  template: `
    <span
      aria-hidden="true"
      class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-mk-accent text-sm font-bold text-mk-navy-950"
    >
      T
    </span>
    <span
      class="text-lg font-bold tracking-tight"
      [class.text-white]="tone() === 'light'"
      [class.text-strong]="tone() === 'dark'"
    >
      TransitOS
    </span>
  `,
})
export class MarketplaceLogo {
  readonly tone = input<'light' | 'dark'>('light');
}

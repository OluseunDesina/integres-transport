import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/**
 * Note the two different "text on a solid fill" tokens in the template,
 * because the split is load-bearing.
 *
 * `text-on-primary` is used for the primary variant, whose fill is
 * whatever colour a white-labelled tenant chose. `BrandThemeService`
 * swaps that token to a dark ink when white would fail WCAG AA against
 * their brand.
 *
 * `text-on-solid` is fixed white, and is only safe on fills we control
 * and have measured — danger, success.
 *
 * Getting this wrong is not theoretical: an earlier version mapped both
 * to `on-solid` and shipped white-on-#FFE066 buttons. It was caught by
 * applying a real pale tenant colour in a browser, and by nothing else —
 * the token flipped correctly the whole time, it just reached no text.
 *
 * The size comes from `--ui-text-body`, not a `text-*` class, so the
 * label follows the app's surface profile — 14px in the three consoles,
 * 16px in `customer-app`. See `theme.css`'s surface-profile block.
 */
@Component({
  selector: 'ui-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      [type]="type()"
      [disabled]="isDisabled()"
      [attr.aria-pressed]="ariaPressed()"
      [attr.aria-label]="ariaLabel()"
      (click)="pressed.emit($event)"
      style="font-size: var(--ui-text-body)"
      class="inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed"
      [class.bg-primary]="variant() === 'primary' && !isDisabled()"
      [class.hover:bg-primary-hover]="variant() === 'primary' && !isDisabled()"
      [class.border]="variant() === 'secondary' && !isDisabled()"
      [class.border-control]="variant() === 'secondary' && !isDisabled()"
      [class.hover:bg-surface-muted]="variant() === 'secondary' && !isDisabled()"
      [class.bg-danger]="variant() === 'danger' && !isDisabled()"
      [class.hover:bg-danger-hover]="variant() === 'danger' && !isDisabled()"
      [class.text-on-primary]="variant() === 'primary' && !isDisabled()"
      [class.text-on-solid]="variant() === 'danger' && !isDisabled()"
      [class.bg-surface-sunken]="isDisabled()"
      [class.text-default]="(variant() === 'secondary' && !isDisabled()) || isDisabled()"
    >
      @if (loading()) {
        <span
          class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        ></span>
      }
      <ng-content />
    </button>
  `,
})
export class Button {
  readonly type = input<'button' | 'submit'>('button');
  readonly variant = input<'primary' | 'secondary' | 'danger'>('primary');
  readonly disabled = input(false);
  readonly loading = input(false);
  // `null` (not `false`) omits the attribute entirely — most consumers
  // aren't a toggle and shouldn't get `aria-pressed="false"` on an
  // ordinary action button. Named `ariaPressed`, not `pressed` — that
  // name is already the click `output()` below; host-level `[attr.*]`
  // bindings on `ui-button` (`host: { class: 'contents' }`) land on the
  // wrapper element, never the real inner `<button>`, so a toggle
  // consumer needs this passthrough rather than binding
  // `[attr.aria-pressed]` on `<ui-button>` itself — caught live wiring
  // up `validator-app`'s board/alight toggle (docs/specs/4b-tap-and-go.md).
  readonly ariaPressed = input<boolean | null>(null);
  // Same passthrough reasoning as `ariaPressed` above: a host-level
  // `[attr.aria-label]` on `<ui-button>` lands on the `display: contents`
  // wrapper and never reaches the real `<button>`, so it is silently
  // dropped from the accessibility tree.
  //
  // Needed wherever one screen repeats a short generic label — the KYB
  // screen has six "Upload" buttons, one per document slot, which a
  // screen reader would otherwise announce identically with no way to
  // tell which document each belongs to.
  readonly ariaLabel = input<string | null>(null);
  readonly pressed = output<MouseEvent>();

  // A settled `opacity-50` disabled treatment blends any base text color
  // toward this light background at roughly 2.5–3:1 — well under WCAG
  // AA's 4.5:1 — confirmed as a real (not merely mid-transition) axe
  // finding on the paginator's disabled Previous/Next buttons during the
  // Phase 2 self-check. Explicit disabled colors, not opacity, keep every
  // variant's disabled state compliant regardless of background.
  protected readonly isDisabled = computed(() => this.disabled() || this.loading());
}

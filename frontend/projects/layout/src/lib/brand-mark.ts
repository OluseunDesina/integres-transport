import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { WhiteLabelResolverService } from '@auth';

/**
 * The operator's mark, or ours.
 *
 * Spec 14's second founding finding was that "white-labeling does not
 * white-label anything": `WhiteLabelConfig` stores a logo, a name and two
 * colours, and the only code that read any of them was the form that
 * edits them. Slice 1 closed the colour half — `BrandThemeService`
 * overrides the brand tokens at boot — but **`logo` and `name` were
 * still read by nothing at all**, in any app. This is their first
 * consumer.
 *
 * Three states, in order:
 *
 * 1. A resolved tenant logo, rendered as an image.
 * 2. A resolved tenant name, rendered as a wordmark, when they have
 *    configured a name but no logo.
 * 3. Our own wordmark, when the host resolves to no tenant at all —
 *    local dev, and the platform's own domain.
 *
 * The logo's `alt` names the operator rather than saying "logo": a
 * screen-reader user needs to know *whose* app this is, and "logo" tells
 * them nothing they cannot infer.
 *
 * Lives in `@layout` because that library already owns `AuthLayout`, the
 * card these marks sit in, and already depends on `@auth` for
 * `AuthStore` — so `WhiteLabelResolverService` is in reach without a new
 * dependency. It was `customer-app`-local until slice 6b, when
 * `client-admin-app` and `validator-app`'s logins needed it too.
 *
 * **`super-admin-app` deliberately does not use it.** That app spans
 * every Client, so there is no tenant whose mark it could wear — the
 * same reason spec 14 leaves it unthemed.
 */
@Component({
  selector: 'app-brand-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (logo(); as src) {
      <img [src]="src" [alt]="name()" [style.height.px]="height()" class="w-auto object-contain" />
    } @else {
      <span class="font-semibold text-strong" [style.font-size.px]="height() * 0.55">
        {{ name() }}
      </span>
    }
  `,
})
export class BrandMark {
  /** Rendered height in px. The wordmark fallback is scaled from it so
   * the two states occupy the same vertical space and the header does
   * not resize when a tenant configures a logo. */
  readonly height = input(28);

  private readonly whiteLabel = inject(WhiteLabelResolverService);

  protected readonly logo = computed(() => this.whiteLabel.branding()?.logo ?? null);
  protected readonly name = computed(() => this.whiteLabel.branding()?.name ?? 'Integra Travel');
}

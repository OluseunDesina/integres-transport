import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from '@shared-ui';
import type { IconName } from '@shared-ui';

import { MarketplaceLogo } from './marketplace-logo';

/**
 * Split-screen sign-in/registration shell — docs/specs/24-marketplace-
 * redesign.md. Not `@layout`'s `AuthLayout` (a grey page with a centred
 * card, shared by the four operator/tenant apps): the storefront's own
 * navy panel carries on from the header and hero, and says what an
 * account is for. Below `lg` the panel drops away and only the form
 * remains, under the logo.
 */
@Component({
  selector: 'app-marketplace-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [RouterLink, Icon, MarketplaceLogo],
  template: `
    <main class="grid min-h-screen bg-surface lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside
        class="relative isolate hidden overflow-hidden bg-gradient-to-br from-mk-navy-950 to-mk-navy-900 p-12 lg:flex lg:flex-col lg:justify-between"
      >
        <div
          aria-hidden="true"
          class="pointer-events-none absolute -right-32 -bottom-32 -z-10 h-96 w-96 rounded-full bg-primary/30 blur-3xl"
        ></div>
        <a
          routerLink="/search"
          aria-label="TransitOS home"
          class="w-fit rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-accent"
        >
          <app-marketplace-logo tone="light" />
        </a>
        <div>
          <p class="text-xs font-semibold tracking-[0.2em] text-mk-accent uppercase">Your trips, one account</p>
          <h2 class="mt-3 max-w-md text-3xl leading-tight font-bold tracking-tight text-white">
            Book with any operator. Keep every ticket in one place.
          </h2>
          <ul class="mt-8 flex flex-col gap-4 text-mk-on-navy-muted">
            @for (point of points; track point.label) {
              <li class="flex items-center gap-3">
                <span class="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-mk-navy-800 text-mk-accent">
                  <ui-icon [name]="point.icon" [size]="18" />
                </span>
                {{ point.label }}
              </li>
            }
          </ul>
        </div>
        <p class="text-xs text-mk-on-navy-muted">Every trip is run by its listed operator.</p>
      </aside>

      <div class="flex flex-col px-4 py-8 sm:px-8">
        <div class="flex items-center justify-between">
          <a
            routerLink="/search"
            aria-label="TransitOS home"
            class="rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:invisible"
          >
            <app-marketplace-logo tone="dark" />
          </a>
          <a
            routerLink="/search"
            class="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-medium text-default hover:bg-surface-muted hover:text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <ui-icon name="chevron-left" [size]="16" />
            Back to search
          </a>
        </div>
        <div class="flex flex-1 items-center justify-center py-10">
          <div class="w-full max-w-md">
            <ng-content />
          </div>
        </div>
      </div>
    </main>
  `,
})
export class MarketplaceAuthLayout {
  protected readonly points: { icon: IconName; label: string }[] = [
    { icon: 'squares-2x2', label: 'Compare every operator in one search' },
    { icon: 'shield-check', label: 'Pay securely by card, transfer or wallet' },
    { icon: 'ticket', label: 'Your QR tickets, always to hand' },
  ];
}

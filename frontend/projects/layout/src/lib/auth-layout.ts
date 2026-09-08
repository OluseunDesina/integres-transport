import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Centered card shell for standalone auth pages (login, etc.). No focus
 * trap here deliberately — `cdkTrapFocus` is for modals/overlays with
 * background content to shield; a full standalone page has none, and
 * CDK's trap-boundary anchors (aria-hidden + tabindex="0") fail axe's
 * aria-hidden-focus rule when applied outside that context.
 */
@Component({
  selector: 'app-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <!-- Tokens, not slate-* literals (spec 14 slice 5). The values are
         identical — surface-muted is ink-50 is slate-50 — so no app's
         login screen moves; what changes is that a future palette edit
         reaches this shell like everything else. -->
    <main class="flex min-h-screen items-center justify-center bg-surface-muted px-4 py-12">
      <div class="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-sm">
        <ng-content />
      </div>
    </main>
  `,
})
export class AuthLayout {}

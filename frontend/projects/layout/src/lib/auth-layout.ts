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
    <main class="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div class="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <ng-content />
      </div>
    </main>
  `,
})
export class AuthLayout {}

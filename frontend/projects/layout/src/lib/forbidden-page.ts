import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-forbidden-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <main class="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
      <h1 class="text-lg font-semibold text-slate-900">You don't have access to this page</h1>
      <p class="text-sm text-slate-500">
        Your account doesn't have permission to view this. Contact your administrator if you
        think this is a mistake.
      </p>
    </main>
  `,
})
export class ForbiddenPage {}

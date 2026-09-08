import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore } from '@auth';
import { Button, PageHeader } from '@shared-ui';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Button, PageHeader],
  templateUrl: './home.html',
})
export class Home {
  private readonly router = inject(Router);
  // Read by the template for the signed-in user's name, not for request
  // headers — those are the middleware's job (docs/specs/13-session-resilience.md).
  protected readonly authStore = inject(AuthStore);

  /**
   * A first name where we have one, the email otherwise.
   *
   * The old heading was "Welcome, {{ email }}", which put a login
   * credential in 20px type at the top of the passenger's home screen —
   * fine as a placeholder, wrong as a greeting. `AuthUser` has carried
   * `firstName` since Phase 1; nothing read it.
   */
  protected readonly greeting = computed(() => {
    const user = this.authStore.user();
    const name = user?.firstName?.trim();
    return name ? `Welcome back, ${name}` : `Welcome, ${user?.email ?? ''}`.trim();
  });

  protected readonly quickLinks = [
    {
      path: '/my-bookings',
      label: 'My bookings',
      description: 'Pay for, cancel or show a booking.',
    },
    {
      path: '/credentials',
      label: 'Tap & Go',
      description: 'Issue a code you can tap to board.',
    },
    { path: '/wallet', label: 'Wallet', description: 'Check your balance or top up.' },
    {
      path: '/activity',
      label: 'Activity',
      description: 'Your recent bookings, fares and top-ups.',
    },
  ];

  protected async goToSearch(): Promise<void> {
    await this.router.navigate(['/search']);
  }
}

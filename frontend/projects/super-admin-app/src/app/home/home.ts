import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '@auth';
import { Icon, PageHeader } from '@shared-ui';
import type { IconName } from '@shared-ui';

interface Destination {
  path: string;
  label: string;
  description: string;
  icon: IconName;
}

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, PageHeader],
  templateUrl: './home.html',
})
export class Home {
  // Read by the template for the signed-in user's identity, not for
  // request headers — those are the middleware's job
  // (docs/specs/13-session-resilience.md).
  protected readonly authStore = inject(AuthStore);

  /**
   * A name where we have one, the email otherwise.
   *
   * This screen used to render `Client: —`, `Platform staff: true` and
   * a green box reading "You have super-admin-app access." — the Phase 0
   * placeholder, still the landing page platform staff saw every day.
   * `isPlatformStaff` was being printed as a raw boolean to a user who,
   * by definition, is one.
   */
  protected readonly greeting = computed(() => {
    const user = this.authStore.user();
    const name = user?.firstName?.trim();
    return name ? `Welcome back, ${name}` : `Welcome, ${user?.email ?? ''}`.trim();
  });

  /** The same three destinations the nav already carries. No new
   * endpoint and no new data — a landing page rather than a debug
   * dump. */
  protected readonly destinations: Destination[] = [
    {
      path: '/kyc-queue',
      label: 'KYC queue',
      description: 'Review client identity submissions.',
      icon: 'clipboard-document-check',
    },
    {
      path: '/businesses',
      label: 'Businesses',
      description: 'Find a business to configure payouts, review a KYB submission, or check its settlements.',
      icon: 'building-office',
    },
    {
      path: '/invite-client',
      label: 'Invite a client',
      description: 'Send an operator an invitation to register.',
      icon: 'user-plus',
    },
  ];
}

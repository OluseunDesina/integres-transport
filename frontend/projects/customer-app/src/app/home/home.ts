import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '@auth';
import { Button } from '@shared-ui';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button],
  templateUrl: './home.html',
})
export class Home {
  protected readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected async goToSearch(): Promise<void> {
    await this.router.navigate(['/search']);
  }
}

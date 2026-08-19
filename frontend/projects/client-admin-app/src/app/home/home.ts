import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthStore, HasPermissionDirective } from '@auth';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HasPermissionDirective],
  templateUrl: './home.html',
})
export class Home {
  protected readonly authStore = inject(AuthStore);
}

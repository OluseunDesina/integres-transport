import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';

import { PermissionsService } from './permissions.service';

/**
 * Template-layer half of the three-layer authorization pattern (guard +
 * nav filtering + this directive). Usage: `*appHasPermission="'client-admin:access'"`
 * or `*appHasPermission="['a', 'b']"` (any-of).
 */
@Directive({
  selector: '[appHasPermission]',
})
export class HasPermissionDirective {
  readonly appHasPermission = input.required<string | readonly string[]>();

  private readonly permissionsService = inject(PermissionsService);
  private readonly templateRef = inject(TemplateRef<unknown>);
  private readonly viewContainerRef = inject(ViewContainerRef);

  constructor() {
    effect(() => {
      const required = this.normalize(this.appHasPermission());
      this.viewContainerRef.clear();
      if (this.permissionsService.hasAny(required)) {
        this.viewContainerRef.createEmbeddedView(this.templateRef);
      }
    });
  }

  private normalize(value: string | readonly string[]): readonly string[] {
    return Array.isArray(value) ? value : [value as string];
  }
}

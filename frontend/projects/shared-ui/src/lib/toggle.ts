import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/**
 * An immediate-action switch — flips a row's state right where it's
 * displayed, rather than making the user open an edit form to change
 * one boolean.
 *
 * Deliberately **not** a `ControlValueAccessor`. Every other form
 * control in this library binds through `formControlName` and is
 * committed on submit; this one fires `toggled` and expects the caller
 * to persist immediately, so wiring it into a reactive form would
 * invite exactly the wrong mental model. Its state is driven purely by
 * the `checked` input, which means an optimistic caller can flip it
 * back if the request fails.
 *
 * `role="switch"` + `aria-checked` (not `aria-pressed`) is the correct
 * pattern for a binary on/off control whose change takes effect at
 * once. Both land on the real `<button>`, never on the host — the host
 * is `display: contents`, and a host-level `[attr.*]` binding would be
 * silently dropped from the accessibility tree, the exact bug
 * `ui-button`'s own `ariaPressed` passthrough exists to avoid.
 */
@Component({
  selector: 'ui-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      role="switch"
      [disabled]="isDisabled()"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="label()"
      (click)="toggled.emit(!checked())"
      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed"
      [class.bg-emerald-600]="checked() && !isDisabled()"
      [class.bg-slate-300]="!checked() && !isDisabled()"
      [class.bg-slate-200]="isDisabled()"
    >
      <span
        class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
        [class.translate-x-6]="checked()"
        [class.translate-x-1]="!checked()"
        aria-hidden="true"
      ></span>
    </button>
  `,
})
export class Toggle {
  readonly checked = input.required<boolean>();
  /**
   * The accessible name. Required rather than optional: this control
   * renders no visible text of its own, so without it a screen reader
   * announces a bare "switch" — and in a table of them, every row would
   * sound identical. Callers should include the row's identity
   * (e.g. "Deactivate Ikeja–Lekki Express").
   */
  readonly label = input.required<string>();
  readonly disabled = input(false);
  readonly pending = input(false);

  /** Emits the *requested* next state, not the current one. */
  readonly toggled = output<boolean>();

  protected readonly isDisabled = computed(() => this.disabled() || this.pending());
}

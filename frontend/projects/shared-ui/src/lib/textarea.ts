import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';

let nextId = 0;

function noop(): void {
  // Default ControlValueAccessor callbacks before Angular forms registers real ones.
}

/**
 * Multi-line text, with `ui-text-field`'s contract.
 *
 * Three screens hand-rolled this before it existed — the KYC and KYB
 * review dialogs and `my-bookings`' cancel dialog — and two of them
 * still carried `border border-slate-300`, the input border slice 1
 * measured at **1.48:1** against WCAG 1.4.11's 3:1 floor and replaced
 * everywhere else with `--color-control` at 4.76:1. `theme.css` records
 * why that survived: axe does not check non-text contrast on input
 * borders, so nothing surfaced it.
 *
 * That is the argument for the component rather than for three more
 * token swaps. A hand-rolled control also has no label association
 * beyond whatever the caller remembers to write, no `aria-describedby`,
 * and no error rendering at all — so a server error on a textarea had
 * nowhere to go on any of the three.
 */
@Component({
  selector: 'ui-textarea',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => Textarea),
      multi: true,
    },
  ],
  template: `
    <div class="flex flex-col gap-1">
      <label [for]="id" style="font-size: var(--ui-text-body)" class="font-medium text-default">{{
        label()
      }}</label>
      <textarea
        [id]="id"
        [rows]="rows()"
        [value]="value()"
        [disabled]="disabled()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (input)="onInput($event)"
        (blur)="onTouched()"
        style="font-size: var(--ui-text-body)"
        class="w-full rounded-md border bg-surface px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        [class.border-danger]="invalid()"
        [class.border-control]="!invalid()"
      ></textarea>
      @if (hint(); as text) {
        <p [id]="hintId" style="font-size: var(--ui-text-body)" class="text-muted">{{ text }}</p>
      }
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" style="font-size: var(--ui-text-body)" class="text-danger" role="alert">
          {{ errorMessage() }}
        </p>
      }
    </div>
  `,
})
export class Textarea implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly rows = input(3);
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  /** Guidance not inferable from the label, wired through
   * `aria-describedby` — same rule `ui-text-field` and `ui-select`
   * carry. */
  readonly hint = input<string | null>(null);

  protected readonly id = `ui-textarea-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly hintId = `${this.id}-hint`;

  /** Both descriptions when both are present — `aria-describedby` takes
   * a space-separated id list, and dropping the hint on an invalid field
   * would remove the explanation exactly when it is most needed. */
  protected readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.hint()) {
      ids.push(this.hintId);
    }
    if (this.invalid() && this.errorMessage()) {
      ids.push(this.errorId);
    }
    return ids.length > 0 ? ids.join(' ') : null;
  });
  protected readonly value = signal('');
  protected readonly disabled = signal(false);

  private onChange: (value: string) => void = noop;
  protected onTouched: () => void = noop;

  writeValue(value: string): void {
    this.value.set(value ?? '');
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}

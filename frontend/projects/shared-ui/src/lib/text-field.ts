import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  signal,
} from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';

let nextId = 0;

function noop(): void {
  // Default ControlValueAccessor callbacks before Angular forms registers real ones.
}

@Component({
  selector: 'ui-text-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => TextField),
      multi: true,
    },
  ],
  template: `
    <div class="flex flex-col gap-1">
      <label [for]="id" style="font-size: var(--ui-text-body)" class="font-medium text-default">{{
        label()
      }}</label>
      <input
        [id]="id"
        [type]="type()"
        [autocomplete]="autocomplete()"
        [attr.inputmode]="inputMode()"
        [value]="value()"
        [disabled]="disabled()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (input)="onInput($event)"
        (blur)="onTouched()"
        style="font-size: var(--ui-text-body)"
        class="min-h-11 rounded-md border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        [class.border-danger]="invalid()"
        [class.border-control]="!invalid()"
      />
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
export class TextField implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly type = input<'text' | 'email' | 'password' | 'date' | 'time'>('text');
  readonly autocomplete = input<string>('off');
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  /**
   * Guidance that is not inferable from the label — a format, a unit, or
   * that the field is optional.
   *
   * Wired through `aria-describedby`, the same rule `ui-select`'s own
   * `hint` and `ui-toggle`'s `describedBy` already carry: a loose `<p>`
   * beside a control reaches sighted users only. `ui-select` gained this
   * in spec 12 and this component did not, so half the forms in the
   * console had nowhere to put a format note.
   */
  readonly hint = input<string | null>(null);
  /**
   * The on-screen keyboard a phone should offer.
   *
   * Separate from `type` on purpose. An amount wants the numeric keypad
   * but **not** `type="number"`, whose spinners, scroll-wheel capture and
   * locale-dependent parsing all make it a poor money input;
   * `type="text"` with `inputmode="decimal"` gives the keypad and none of
   * that. Added in spec 14 slice 5 for `customer-app`'s wallet top-up,
   * which offered a full QWERTY keyboard for a sum of money.
   */
  readonly inputMode = input<'text' | 'decimal' | 'numeric' | 'tel' | 'email' | null>(null);

  protected readonly id = `ui-text-field-${nextId++}`;
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
    const value = (event.target as HTMLInputElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}

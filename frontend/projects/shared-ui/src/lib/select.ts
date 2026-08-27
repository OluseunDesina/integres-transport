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

export interface SelectOption {
  value: string;
  label: string;
}

@Component({
  selector: 'ui-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => Select),
      multi: true,
    },
  ],
  template: `
    <div class="flex flex-col gap-1">
      <label [for]="id" class="text-sm font-medium text-slate-700">{{ label() }}</label>
      <select
        [id]="id"
        [value]="value()"
        [disabled]="disabled()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (change)="onSelect($event)"
        (blur)="onTouched()"
        class="w-full min-h-11 rounded-md border bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        [class.border-red-500]="invalid()"
        [class.border-slate-300]="!invalid()"
      >
        @for (option of options(); track option.value) {
          <option [value]="option.value">{{ option.label }}</option>
        }
      </select>
      @if (hint(); as text) {
        <p [id]="hintId" class="text-sm text-slate-500">{{ text }}</p>
      }
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" class="text-sm text-red-600" role="alert">{{ errorMessage() }}</p>
      }
    </div>
  `,
})
export class Select implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly options = input.required<SelectOption[]>();
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  /**
   * Guidance rendered under the control and associated with it via
   * `aria-describedby`, so a screen reader announces it as part of the
   * field rather than as stray text a sighted user happens to see
   * nearby. Added for the fare-pricing-mode select, where the
   * consequence of switching is not inferable from the option labels
   * (docs/specs/12-fare-matrix.md).
   */
  readonly hint = input<string | null>(null);

  protected readonly id = `ui-select-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly hintId = `${this.id}-hint`;

  /** Both descriptions when both are present — `aria-describedby` takes
   * a space-separated id list, and dropping the hint on an invalid
   * field would remove the explanation exactly when it is most needed. */
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

  protected onSelect(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.value.set(value);
    this.onChange(value);
  }
}

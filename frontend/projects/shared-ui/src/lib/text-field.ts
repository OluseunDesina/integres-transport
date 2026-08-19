import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
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
      <label [for]="id" class="text-sm font-medium text-slate-700">{{ label() }}</label>
      <input
        [id]="id"
        [type]="type()"
        [autocomplete]="autocomplete()"
        [value]="value()"
        [disabled]="disabled()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="invalid() && errorMessage() ? errorId : null"
        (input)="onInput($event)"
        (blur)="onTouched()"
        class="min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        [class.border-red-500]="invalid()"
        [class.border-slate-300]="!invalid()"
      />
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" class="text-sm text-red-600" role="alert">{{ errorMessage() }}</p>
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

  protected readonly id = `ui-text-field-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
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

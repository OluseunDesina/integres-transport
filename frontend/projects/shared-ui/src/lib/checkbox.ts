import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';

let nextId = 0;

function noop(): void {
  // Default ControlValueAccessor callbacks before Angular forms registers real ones.
}

/**
 * A single boolean, committed with the form around it.
 *
 * **Not `ui-toggle`, and the distinction is the whole reason both
 * exist.** `ui-toggle` is deliberately *not* a `ControlValueAccessor`:
 * its docstring says it fires `toggled` and expects the caller to
 * persist immediately, so wiring it into a reactive form "would invite
 * exactly the wrong mental model". This is the other case — a value
 * that sits in a form until submit, bound with `formControlName` like
 * every other field.
 *
 * Three screens hand-rolled a bare `<input type="checkbox">` before
 * this existed. A bare one is not wrong so much as unlabelled: its text
 * is a sibling the browser associates only if the caller remembers the
 * wrapping `<label>`, it has no `aria-describedby`, and it cannot show
 * an error — so a server error on a boolean had nowhere to render.
 *
 * The 44px row is the target, not the box: a 16px checkbox is well
 * under WCAG 2.5.8, and making the whole label row the hit area is what
 * fixes that without drawing a giant box.
 */
@Component({
  selector: 'ui-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => Checkbox),
      multi: true,
    },
  ],
  template: `
    <div class="flex flex-col gap-1">
      <label
        class="inline-flex min-h-11 items-center gap-2 text-default"
        style="font-size: var(--ui-text-body)"
      >
        <input
          type="checkbox"
          [id]="id"
          [checked]="value()"
          [disabled]="disabled()"
          [attr.aria-invalid]="invalid() || null"
          [attr.aria-describedby]="describedBy()"
          (change)="onToggle($event)"
          (blur)="onTouched()"
          class="h-4 w-4 rounded border-control text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        {{ label() }}
      </label>
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
export class Checkbox implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  readonly hint = input<string | null>(null);

  protected readonly id = `ui-checkbox-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly hintId = `${this.id}-hint`;

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
  protected readonly value = signal(false);
  protected readonly disabled = signal(false);

  private onChange: (value: boolean) => void = noop;
  protected onTouched: () => void = noop;

  writeValue(value: boolean): void {
    this.value.set(!!value);
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onToggle(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.value.set(checked);
    this.onChange(checked);
  }
}

import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';

import type { SelectOption } from './select';

let nextId = 0;

function noop(): void {
  // Default ControlValueAccessor callbacks before Angular forms registers real ones.
}

/**
 * One choice from a short, visible set.
 *
 * **Native `<input type="radio">`, deliberately, not `role="radio"` on
 * something else.** A radio group owns a real keyboard contract —
 * arrow keys move *and* select within the group, Tab enters and leaves
 * it as a single stop — and the browser implements all of it for free
 * when the inputs share a `name`. Reimplementing that on styled buttons
 * is the same trap `ui-toolbar` records for declining `role="toolbar"`:
 * a role promising a navigation model that does not work is worse than
 * no role. `validator-app`'s board/alight control is a live instance —
 * a `role="radiogroup"` div wrapping two `ui-button`s with
 * `aria-pressed`, which announces as a radio group and behaves as two
 * toggle buttons (fixed in slice 6b).
 *
 * A real `<fieldset>`/`<legend>` rather than an `aria-label`, so the
 * group's question is announced when focus enters it and the options
 * read as answers to it.
 *
 * Use it for two to about five mutually exclusive options that are all
 * worth seeing at once; `ui-select` is right beyond that.
 */
@Component({
  selector: 'ui-radio-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => RadioGroup),
      multi: true,
    },
  ],
  template: `
    <fieldset
      class="flex flex-col gap-2"
      [attr.aria-invalid]="invalid() || null"
      [attr.aria-describedby]="describedBy()"
    >
      <legend style="font-size: var(--ui-text-body)" class="font-medium text-default">
        {{ label() }}
      </legend>

      <div [class]="segmented() ? 'grid auto-cols-fr grid-flow-col gap-2' : 'flex flex-col gap-2'">
        @for (option of options(); track option.value) {
          <label
            style="font-size: var(--ui-text-body)"
            [class]="segmented() ? segmentClass : stackClass"
            [class.border-primary]="segmented() && value() === option.value"
            [class.bg-primary]="segmented() && value() === option.value"
            [class.text-on-primary]="segmented() && value() === option.value"
            [class.border-control]="segmented() && value() !== option.value"
            [class.bg-surface]="segmented() && value() !== option.value"
            [class.text-default]="segmented() && value() !== option.value"
          >
            <input
              type="radio"
              [name]="name"
              [value]="option.value"
              [checked]="value() === option.value"
              [disabled]="disabled()"
              (change)="select(option.value)"
              (blur)="onTouched()"
              [class]="
                segmented()
                  ? 'sr-only'
                  : 'h-4 w-4 border-control text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
              "
            />
            {{ option.label }}
          </label>
        }
      </div>

      @if (hint(); as text) {
        <p [id]="hintId" style="font-size: var(--ui-text-body)" class="text-muted">{{ text }}</p>
      }
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" style="font-size: var(--ui-text-body)" class="text-danger" role="alert">
          {{ errorMessage() }}
        </p>
      }
    </fieldset>
  `,
})
export class RadioGroup implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly options = input.required<SelectOption[]>();
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  readonly hint = input<string | null>(null);
  /**
   * Renders the options as one row of large adjacent targets instead of
   * a stacked list.
   *
   * **The inputs are still real radios**, only `sr-only`, so the whole
   * keyboard contract is unchanged — this is a skin, not a second
   * implementation. That is the entire point: `validator-app`'s
   * board/alight control was a `role="radiogroup"` div wrapping two
   * `ui-button`s with `aria-pressed`, which announced as a radio group
   * and behaved as two independent toggles.
   *
   * Use it where the choice is binary or near-binary and the target size
   * matters more than the vertical space — a handheld operated
   * one-handed in a moving vehicle, which is the case spec 14 makes for
   * that app. `ui-select` is still right past about four options.
   */
  readonly segmented = input(false);

  /** Class lists live here rather than inline because the template
   * already carries six conditional colour bindings per option, and a
   * seventh line of layout utilities inside the ternary made the
   * segmented/stacked branch unreadable. */
  protected readonly segmentClass =
    'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-4 py-2 text-center font-medium transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus';

  protected readonly stackClass = 'inline-flex min-h-11 items-center gap-2 text-default';

  /** Shared by every input in the group, which is what makes the
   * browser treat them as one control. Generated rather than taken as
   * an input: two groups on one screen with the same `name` would
   * silently deselect each other, and nothing about the markup would
   * show why. */
  protected readonly name = `ui-radio-group-${nextId++}`;
  protected readonly errorId = `${this.name}-error`;
  protected readonly hintId = `${this.name}-hint`;

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

  protected select(value: string): void {
    this.value.set(value);
    this.onChange(value);
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
} from '@angular/core';

let nextId = 0;

/**
 * Not a `ControlValueAccessor` — a native file input's value can't be set
 * programmatically, so there's nothing for `writeValue` to do here.
 *
 * One consumer now (`kyc-status`), not the two the docstring claimed:
 * `business-kyb` hand-rolls its own two file inputs, which slice 4 gave
 * `border-control` directly. Consolidating those onto this component is
 * worth doing and is not this slice's — nothing about them is broken.
 *
 * Slice 6b brought it up to the rest of the library's contract. It was
 * the last `border border-slate-300` in the workspace — the input border
 * slice 1 measured at **1.48:1** against WCAG 1.4.11's 3:1 — and its
 * error `<p>` was rendered but never referenced by the input, so a
 * screen reader announced the field as valid and unexplained while a
 * message sat visibly beneath it.
 */
@Component({
  selector: 'app-file-upload-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-1">
      <label [for]="id" style="font-size: var(--ui-text-body)" class="font-medium text-default">{{
        label()
      }}</label>
      <input
        #fileInput
        [id]="id"
        type="file"
        [accept]="accept()"
        [attr.aria-invalid]="invalid() || null"
        [attr.aria-describedby]="describedBy()"
        (change)="onChange($event)"
        style="font-size: var(--ui-text-body)"
        class="min-h-11 rounded-md border px-3 py-2 file:mr-3 file:rounded file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        [class.border-danger]="invalid()"
        [class.border-control]="!invalid()"
      />
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" style="font-size: var(--ui-text-body)" class="text-danger" role="alert">
          {{ errorMessage() }}
        </p>
      }
    </div>
  `,
})
export class FileUploadField {
  readonly label = input.required<string>();
  readonly accept = input<string>('');
  readonly errorMessage = input<string | null>(null);
  readonly invalid = input(false);
  readonly fileSelected = output<File | null>();

  protected readonly id = `file-upload-field-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;

  /** The error was rendered but never referenced, so it reached sighted
   * users only — the same gap `ui-text-field`'s own `describedBy`
   * closes. */
  protected readonly describedBy = computed(() =>
    this.invalid() && this.errorMessage() ? this.errorId : null
  );

  @ViewChild('fileInput') private readonly fileInput!: ElementRef<HTMLInputElement>;

  protected onChange(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.fileSelected.emit(file);
  }

  /** Native file inputs can't have their value set, only cleared — used
   * by callers to visually reset the field after a successful upload. */
  reset(): void {
    this.fileInput.nativeElement.value = '';
  }
}

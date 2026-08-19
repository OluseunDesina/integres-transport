import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, input, output } from '@angular/core';

let nextId = 0;

/**
 * Not a `ControlValueAccessor` — a native file input's value can't be set
 * programmatically, so there's nothing for `writeValue` to do here. Used
 * twice (Client KYC upload, Business KYB upload), not `shared-ui`-worthy.
 */
@Component({
  selector: 'app-file-upload-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-1">
      <label [for]="id" class="text-sm font-medium text-slate-700">{{ label() }}</label>
      <input
        #fileInput
        [id]="id"
        type="file"
        [accept]="accept()"
        (change)="onChange($event)"
        class="min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      />
      @if (invalid() && errorMessage()) {
        <p [id]="errorId" class="text-sm text-red-600" role="alert">{{ errorMessage() }}</p>
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

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { FileUploadField } from './file-upload-field';

@Component({
  imports: [FileUploadField],
  template: `<app-file-upload-field
    label="Document"
    [invalid]="invalid"
    [errorMessage]="invalid ? 'Choose a file.' : null"
    (fileSelected)="onFileSelected($event)"
  />`,
})
class HostComponent {
  invalid = false;
  lastFile: File | null = null;

  onFileSelected(file: File | null): void {
    this.lastFile = file;
  }
}

describe('FileUploadField', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a label associated with the input via for/id', () => {
    const label = fixture.debugElement.query(By.css('label')).nativeElement as HTMLLabelElement;
    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.textContent).toContain('Document');
  });

  it('emits the selected file on change', () => {
    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    const file = new File(['content'], 'cert.pdf', { type: 'application/pdf' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('change'));

    expect(host.lastFile).toBe(file);
  });

  it('renders the error message when invalid', () => {
    host.invalid = true;
    fixture.detectChanges();

    const error = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;
    expect(error.textContent).toContain('Choose a file.');
  });
});

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { Textarea } from './textarea';

@Component({
  imports: [ReactiveFormsModule, Textarea],
  template: `
    <ui-textarea
      [label]="label()"
      [rows]="rows()"
      [hint]="hint()"
      [invalid]="invalid()"
      [errorMessage]="errorMessage()"
      [formControl]="control"
    />
  `,
})
class Host {
  readonly label = signal('Reason');
  readonly rows = signal(3);
  readonly hint = signal<string | null>(null);
  readonly invalid = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly control = new FormControl('');
}

describe('Textarea', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function textarea(): HTMLTextAreaElement {
    return (fixture.nativeElement as HTMLElement).querySelector('textarea') as HTMLTextAreaElement;
  }

  function labelEl(): HTMLLabelElement {
    return (fixture.nativeElement as HTMLElement).querySelector('label') as HTMLLabelElement;
  }

  // The reason this exists rather than three more token swaps: a
  // hand-rolled textarea associates its label only if the caller
  // remembers to, and two of the three did it by hand.
  it('associates its label with the control', () => {
    expect(labelEl().getAttribute('for')).toBe(textarea().id);
    expect(labelEl().textContent?.trim()).toBe('Reason');
  });

  it('writes through to the form control', () => {
    textarea().value = 'Certificate illegible.';
    textarea().dispatchEvent(new Event('input'));

    expect(host.control.value).toBe('Certificate illegible.');
  });

  it('renders a value written from the form', () => {
    host.control.setValue('From the model');
    fixture.detectChanges();

    expect(textarea().value).toBe('From the model');
  });

  it('renders nothing until the parent says it is invalid', () => {
    // Spec 11's recorded trap: a form binding neither `invalid` nor
    // `errorMessage` silently shows nothing, and its test still passes.
    host.errorMessage.set('Give a reason.');
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Give a reason.');
  });

  it('renders the error and points the control at it', () => {
    host.invalid.set(true);
    host.errorMessage.set('Give a reason.');
    fixture.detectChanges();

    const error = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(error?.textContent?.trim()).toBe('Give a reason.');
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(textarea().getAttribute('aria-describedby')).toContain(error?.id);
  });

  // Dropping the hint while invalid removes the explanation exactly
  // when it is most needed.
  it('describes by both hint and error when both apply', () => {
    host.hint.set('Shown to the client.');
    host.invalid.set(true);
    host.errorMessage.set('Give a reason.');
    fixture.detectChanges();

    const describedBy = textarea().getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').length).toBe(2);
    for (const id of describedBy.split(' ')) {
      expect(document.getElementById(id) ?? fixture.nativeElement.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('takes a row count', () => {
    host.rows.set(6);
    fixture.detectChanges();

    expect(textarea().rows).toBe(6);
  });

  it('disables through the form, not a separate input', () => {
    host.control.disable();
    fixture.detectChanges();

    expect(textarea().disabled).toBeTrue();
  });

  it('marks touched on blur, so fieldErrorMessage can stay quiet until then', () => {
    textarea().dispatchEvent(new Event('blur'));

    expect(host.control.touched).toBeTrue();
  });
});

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { Checkbox } from './checkbox';

@Component({
  imports: [ReactiveFormsModule, Checkbox],
  template: `
    <ui-checkbox
      label="Active"
      [hint]="hint()"
      [invalid]="invalid()"
      [errorMessage]="errorMessage()"
      [formControl]="control"
    />
  `,
})
class Host {
  readonly hint = signal<string | null>(null);
  readonly invalid = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly control = new FormControl(false);
}

describe('Checkbox', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function input(): HTMLInputElement {
    return (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;
  }

  it('labels the box by wrapping it, so the text is the control', () => {
    expect(input().closest('label')?.textContent?.trim()).toBe('Active');
  });

  it('writes through to the form control', () => {
    input().click();

    expect(host.control.value).toBeTrue();
  });

  it('reflects a value written from the form', () => {
    host.control.setValue(true);
    fixture.detectChanges();

    expect(input().checked).toBeTrue();
  });

  // The distinction from ui-toggle: this is a form value committed on
  // submit, which is why it is a ControlValueAccessor and ui-toggle
  // deliberately is not.
  it('does not write anything anywhere on its own', () => {
    const seen: unknown[] = [];
    host.control.valueChanges.subscribe((v) => seen.push(v));

    input().click();

    expect(seen).toEqual([true]);
  });

  it('renders nothing until the parent says it is invalid', () => {
    host.errorMessage.set('Required.');
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Required.');
  });

  it('renders the error and points the box at it', () => {
    host.invalid.set(true);
    host.errorMessage.set('Required.');
    fixture.detectChanges();

    const error = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(error?.textContent?.trim()).toBe('Required.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toContain(error?.id);
  });

  it('describes by the hint, which a loose <p> would not do', () => {
    host.hint.set('Inactive accounts are not paid out.');
    fixture.detectChanges();

    const hintId = input().getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(`#${hintId}`)?.textContent?.trim()
    ).toBe('Inactive accounts are not paid out.');
  });

  it('disables through the form', () => {
    host.control.disable();
    fixture.detectChanges();

    expect(input().disabled).toBeTrue();
  });

  // WCAG 2.5.8 again: the row is the target, not the 16px box.
  it('gives the row a full-height hit area', () => {
    expect(input().closest('label')?.className).toContain('min-h-11');
  });
});

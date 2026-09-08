import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { TextField } from './text-field';

@Component({
  imports: [ReactiveFormsModule, TextField],
  template: `<ui-text-field
    label="Email"
    type="email"
    [formControl]="control"
    [invalid]="invalid"
    [hint]="hint"
    [errorMessage]="invalid ? 'Enter a valid email address.' : null"
  />`,
})
class HostComponent {
  control = new FormControl('', { nonNullable: true });
  invalid = false;
  hint: string | null = null;
}

@Component({
  imports: [ReactiveFormsModule, TextField],
  template: `<ui-text-field label="Expiry date" type="date" [formControl]="control" />`,
})
class DateHostComponent {
  control = new FormControl('', { nonNullable: true });
}

@Component({
  imports: [ReactiveFormsModule, TextField],
  template: `<ui-text-field label="Departure time" type="time" [formControl]="control" />`,
})
class TimeHostComponent {
  control = new FormControl('', { nonNullable: true });
}

describe('TextField', () => {
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
    expect(label.textContent).toContain('Email');
  });

  it('propagates input to the bound FormControl', () => {
    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    input.value = 'passenger@example.com';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(host.control.value).toBe('passenger@example.com');
  });

  it('renders the error message with aria-describedby wiring when invalid', () => {
    host.invalid = true;
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    const error = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(error.textContent).toContain('Enter a valid email address.');
  });

  it('renders a native date input for type="date"', () => {
    const dateFixture = TestBed.createComponent(DateHostComponent);
    dateFixture.detectChanges();

    const input = dateFixture.debugElement.query(By.css('input'))
      .nativeElement as HTMLInputElement;
    expect(input.type).toBe('date');
  });

  it('renders a native time input for type="time"', () => {
    const timeFixture = TestBed.createComponent(TimeHostComponent);
    timeFixture.detectChanges();

    const input = timeFixture.debugElement.query(By.css('input'))
      .nativeElement as HTMLInputElement;
    expect(input.type).toBe('time');
  });
  // --- hint (spec 14 slice 4) ---

  it('renders no hint and no aria-describedby when no hint is given', () => {
    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('associates a hint with the input via aria-describedby', () => {
    host.hint = 'A short reference such as LAG-IBD. Optional.';
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    const hint = fixture.debugElement.query(By.css('p')).nativeElement as HTMLElement;

    expect(hint.textContent).toContain('LAG-IBD');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('describes the input by both hint and error when it is invalid', () => {
    // Dropping the hint on an invalid field would remove the
    // explanation exactly when the user most needs it.
    host.hint = 'A short reference such as LAG-IBD. Optional.';
    host.invalid = true;
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    const error = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? [];

    expect(describedBy.length).toBe(2);
    expect(describedBy).toContain(error.id);
  });
});

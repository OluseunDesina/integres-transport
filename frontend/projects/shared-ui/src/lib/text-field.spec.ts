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
    [errorMessage]="invalid ? 'Enter a valid email address.' : null"
  />`,
})
class HostComponent {
  control = new FormControl('', { nonNullable: true });
  invalid = false;
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
});

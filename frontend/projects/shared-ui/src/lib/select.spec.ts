import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { Select, SelectOption } from './select';

@Component({
  imports: [ReactiveFormsModule, Select],
  template: `<ui-select
    label="Vertical"
    [options]="options"
    [formControl]="control"
    [invalid]="invalid"
    [hint]="hint"
    [errorMessage]="invalid ? 'Choose a vertical.' : null"
  />`,
})
class HostComponent {
  control = new FormControl('', { nonNullable: true });
  invalid = false;
  hint: string | null = null;
  options: SelectOption[] = [
    { value: 'shuttle', label: 'Shuttle' },
    { value: 'intercity', label: 'Intercity' },
  ];
}

describe('Select', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a label associated with the select via for/id', () => {
    const label = fixture.debugElement.query(By.css('label')).nativeElement as HTMLLabelElement;
    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    expect(label.getAttribute('for')).toBe(select.id);
    expect(label.textContent).toContain('Vertical');
  });

  it('renders an option per entry in options()', () => {
    const options = fixture.debugElement.queryAll(By.css('option'));
    expect(options.length).toBe(2);
    expect(options[0].nativeElement.textContent).toContain('Shuttle');
  });

  it('propagates selection to the bound FormControl', () => {
    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    select.value = 'intercity';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(host.control.value).toBe('intercity');
  });

  it('renders the error message with aria-describedby wiring when invalid', () => {
    host.invalid = true;
    fixture.detectChanges();

    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    const error = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;

    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(error.id);
    expect(error.textContent).toContain('Choose a vertical.');
  });

  it('renders no hint and no aria-describedby when no hint is given', () => {
    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    expect(select.getAttribute('aria-describedby')).toBeNull();
  });

  it('associates a hint with the select via aria-describedby', () => {
    host.hint = 'Switching keeps the fares you already entered.';
    fixture.detectChanges();

    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    const hint = fixture.debugElement.query(By.css('p')).nativeElement as HTMLElement;

    expect(hint.textContent).toContain('Switching keeps the fares');
    expect(select.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('describes the select by both hint and error when it is invalid', () => {
    // Dropping the hint on an invalid field would remove the
    // explanation exactly when the user most needs it.
    host.hint = 'Switching keeps the fares you already entered.';
    host.invalid = true;
    fixture.detectChanges();

    const select = fixture.debugElement.query(By.css('select')).nativeElement as HTMLSelectElement;
    const error = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;
    const describedBy = select.getAttribute('aria-describedby')?.split(' ') ?? [];

    expect(describedBy.length).toBe(2);
    expect(describedBy).toContain(error.id);
  });
});

describe('Select initial value', () => {
  @Component({
    imports: [ReactiveFormsModule, Select],
    template: `
      <ui-select label="Severity" [options]="options" [formControl]="control" />
    `,
  })
  class Host {
    readonly options: SelectOption[] = [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ];
    readonly control = new FormControl('medium', { nonNullable: true });
  }

  it('renders the value the control holds, not the first option', async () => {
    // A property binding on <select> lands before @for has created any
    // <option>, so the browser falls back to index 0 and the signal —
    // unchanged — is never written again. The control kept "medium"
    // while the screen showed "Low", so a form submitted something the
    // operator never chose. Only reproducible when the initial value is
    // not the first option.
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select'
    ) as HTMLSelectElement;

    expect(select.value).toBe('medium');
    expect(fixture.componentInstance.control.value).toBe('medium');
  });

  it('still reflects a value patched in after the options exist', async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    fixture.componentInstance.control.setValue('high');
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select'
    ) as HTMLSelectElement;
    expect(select.value).toBe('high');
  });
});

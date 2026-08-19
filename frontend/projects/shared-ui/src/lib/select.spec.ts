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
    [errorMessage]="invalid ? 'Choose a vertical.' : null"
  />`,
})
class HostComponent {
  control = new FormControl('', { nonNullable: true });
  invalid = false;
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
});

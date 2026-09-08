import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Alert } from './alert';

@Component({
  imports: [Alert],
  template: `<ui-alert [variant]="variant">Something went wrong.</ui-alert>`,
})
class HostComponent {
  variant: 'error' | 'success' | 'warning' = 'error';
}

describe('Alert', () => {
  let fixture: ComponentFixture<HostComponent>;

  function roleOf(): string | null {
    const el = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    return el.getAttribute('role');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders projected content with role="alert"', () => {
    const el = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;
    expect(el.textContent).toContain('Something went wrong.');
  });

  // `alert` is assertive: it interrupts a screen reader mid-sentence.
  // Right for a failure, wrong for "Saved." and wrong for the static
  // guidance several screens render through this component.
  it('announces a success politely rather than interrupting', () => {
    fixture.componentInstance.variant = 'success';
    fixture.detectChanges();

    expect(roleOf()).toBe('status');
  });

  it('announces a warning politely too — nothing has failed yet', () => {
    fixture.componentInstance.variant = 'warning';
    fixture.detectChanges();

    expect(roleOf()).toBe('status');
  });

  it('keeps the assertive role for an error', () => {
    expect(roleOf()).toBe('alert');
  });
});

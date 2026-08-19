import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Alert } from './alert';

@Component({
  imports: [Alert],
  template: `<ui-alert [variant]="variant">Something went wrong.</ui-alert>`,
})
class HostComponent {
  variant: 'error' | 'success' = 'error';
}

describe('Alert', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders projected content with role="alert"', () => {
    const el = fixture.debugElement.query(By.css('[role="alert"]')).nativeElement as HTMLElement;
    expect(el.textContent).toContain('Something went wrong.');
  });
});

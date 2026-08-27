import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Toggle } from './toggle';

@Component({
  imports: [Toggle],
  template: `<ui-toggle
    [checked]="checked()"
    [label]="label"
    [disabled]="disabled"
    [pending]="pending"
    (toggled)="onToggled($event)"
  />`,
})
class HostComponent {
  readonly checked = signal(true);
  label = 'Deactivate Ikeja–Lekki Express';
  disabled = false;
  pending = false;
  received: boolean[] = [];

  onToggled(next: boolean): void {
    this.received.push(next);
  }
}

describe('Toggle', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function button(): HTMLButtonElement {
    return fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('exposes switch semantics on the real button, not the host', () => {
    // The host is `display: contents` — an aria attribute bound there
    // would be dropped from the accessibility tree entirely.
    expect(button().getAttribute('role')).toBe('switch');
    expect(button().getAttribute('aria-checked')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('Deactivate Ikeja–Lekki Express');
  });

  it('reflects aria-checked from the checked input', () => {
    host.checked.set(false);
    fixture.detectChanges();
    expect(button().getAttribute('aria-checked')).toBe('false');
  });

  it('emits the requested next state, not the current one', () => {
    button().click();
    expect(host.received).toEqual([false]);
  });

  it('does not emit while pending, so a double-click cannot double-submit', () => {
    host.pending = true;
    fixture.detectChanges();

    button().click();

    expect(button().disabled).toBeTrue();
    expect(host.received).toEqual([]);
  });

  it('stays driven by the input so a failed save can be rolled back', () => {
    button().click();
    fixture.detectChanges();
    // The caller never updated `checked`, so the switch must still read
    // as on — it holds no optimistic state of its own.
    expect(button().getAttribute('aria-checked')).toBe('true');
  });
});

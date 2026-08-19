import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Stat } from './stat';

@Component({
  imports: [Stat],
  template: `
    <ui-stat label="Business clearing" [hint]="hint">NGN 1,500.00</ui-stat>
  `,
})
class HostComponent {
  hint: string | null = null;
}

describe('Stat', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
  });

  it('renders the label and the projected value', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Business clearing');
    expect(el.textContent).toContain('NGN 1,500.00');
  });

  it('renders an optional hint below the value', () => {
    fixture.componentInstance.hint = 'Not yet settled';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Not yet settled');
  });

  it('omits the hint paragraph when none is given', () => {
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Not yet settled');
  });
});

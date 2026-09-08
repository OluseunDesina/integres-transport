import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { DensityToggle, type Density } from './density-toggle';

@Component({
  imports: [DensityToggle],
  template: `<ui-density-toggle [density]="density" (densityChange)="onChange($event)" />`,
})
class HostComponent {
  density: Density = 'comfortable';
  emitted: Density[] = [];

  onChange(next: Density): void {
    this.emitted.push(next);
  }
}

describe('DensityToggle', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const buttons = () => fixture.debugElement.queryAll(By.css('button'));
  const comfortable = () => buttons()[0].nativeElement as HTMLButtonElement;
  const compact = () => buttons()[1].nativeElement as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders both densities as real, individually labelled controls', () => {
    // Icon-only, so each needs its own accessible name — the icon is
    // aria-hidden inside ui-icon and contributes nothing.
    expect(comfortable().getAttribute('aria-label')).toBe('Comfortable rows');
    expect(compact().getAttribute('aria-label')).toBe('Compact rows');
  });

  it('marks the current density pressed and the other not', () => {
    expect(comfortable().getAttribute('aria-pressed')).toBe('true');
    expect(compact().getAttribute('aria-pressed')).toBe('false');
  });

  it('moves the pressed state when the density input changes', () => {
    host.density = 'compact';
    fixture.detectChanges();
    expect(comfortable().getAttribute('aria-pressed')).toBe('false');
    expect(compact().getAttribute('aria-pressed')).toBe('true');
  });

  it('emits the requested density rather than changing itself', () => {
    // Stateless by design: the caller decides whether the preference is
    // remembered, and where.
    compact().click();
    expect(host.emitted).toEqual(['compact']);
    expect(comfortable().getAttribute('aria-pressed')).toBe('true');
  });

  it('re-emits the density already selected', () => {
    // Not swallowed: a caller may treat it as "confirm", and swallowing
    // it would make the two buttons behave differently for no reason a
    // user can see.
    comfortable().click();
    expect(host.emitted).toEqual(['comfortable']);
  });

  it('gives the selected button the flippable on-primary token', () => {
    // The fill is the tenant's brand colour, so the text must use the
    // token BrandThemeService flips — the same defect ui-button shipped
    // once with text-on-solid.
    expect(comfortable().classList).toContain('text-on-primary');
    expect(comfortable().classList).not.toContain('text-on-solid');
  });

  it('is a labelled group', () => {
    const group = fixture.debugElement.query(By.css('[role="group"]')).nativeElement as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Row density');
  });

  it('meets the 44px minimum touch target on both buttons', () => {
    expect(comfortable().classList).toContain('min-h-11');
    expect(compact().classList).toContain('min-h-11');
  });
});

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Button } from './button';

@Component({
  imports: [Button],
  template: `<ui-button
    [variant]="variant"
    [disabled]="disabled"
    [loading]="loading"
    [ariaPressed]="ariaPressed"
    (pressed)="onPressed()"
    >Click me</ui-button
  >`,
})
class HostComponent {
  variant: 'primary' | 'secondary' | 'danger' = 'primary';
  disabled = false;
  loading = false;
  ariaPressed: boolean | null = null;
  pressCount = 0;

  onPressed(): void {
    this.pressCount++;
  }
}

describe('Button', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders projected content', () => {
    const button = fixture.debugElement.query(By.css('button'));
    expect(button.nativeElement.textContent).toContain('Click me');
  });

  it('emits pressed on click', () => {
    fixture.debugElement.query(By.css('button')).nativeElement.click();
    expect(host.pressCount).toBe(1);
  });

  it('disables the native button when disabled is true', () => {
    host.disabled = true;
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.disabled).toBeTrue();
  });

  it('disables the native button while loading', () => {
    host.loading = true;
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.disabled).toBeTrue();
  });

  it('applies danger styling for the danger variant', () => {
    host.variant = 'danger';
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.classList).toContain('bg-danger');
    expect(button.classList).not.toContain('bg-primary');
  });

  it('uses the flippable on-primary token for the primary variant', () => {
    // The primary fill is a white-labelled tenant's own colour, so its
    // text must use the token BrandThemeService flips to a dark ink when
    // white would fail AA. `text-on-solid` is fixed white and only safe
    // on fills we control.
    //
    // An earlier version used `on-solid` for both and shipped
    // white-on-#FFE066 buttons for a tenant with a pale brand — the token
    // flipped correctly, it just reached no text.
    host.variant = 'primary';
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.classList).toContain('text-on-primary');
    expect(button.classList).not.toContain('text-on-solid');
  });

  it('uses the fixed on-solid token for danger, whose fill we control', () => {
    host.variant = 'danger';
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.classList).toContain('text-on-solid');
    expect(button.classList).not.toContain('text-on-primary');
  });

  it('omits aria-pressed by default, for ordinary (non-toggle) buttons', () => {
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.hasAttribute('aria-pressed')).toBeFalse();
  });

  it('reflects ariaPressed on the real inner <button>, not just the ui-button wrapper', () => {
    host.ariaPressed = true;
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('true');

    host.ariaPressed = false;
    fixture.detectChanges();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('replaces variant colors with an explicit, non-opacity disabled treatment', () => {
    // Not opacity-50: blending any variant's color toward the page
    // background lands well under WCAG AA's 4.5:1 (confirmed via axe
    // during the Phase 2 self-check, on the paginator's disabled
    // Previous/Next buttons) — disabled state must use its own
    // explicit, proven-safe color pairing instead.
    host.disabled = true;
    fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
    expect(button.classList).toContain('bg-surface-sunken');
    expect(button.classList).toContain('text-default');
    expect(button.classList).not.toContain('bg-primary');
    expect(button.classList).not.toContain('text-on-solid');
  });
});

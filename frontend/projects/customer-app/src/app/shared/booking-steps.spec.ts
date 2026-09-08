import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';

import { BookingSteps } from './booking-steps';

describe('BookingSteps', () => {
  let fixture: ComponentFixture<BookingSteps>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [BookingSteps] }).compileComponents();
    fixture = TestBed.createComponent(BookingSteps);
  });

  function render(current: 'search' | 'seats' | 'confirm'): HTMLElement {
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('names all three steps in order', () => {
    const labels = Array.from(render('search').querySelectorAll('li')).map((li) =>
      li.textContent?.trim().replace(/\s+/g, ' ')
    );

    expect(labels).toEqual(['1 Find a trip', '2 Choose seats', '3 Review']);
  });

  // Payment is deliberately not a step: it happens later, from
  // my-bookings, often in a different session.
  it('stops at three steps and does not promise payment', () => {
    expect(render('confirm').querySelectorAll('li').length).toBe(3);
    expect(render('confirm').textContent).not.toContain('Pay');
  });

  it('marks exactly one step current, and it is the one asked for', () => {
    const current = render('seats').querySelectorAll('[aria-current="step"]');

    expect(current.length).toBe(1);
    expect(current[0].textContent?.trim()).toBe('Choose seats');
  });

  // The label is the first thing to be squeezed at 390px, so the
  // position has to survive independently of it.
  it('states the position for a screen reader without relying on the labels', () => {
    expect(render('seats').querySelector('nav')?.getAttribute('aria-label')).toBe(
      'Booking progress, step 2 of 3'
    );
  });

  it('is an ordered list, so the sequence is structural rather than visual', () => {
    expect(render('search').querySelector('ol')).not.toBeNull();
  });

  // Three labels plus three numerals plus two connectors do not fit
  // 390px — iteration-15 photographed "Revi...". Below `sm` the
  // inactive labels go sr-only rather than being truncated or dropped,
  // so a screen reader still hears all three.
  it('keeps every label readable to assistive technology when it hides them', () => {
    const host = render('seats');
    const labels = Array.from(host.querySelectorAll('li > span:nth-of-type(2)'));

    expect(labels.length).toBe(3);
    for (const label of labels) {
      const current = label.getAttribute('aria-current') === 'step';
      expect(label.classList.contains('sr-only')).toBe(!current);
      // ...and comes back at sm, so a wide screen names all three.
      expect(label.classList.contains('sm:not-sr-only')).toBe(!current);
      expect(label.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});

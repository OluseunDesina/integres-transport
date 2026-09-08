import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { RadioGroup } from './radio-group';
import type { SelectOption } from './select';

const DECISIONS: SelectOption[] = [
  { value: 'approve', label: 'Approve' },
  { value: 'reject', label: 'Reject' },
];

@Component({
  imports: [ReactiveFormsModule, RadioGroup],
  template: `
    <ui-radio-group
      label="Decision"
      [options]="options"
      [hint]="hint()"
      [invalid]="invalid()"
      [errorMessage]="errorMessage()"
      [formControl]="control"
    />
    <ui-radio-group label="Second group" [options]="options" [formControl]="other" />
    <ui-radio-group
      label="Segmented group"
      [options]="options"
      [segmented]="true"
      [formControl]="segmentedControl"
    />
  `,
})
class Host {
  readonly options = DECISIONS;
  readonly hint = signal<string | null>(null);
  readonly invalid = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly control = new FormControl('');
  readonly other = new FormControl('');
  readonly segmentedControl = new FormControl('');
}

describe('RadioGroup', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function groups(): HTMLFieldSetElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLFieldSetElement>('fieldset')
    );
  }

  function radios(index = 0): HTMLInputElement[] {
    return Array.from(groups()[index].querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  }

  /**
   * Native inputs sharing a `name`, not `role="radio"` on something
   * else. The browser gives arrow-key selection and one-Tab-stop
   * behaviour for free; a hand-rolled version announces as a radio group
   * and behaves as separate buttons.
   */
  it('renders real radio inputs that share one name', () => {
    const names = new Set(radios().map((input) => input.name));

    expect(radios().length).toBe(2);
    expect(names.size).toBe(1);
  });

  // Two groups on one screen sharing a name would silently deselect
  // each other, with nothing in the markup to show why.
  it('gives each group on a page its own name', () => {
    expect(radios(0)[0].name).not.toBe(radios(1)[0].name);
  });

  // A <legend> is announced when focus enters the group; an aria-label
  // on a div is not part of that contract.
  it('names the group with a real legend', () => {
    expect(groups()[0].querySelector('legend')?.textContent?.trim()).toBe('Decision');
  });

  it('associates every option label with its own input', () => {
    for (const input of radios()) {
      // The input is inside its <label>, which is the association.
      expect(input.closest('label')).not.toBeNull();
      expect(input.closest('label')?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('writes the chosen value through to the form control', () => {
    radios()[1].click();

    expect(host.control.value).toBe('reject');
  });

  it('checks the option the form already holds', () => {
    host.control.setValue('approve');
    fixture.detectChanges();

    expect(radios()[0].checked).toBeTrue();
    expect(radios()[1].checked).toBeFalse();
  });

  it('renders nothing until the parent says it is invalid', () => {
    host.errorMessage.set('Pick one.');
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Pick one.');
  });

  it('renders the error and points the group at it', () => {
    host.invalid.set(true);
    host.errorMessage.set('Pick one.');
    fixture.detectChanges();

    const error = groups()[0].querySelector('[role="alert"]');
    expect(error?.textContent?.trim()).toBe('Pick one.');
    expect(groups()[0].getAttribute('aria-describedby')).toContain(error?.id);
  });

  it('disables every option through the form', () => {
    host.control.disable();
    fixture.detectChanges();

    expect(radios().every((input) => input.disabled)).toBeTrue();
  });

  // WCAG 2.5.8: a 16px radio is well under the target minimum, so the
  // whole label row is the hit area.
  it('gives each option a full-height hit area', () => {
    expect(radios()[0].closest('label')?.className).toContain('min-h-11');
  });

  /**
   * The segmented variant is a skin, not a second implementation.
   * `validator-app`'s board/alight control was a `role="radiogroup"` div
   * wrapping two `ui-button`s with `aria-pressed` — it announced as a
   * radio group and behaved as two independent toggles. What makes this
   * correct is that the inputs are still native radios sharing a name;
   * they are only visually hidden.
   */
  describe('segmented', () => {
    it('is still real radios sharing one name', () => {
      const inputs = radios(2);

      expect(inputs.length).toBe(2);
      expect(inputs.every((input) => input.type === 'radio')).toBeTrue();
      expect(new Set(inputs.map((input) => input.name)).size).toBe(1);
    });

    it('hides the dot without hiding the control', () => {
      // `sr-only`, never `display: none` or `hidden` — either would take
      // the input out of the tab order and off the accessibility tree,
      // which is exactly the failure this variant exists to avoid.
      const input = radios(2)[0];

      expect(input.className).toContain('sr-only');
      expect(input.className).not.toContain('hidden');
      expect(getComputedStyle(input).display).not.toBe('none');
    });

    it('still writes through to the form control', () => {
      radios(2)[1].click();

      expect(host.segmentedControl.value).toBe('reject');
    });

    it('keeps the label as a large target', () => {
      const label = radios(2)[0].closest('label');

      expect(label?.className).toContain('min-h-11');
      expect(label?.className).toContain('justify-center');
    });

    it('marks the chosen segment visually, not only by checked state', () => {
      host.segmentedControl.setValue('approve');
      fixture.detectChanges();

      const [chosen, other] = radios(2).map((input) => input.closest('label'));
      expect(chosen?.className).toContain('bg-primary');
      expect(other?.className).not.toContain('bg-primary');
    });

    it('leaves the stacked variant alone', () => {
      expect(radios(0)[0].className).not.toContain('sr-only');
      expect(radios(0)[0].closest('label')?.className).not.toContain('justify-center');
    });
  });
});

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { FormSection } from './form-section';

@Component({
  imports: [FormSection],
  template: `<ui-form-section [title]="title" [description]="description">
    <input id="plate" />
  </ui-form-section>`,
})
class HostComponent {
  title = 'Compliance';
  description: string | null = 'Insurance and roadworthiness expiry dates.';
}

describe('FormSection', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const section = () => fixture.debugElement.query(By.css('section')).nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a real section, not a styled div', () => {
    // A landmark with a heading is what lets a screen-reader user jump
    // between groups in a long form the way a sighted eye does.
    expect(section()).not.toBeNull();
  });

  it('labels the section with its own heading', () => {
    const labelledBy = section().getAttribute('aria-labelledby');
    const headingEl = fixture.debugElement.query(By.css(`#${labelledBy}`))
      .nativeElement as HTMLElement;
    expect(headingEl.tagName).toBe('H2');
    expect(headingEl.textContent).toContain('Compliance');
  });

  it('describes the section with its description', () => {
    const describedBy = section().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = fixture.debugElement.query(By.css(`#${describedBy}`))
      .nativeElement as HTMLElement;
    expect(description.textContent).toContain('Insurance and roadworthiness');
  });

  it('omits aria-describedby when there is no description', () => {
    host.description = null;
    fixture.detectChanges();
    expect(section().hasAttribute('aria-describedby')).toBeFalse();
  });

  it('projects its fields', () => {
    expect(fixture.debugElement.query(By.css('section #plate'))).not.toBeNull();
  });

  it('uses a heading level below the page h1', () => {
    // A page has one h1 (ui-page-header); a section within it is an h2.
    // Getting this wrong breaks heading-order navigation, which axe
    // checks and which is the whole point of the landmark.
    expect(fixture.debugElement.queryAll(By.css('h1')).length).toBe(0);
    expect(fixture.debugElement.queryAll(By.css('h2')).length).toBe(1);
  });
});

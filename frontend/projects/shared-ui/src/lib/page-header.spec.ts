import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { PageHeader } from './page-header';

@Component({
  imports: [PageHeader],
  template: `<ui-page-header [title]="title" [description]="description">
    <nav breadcrumb aria-label="Breadcrumb"><a href="/vehicles">Vehicles</a></nav>
    <button actions type="button">New vehicle</button>
  </ui-page-header>`,
})
class HostComponent {
  title = 'Vehicles';
  description: string | null = 'Every vehicle registered against this business.';
}

describe('PageHeader', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const heading = () => fixture.debugElement.query(By.css('h1')).nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the title as the page h1', () => {
    expect(heading().textContent).toContain('Vehicles');
  });

  it('renders exactly one h1, so a screen has one document title', () => {
    expect(fixture.debugElement.queryAll(By.css('h1')).length).toBe(1);
  });

  it('projects breadcrumb and action content into their own slots', () => {
    // Slots rather than inputs: a breadcrumb is routerLink anchors and an
    // action is usually permission-gated, neither of which @shared-ui
    // may depend on.
    expect(fixture.debugElement.query(By.css('nav[breadcrumb] a'))).not.toBeNull();
    expect(fixture.debugElement.query(By.css('button[actions]'))).not.toBeNull();
  });

  it('associates the description with the heading for screen readers', () => {
    const describedBy = heading().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = fixture.debugElement.query(By.css(`#${describedBy}`));
    expect((description.nativeElement as HTMLElement).textContent).toContain(
      'Every vehicle registered',
    );
  });

  it('omits aria-describedby entirely when there is no description', () => {
    // Pointing at an element that does not exist is worse than pointing
    // at nothing — some screen readers announce it as an empty string.
    host.description = null;
    fixture.detectChanges();
    expect(heading().hasAttribute('aria-describedby')).toBeFalse();
    expect(fixture.debugElement.query(By.css('p'))).toBeNull();
  });

  it('gives each instance its own ids', () => {
    const second = TestBed.createComponent(HostComponent);
    second.detectChanges();
    const secondHeading = second.debugElement.query(By.css('h1')).nativeElement as HTMLElement;
    expect(secondHeading.id).not.toBe(heading().id);
  });
});

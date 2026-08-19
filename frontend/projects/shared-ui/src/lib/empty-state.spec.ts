import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { EmptyState } from './empty-state';
import { Button } from './button';

@Component({
  imports: [EmptyState, Button],
  template: `<ui-empty-state title="No businesses yet" description="Add your first business to get started.">
    <ui-button>Add business</ui-button>
  </ui-empty-state>`,
})
class HostComponent {}

describe('EmptyState', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders the title and description', () => {
    const heading = fixture.debugElement.query(By.css('h2')).nativeElement as HTMLElement;
    const description = fixture.debugElement.query(By.css('p')).nativeElement as HTMLElement;
    expect(heading.textContent).toContain('No businesses yet');
    expect(description.textContent).toContain('Add your first business to get started.');
  });

  it('renders projected action content', () => {
    const button = fixture.debugElement.query(By.css('button'));
    expect(button.nativeElement.textContent).toContain('Add business');
  });
});

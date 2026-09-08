import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Toolbar } from './toolbar';

@Component({
  imports: [Toolbar],
  template: `<ui-toolbar
    [selectedCount]="selectedCount"
    [itemLabel]="itemLabel"
    [itemLabelPlural]="itemLabelPlural"
    (cleared)="clearCount = clearCount + 1"
  >
    <button type="button">Deactivate</button>
  </ui-toolbar>`,
})
class HostComponent {
  selectedCount = 0;
  itemLabel = 'vehicle';
  itemLabelPlural: string | null = null;
  clearCount = 0;
}

describe('Toolbar', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const count = () => fixture.debugElement.query(By.css('p')).nativeElement as HTMLElement;
  const clearButton = () =>
    fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement as HTMLElement).textContent?.includes('Clear selection'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('says nothing is selected when nothing is', () => {
    expect(count().textContent).toContain('None selected');
  });

  it('uses the singular for one', () => {
    host.selectedCount = 1;
    fixture.detectChanges();
    expect(count().textContent).toContain('1 vehicle selected');
  });

  it('pluralises by default', () => {
    host.selectedCount = 3;
    fixture.detectChanges();
    expect(count().textContent).toContain('3 vehicles selected');
  });

  it('takes an explicit plural where appending "s" would be wrong', () => {
    host.selectedCount = 2;
    host.itemLabel = 'bus';
    host.itemLabelPlural = 'buses';
    fixture.detectChanges();
    expect(count().textContent).toContain('2 buses selected');
  });

  it('announces the count politely as the selection changes', () => {
    // Ticking a row checkbox renders its result only here — without the
    // live region a screen-reader user gets no feedback that it moved.
    expect(count().getAttribute('aria-live')).toBe('polite');
  });

  it('offers a way out of a selection only when there is one', () => {
    expect(clearButton()).toBeUndefined();
    host.selectedCount = 2;
    fixture.detectChanges();
    expect(clearButton()).toBeDefined();
  });

  it('emits cleared when the escape hatch is used', () => {
    host.selectedCount = 2;
    fixture.detectChanges();
    (clearButton()!.nativeElement as HTMLButtonElement).click();
    expect(host.clearCount).toBe(1);
  });

  it('projects contextual actions', () => {
    expect(fixture.nativeElement.textContent).toContain('Deactivate');
  });

  it('is a labelled group, deliberately not role="toolbar"', () => {
    // role="toolbar" promises arrow-key roving focus across its
    // controls, which cannot be honoured for projected content this
    // component has no handle on. A promise that does not hold is worse
    // for a screen-reader user than no role at all.
    const group = fixture.debugElement.query(By.css('[role]')).nativeElement as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Table actions');
    expect(fixture.debugElement.query(By.css('[role="toolbar"]'))).toBeNull();
  });
});

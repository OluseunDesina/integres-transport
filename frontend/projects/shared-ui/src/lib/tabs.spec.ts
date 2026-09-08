import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Tabs, type TabItem } from './tabs';

@Component({
  imports: [Tabs],
  template: `<ui-tabs
    [tabs]="tabs"
    [activeId]="activeId"
    ariaLabel="Vehicle sections"
    (activeIdChange)="onChange($event)"
  >
    <p>Panel body</p>
  </ui-tabs>`,
})
class HostComponent {
  tabs: TabItem[] = [
    { id: 'details', label: 'Details' },
    { id: 'compliance', label: 'Compliance' },
    { id: 'history', label: 'History' },
  ];
  activeId = 'details';
  emitted: string[] = [];

  onChange(id: string): void {
    this.emitted.push(id);
    this.activeId = id;
  }
}

describe('Tabs', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const tabs = () => fixture.debugElement.queryAll(By.css('[role="tab"]'));
  const tabAt = (i: number) => tabs()[i].nativeElement as HTMLButtonElement;
  const tabList = () =>
    fixture.debugElement.query(By.css('[role="tablist"]')).nativeElement as HTMLElement;
  const panel = () =>
    fixture.debugElement.query(By.css('[role="tabpanel"]')).nativeElement as HTMLElement;

  /** Keys go to the *selected* tab, which is where focus lives under a
   * roving tabindex — the tablist itself is not focusable. */
  const press = (key: string) => {
    const selected = tabs().find(
      (tab) => (tab.nativeElement as HTMLElement).getAttribute('aria-selected') === 'true',
    );
    (selected ?? tabs()[0]).nativeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a tab per item inside a labelled tablist', () => {
    expect(tabs().length).toBe(3);
    expect(tabList().getAttribute('aria-label')).toBe('Vehicle sections');
  });

  it('listens for keys on the tabs, not on the unfocusable tablist', () => {
    // A key listener on a container that can never hold focus only fires
    // by accident of bubbling.
    expect(tabList().hasAttribute('tabindex')).toBeFalse();
    tabList().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();
    expect(host.emitted).toEqual([]);
  });

  it('marks exactly one tab selected', () => {
    const selected = tabs().filter(
      (tab) => (tab.nativeElement as HTMLElement).getAttribute('aria-selected') === 'true',
    );
    expect(selected.length).toBe(1);
    expect((selected[0].nativeElement as HTMLElement).textContent).toContain('Details');
  });

  it('keeps exactly one tab in the tab order', () => {
    // Roving tabindex: Tab should reach the tab list once and then move
    // on to the panel, not step through every tab.
    const tabbable = tabs().filter((tab) => (tab.nativeElement as HTMLElement).tabIndex === 0);
    expect(tabbable.length).toBe(1);
    expect(tabAt(0).tabIndex).toBe(0);
    expect(tabAt(1).tabIndex).toBe(-1);
  });

  it('points aria-controls at the panel only from the selected tab', () => {
    // One shared panel element means an unselected tab controls nothing
    // that exists, and must not claim to.
    expect(tabAt(0).getAttribute('aria-controls')).toBe(panel().id);
    expect(tabAt(1).hasAttribute('aria-controls')).toBeFalse();
  });

  it('labels the panel with the selected tab', () => {
    expect(panel().getAttribute('aria-labelledby')).toBe(tabAt(0).id);
  });

  it('makes the panel focusable so keyboard users reach its content', () => {
    expect(panel().tabIndex).toBe(0);
  });

  it('projects the panel content', () => {
    expect(panel().textContent).toContain('Panel body');
  });

  it('emits on click', () => {
    tabAt(1).click();
    expect(host.emitted).toEqual(['compliance']);
  });

  it('does not re-emit for the tab already selected', () => {
    tabAt(0).click();
    expect(host.emitted).toEqual([]);
  });

  it('moves selection right on ArrowRight', () => {
    press('ArrowRight');
    expect(host.emitted).toEqual(['compliance']);
    expect(tabAt(1).getAttribute('aria-selected')).toBe('true');
  });

  it('moves focus with selection, so the keyboard user follows the panel', () => {
    press('ArrowRight');
    expect(document.activeElement).toBe(tabAt(1));
  });

  it('wraps from the last tab to the first', () => {
    host.activeId = 'history';
    fixture.detectChanges();
    press('ArrowRight');
    expect(host.emitted).toEqual(['details']);
  });

  it('wraps backwards from the first tab to the last', () => {
    press('ArrowLeft');
    expect(host.emitted).toEqual(['history']);
  });

  it('jumps to the first and last tab with Home and End', () => {
    press('End');
    expect(host.emitted).toEqual(['history']);
    press('Home');
    expect(host.emitted).toEqual(['history', 'details']);
  });

  it('ignores keys it does not own', () => {
    press('ArrowDown');
    expect(host.emitted).toEqual([]);
  });

  it('skips a disabled tab when arrowing', () => {
    host.tabs = [
      { id: 'details', label: 'Details' },
      { id: 'compliance', label: 'Compliance', disabled: true },
      { id: 'history', label: 'History' },
    ];
    fixture.detectChanges();
    press('ArrowRight');
    expect(host.emitted).toEqual(['history']);
  });

  it('refuses to select a disabled tab by click', () => {
    host.tabs = [
      { id: 'details', label: 'Details' },
      { id: 'compliance', label: 'Compliance', disabled: true },
    ];
    fixture.detectChanges();
    tabAt(1).click();
    expect(host.emitted).toEqual([]);
    expect(tabAt(1).getAttribute('aria-disabled')).toBe('true');
  });

  it('does nothing on arrow keys when every tab is disabled', () => {
    host.tabs = [{ id: 'details', label: 'Details', disabled: true }];
    fixture.detectChanges();
    expect(() => press('ArrowRight')).not.toThrow();
    expect(host.emitted).toEqual([]);
  });

  it('gives each instance its own panel id', () => {
    const second = TestBed.createComponent(HostComponent);
    second.detectChanges();
    const secondPanel = second.debugElement.query(By.css('[role="tabpanel"]'))
      .nativeElement as HTMLElement;
    expect(secondPanel.id).not.toBe(panel().id);
  });
});

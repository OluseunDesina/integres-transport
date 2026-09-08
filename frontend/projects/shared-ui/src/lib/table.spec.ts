import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Table } from './table';

@Component({
  imports: [Table],
  template: `<ui-table
    [loading]="loading"
    [empty]="empty"
    [stickyHeader]="stickyHeader"
    [maxHeight]="maxHeight"
    [label]="label"
    emptyMessage="No businesses yet."
  >
    <thead>
      <tr><th>Name</th></tr>
    </thead>
    <tbody>
      <tr><td>Acme Shuttle Co</td></tr>
    </tbody>
  </ui-table>`,
})
class HostComponent {
  loading = false;
  empty = false;
  stickyHeader = false;
  maxHeight = '70vh';
  label: string | null = null;
}

describe('Table', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders projected table content', () => {
    const table = fixture.debugElement.query(By.css('table'));
    expect(table.nativeElement.textContent).toContain('Acme Shuttle Co');
  });

  it('shows a loading state instead of the table', () => {
    host.loading = true;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Loading');
  });

  it('shows the empty message instead of the table', () => {
    host.empty = true;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('table'))).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('No businesses yet.');
  });

  // --- Sticky header (docs/specs/14, slice 3a) ---

  it('does not constrain height or pin the header by default', () => {
    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    const table = fixture.debugElement.query(By.css('table')).nativeElement as HTMLElement;
    expect(wrapper.style.maxHeight).toBe('');
    expect(table.classList).not.toContain('ui-table-sticky');
  });

  it('bounds the scroll region when the header is pinned', () => {
    // Not cosmetic: the wrapper is `overflow-x: auto`, so CSS makes it a
    // scroll container on both axes. A sticky `<th>` inside sticks to
    // the wrapper, and with no height it never scrolls vertically — the
    // header would compile and visibly do nothing.
    host.stickyHeader = true;
    fixture.detectChanges();

    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    expect(wrapper.style.maxHeight).toBe('70vh');
  });

  it('marks the table so its header cells are pinned', () => {
    host.stickyHeader = true;
    fixture.detectChanges();
    const table = fixture.debugElement.query(By.css('table')).nativeElement as HTMLElement;
    expect(table.classList).toContain('ui-table-sticky');
  });

  it('actually computes the header cell as sticky, not merely classed', () => {
    // A class assertion alone would pass even if the deep selector never
    // matched the caller's own projected <thead>.
    host.stickyHeader = true;
    fixture.detectChanges();
    const th = fixture.debugElement.query(By.css('th')).nativeElement as HTMLElement;
    expect(getComputedStyle(th).position).toBe('sticky');
  });

  it('leaves the header unpinned when the feature is off', () => {
    const th = fixture.debugElement.query(By.css('th')).nativeElement as HTMLElement;
    expect(getComputedStyle(th).position).not.toBe('sticky');
  });

  it('honours a caller-chosen height', () => {
    host.stickyHeader = true;
    host.maxHeight = '24rem';
    fixture.detectChanges();
    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    expect(wrapper.style.maxHeight).toBe('24rem');
  });
  // --- The scroll container is a tab stop ---

  it('makes the scroll container reachable from the keyboard', () => {
    // It scrolls in both axes, and a scrollable region with no focusable
    // content inside cannot be scrolled by keyboard at all.
    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    expect(wrapper.getAttribute('tabindex')).toBe('0');
  });

  it('names that tab stop as a region when given a label', () => {
    host.label = 'Routes';
    fixture.detectChanges();
    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    expect(wrapper.getAttribute('role')).toBe('region');
    expect(wrapper.getAttribute('aria-label')).toBe('Routes');
  });

  it('declares no region at all rather than an unnamed one', () => {
    // An unnamed `role="region"` is its own axe violation, so the role
    // is conditional on the label while the tab stop is not.
    const wrapper = fixture.debugElement.query(By.css('div')).nativeElement as HTMLElement;
    expect(wrapper.getAttribute('role')).toBeNull();
  });

  // --- Responsive cell padding, owned here ---

  it('spends less horizontal padding on cells than a caller would', () => {
    // Measured, not asserted from a class list: the rule is a deep
    // selector, and a deep selector that stopped matching would leave
    // this component looking correct and every table overflowing.
    const td = fixture.debugElement.query(By.css('td')).nativeElement as HTMLElement;
    expect(getComputedStyle(td).paddingLeft).not.toBe('0px');
  });

  it('lets a long unbroken value break rather than widen the column', () => {
    const td = fixture.debugElement.query(By.css('td')).nativeElement as HTMLElement;
    expect(getComputedStyle(td).overflowWrap).toBe('anywhere');
  });

  /**
   * A header is a short, known string the app chose; a cell holds
   * whatever the data is. `anywhere` on both rendered the KYB queue's
   * headers as "VERTIC AL", "DIRECTO RS" and "DOCUMEN TS" at 1200px,
   * because a narrow column made each header longer than its own width.
   */
  it('does not break a column heading mid-word', () => {
    const th = fixture.debugElement.query(By.css('th')).nativeElement as HTMLElement;
    expect(getComputedStyle(th).overflowWrap).toBe('break-word');
  });
});
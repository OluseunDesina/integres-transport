import { Component } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { FilterBar, type FilterChip } from './filter-bar';

@Component({
  imports: [FilterBar],
  template: `<ui-filter-bar
    [showSearch]="showSearch"
    [searchValue]="searchValue"
    [chips]="chips"
    [debounceMs]="debounceMs"
    (searchChange)="searches.push($event)"
    (chipRemoved)="removed.push($event)"
    (cleared)="clearCount = clearCount + 1"
  >
    <select filters aria-label="Status"><option>Active</option></select>
  </ui-filter-bar>`,
})
class HostComponent {
  showSearch = true;
  searchValue = '';
  chips: FilterChip[] = [];
  debounceMs = 300;
  searches: string[] = [];
  removed: string[] = [];
  clearCount = 0;
}

describe('FilterBar', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const search = () =>
    fixture.debugElement.query(By.css('input[type="search"]')).nativeElement as HTMLInputElement;
  const chipButtons = () =>
    fixture.debugElement
      .queryAll(By.css('button'))
      .filter((el) =>
        (el.nativeElement as HTMLElement).getAttribute('aria-label')?.startsWith('Remove filter'),
      );
  const clearAll = () =>
    fixture.debugElement
      .queryAll(By.css('button'))
      .find((el) => (el.nativeElement as HTMLElement).textContent?.includes('Clear all'));

  const type = (value: string) => {
    search().value = value;
    search().dispatchEvent(new Event('input'));
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is a search landmark, so a keyboard user can jump to it', () => {
    const region = fixture.debugElement.query(By.css('[role="search"]')).nativeElement as HTMLElement;
    expect(region.getAttribute('aria-label')).toBe('Filters');
  });

  it('labels the search input visibly, so it aligns with its siblings', () => {
    // Slice 3a's F2: an sr-only label here left the search box sitting
    // at a different height from the labelled selects beside it.
    const label = fixture.debugElement.query(By.css('label')).nativeElement as HTMLLabelElement;
    expect(label.htmlFor).toBe(search().id);
    expect(label.classList).not.toContain('sr-only');
    expect(label.textContent).toContain('Search');
  });

  it('projects caller-owned filter controls', () => {
    expect(fixture.debugElement.query(By.css('select[filters]'))).not.toBeNull();
  });

  it('debounces search so a list store is not refetched per keystroke', fakeAsync(() => {
    type('L');
    type('LA');
    type('LAG');
    expect(host.searches).toEqual([]);

    tick(300);
    expect(host.searches).toEqual(['LAG']);
  }));

  it('does not emit before the debounce elapses', fakeAsync(() => {
    type('LAG');
    tick(299);
    expect(host.searches).toEqual([]);
    tick(1);
    expect(host.searches).toEqual(['LAG']);
  }));

  it('emits synchronously when debouncing is switched off', () => {
    host.debounceMs = 0;
    fixture.detectChanges();
    type('LAG');
    expect(host.searches).toEqual(['LAG']);
  });

  it('emits an empty string when the search is cleared', fakeAsync(() => {
    // The clear affordance on a type="search" input fires `input` with
    // an empty value; swallowing it would leave the list filtered with
    // an empty box, which reads as a bug.
    type('LAG');
    tick(300);
    type('');
    tick(300);
    expect(host.searches).toEqual(['LAG', '']);
  }));

  it('drops a pending emission when the component is destroyed', fakeAsync(() => {
    type('LAG');
    fixture.destroy();
    tick(300);
    expect(host.searches).toEqual([]);
  }));

  it('renders no chip row when nothing is filtered', () => {
    expect(chipButtons().length).toBe(0);
  });

  it('renders a chip per active filter, naming both filter and value', () => {
    host.chips = [
      { id: 'status', label: 'Status', value: 'Active' },
      { id: 'business', label: 'Business', value: 'Lagos Shuttle' },
    ];
    fixture.detectChanges();

    expect(chipButtons().length).toBe(2);
    const first = chipButtons()[0].nativeElement as HTMLElement;
    expect(first.textContent).toContain('Status: Active');
    expect(first.getAttribute('aria-label')).toBe('Remove filter Status: Active');
  });

  it('emits the chip id on removal', () => {
    host.chips = [{ id: 'status', label: 'Status', value: 'Active' }];
    fixture.detectChanges();
    (chipButtons()[0].nativeElement as HTMLButtonElement).click();
    expect(host.removed).toEqual(['status']);
  });

  it('offers clear-all only once there is more than one filter to clear', () => {
    // With a single chip its own remove button already is "clear all";
    // two controls doing the same thing side by side is noise.
    host.chips = [{ id: 'status', label: 'Status', value: 'Active' }];
    fixture.detectChanges();
    expect(clearAll()).toBeUndefined();

    host.chips = [
      { id: 'status', label: 'Status', value: 'Active' },
      { id: 'business', label: 'Business', value: 'Lagos Shuttle' },
    ];
    fixture.detectChanges();
    expect(clearAll()).toBeDefined();
  });

  it('emits cleared from clear-all', () => {
    host.chips = [
      { id: 'status', label: 'Status', value: 'Active' },
      { id: 'business', label: 'Business', value: 'Lagos Shuttle' },
    ];
    fixture.detectChanges();
    (clearAll()!.nativeElement as HTMLButtonElement).click();
    expect(host.clearCount).toBe(1);
  });

  it('sizes the search box from the surface profile', () => {
    expect(search().style.minHeight).toBe('var(--ui-control-height)');
  });

  it('renders no search input when the list has no server-side search', () => {
    // A box that silently ignores what is typed into it is worse than no
    // box — the pay-as-you-go journeys screen shipped exactly that for
    // one iteration of slice 3b before the visual pass caught it.
    host.showSearch = false;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('input[type="search"]'))).toBeNull();
  });

  it('still renders its filters and chips without a search box', () => {
    host.showSearch = false;
    host.chips = [{ id: 'status', label: 'Status', value: 'Open' }];
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('select[filters]'))).not.toBeNull();
    expect(chipButtons().length).toBe(1);
  });
});

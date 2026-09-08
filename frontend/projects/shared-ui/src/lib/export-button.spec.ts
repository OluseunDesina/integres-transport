import { Component } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import {
  ExportButton,
  type ExportFormat,
  type ExportRequest,
  type ExportScope,
} from './export-button';

@Component({
  imports: [ExportButton],
  template: `<ui-export-button
    [formats]="formats"
    [pending]="pending"
    [disabled]="disabled"
    [viewGroupLabel]="viewGroupLabel"
    [scopes]="scopes"
    (exportRequested)="requests.push($event)"
  />`,
})
class HostComponent {
  formats: ExportFormat[] = ['csv', 'xlsx'];
  pending = false;
  disabled = false;
  viewGroupLabel = 'Current page';
  scopes: ExportScope[] = ['view', 'all'];
  requests: ExportRequest[] = [];
}

describe('ExportButton', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const trigger = () =>
    fixture.debugElement.query(By.css('button')).nativeElement as HTMLButtonElement;
  const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

  const open = () => {
    trigger().click();
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('offers every format in both scopes', () => {
    // The scope choice is the point: "Export" alone on a filtered,
    // paginated list silently produces the wrong row count either way.
    open();
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual([
      'CSV',
      'Excel',
      'CSV',
      'Excel',
    ]);
  });

  it('separates the two scopes into named groups', () => {
    open();
    const groups = Array.from(document.querySelectorAll('[role="group"]'));
    expect(groups.length).toBe(2);
    const menuText = document.querySelector('[role="menu"]')!.textContent ?? '';
    expect(menuText).toContain('Current page');
    expect(menuText).toContain('All results');
  });

  it('emits the format and the scope together', fakeAsync(() => {
    open();
    menuItems()[1].click();
    fixture.detectChanges();
    tick();
    expect(host.requests).toEqual([{ format: 'xlsx', scope: 'view' }]);
  }));

  it('emits the all-results scope from the second group', fakeAsync(() => {
    open();
    menuItems()[2].click();
    fixture.detectChanges();
    tick();
    expect(host.requests).toEqual([{ format: 'csv', scope: 'all' }]);
  }));

  it('waits for the menu to close before emitting', fakeAsync(() => {
    // Same ordering contract as ui-action-menu: CDK emits `triggered`
    // before it closes the menu, so a handler opening a dialog would
    // capture a doomed focus target.
    open();
    menuItems()[0].click();
    fixture.detectChanges();
    expect(host.requests).toEqual([]);

    tick();
    expect(host.requests.length).toBe(1);
    expect(document.activeElement).toBe(trigger());
  }));

  it('defaults to CSV only', () => {
    host.formats = ['csv'];
    fixture.detectChanges();
    open();
    expect(menuItems().length).toBe(2);
  });

  it('shows the waiting state and refuses to be reopened while exporting', () => {
    // Requesting the same export twice while the first is still running
    // is the most likely double-click on this control.
    host.pending = true;
    fixture.detectChanges();
    expect(trigger().textContent).toContain('Exporting…');
    expect(trigger().disabled).toBeTrue();
    open();
    expect(menuItems().length).toBe(0);
  });

  it('cannot be opened while disabled', () => {
    host.disabled = true;
    fixture.detectChanges();
    expect(trigger().disabled).toBeTrue();
    open();
    expect(menuItems().length).toBe(0);
  });

  it('returns focus to its trigger on close', () => {
    open();
    menuItems()[0].click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger());
  });

  it('names what "this view" means, rather than leaving it vague', () => {
    open();
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('Current page');
  });

  describe('a single scope', () => {
    // Spec 16 slice 4's screens export from the backend using the
    // caller's active filters, so "Current view" and "All results" would
    // be two menu items producing byte-identical files. Offering a
    // choice that does not exist is worse than offering none.

    beforeEach(() => {
      host.scopes = ['all'];
      host.formats = ['csv'];
      fixture.detectChanges();
    });

    it('renders one item per format and no second group', () => {
      open();
      expect(menuItems().length).toBe(1);
      expect(menuItems()[0].textContent!.trim()).toBe('CSV');
    });

    it('drops the group headings, which label nothing when there is one group', () => {
      open();
      const text = document.querySelector('[role="menu"]')!.textContent!;
      expect(text).not.toContain('Current page');
      expect(text).not.toContain('All results');
    });

    it('still emits the scope it was given', fakeAsync(() => {
      open();
      menuItems()[0].click();
      tick();
      expect(host.requests).toEqual([{ format: 'csv', scope: 'all' }]);
    }));
  });
});

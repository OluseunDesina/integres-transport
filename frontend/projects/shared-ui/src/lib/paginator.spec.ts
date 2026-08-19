import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { Page } from '@shared-data';

import { Paginator } from './paginator';

@Component({
  imports: [Paginator],
  template: `<ui-paginator [total]="total" [page]="page" (pageChange)="onPageChange($event)" />`,
})
class HostComponent {
  total = 60;
  page: Page = { limit: 25, offset: 25 };
  lastOffset: number | null = null;

  onPageChange(offset: number): void {
    this.lastOffset = offset;
  }
}

describe('Paginator', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders a 1-indexed range label', () => {
    expect(fixture.nativeElement.textContent).toContain('26–50 of 60');
  });

  it('shows 0 of 0 when total is zero', () => {
    host.total = 0;
    host.page = { limit: 25, offset: 0 };
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('0 of 0');
  });

  it('emits the previous offset when Previous is pressed', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button'));
    buttons[0].nativeElement.click();

    expect(host.lastOffset).toBe(0);
  });

  it('emits the next offset when Next is pressed', () => {
    const buttons = fixture.debugElement.queryAll(By.css('button'));
    buttons[1].nativeElement.click();

    expect(host.lastOffset).toBe(50);
  });

  it('disables Next on the last page', () => {
    host.page = { limit: 25, offset: 50 };
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    expect((buttons[1].nativeElement as HTMLButtonElement).disabled).toBeTrue();
  });

  it('disables Previous on the first page', () => {
    host.page = { limit: 25, offset: 0 };
    fixture.detectChanges();

    const buttons = fixture.debugElement.queryAll(By.css('button'));
    expect((buttons[0].nativeElement as HTMLButtonElement).disabled).toBeTrue();
  });
});

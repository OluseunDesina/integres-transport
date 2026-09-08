import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { Skeleton, type SkeletonVariant } from './skeleton';

@Component({
  imports: [Skeleton],
  template: `<ui-skeleton
    [variant]="variant"
    [lines]="lines"
    [width]="width"
    [height]="height"
  />`,
})
class HostComponent {
  variant: SkeletonVariant = 'text';
  lines = 1;
  width = '100%';
  height: string | null = null;
}

describe('Skeleton', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const bars = () => fixture.debugElement.queryAll(By.css('.animate-pulse'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders one bar by default', () => {
    expect(bars().length).toBe(1);
  });

  it('renders one bar per requested line', () => {
    host.lines = 4;
    fixture.detectChanges();
    expect(bars().length).toBe(4);
  });

  it('is hidden from assistive technology', () => {
    // The announcement belongs on the region being loaded, via
    // aria-busy — a table skeleton emits eight of these at once, and
    // eight announcements of one wait is worse than none.
    const container = fixture.debugElement.query(By.css('div[aria-hidden]'));
    expect(container.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('shortens the last line of multi-line text, so it reads as prose', () => {
    host.lines = 3;
    fixture.detectChanges();
    const widths = bars().map((bar) => (bar.nativeElement as HTMLElement).style.width);
    expect(widths).toEqual(['100%', '100%', '60%']);
  });

  it('keeps every bar full width for a single line', () => {
    expect((bars()[0].nativeElement as HTMLElement).style.width).toBe('100%');
  });

  it('does not shorten the last bar of a non-text variant', () => {
    // "Ends mid-line" is a property of prose, not of an avatar stack.
    host.variant = 'circle';
    host.lines = 2;
    fixture.detectChanges();
    const widths = bars().map((bar) => (bar.nativeElement as HTMLElement).style.width);
    expect(widths).toEqual(['100%', '100%']);
  });

  it('sizes a text line off the surface profile so layout does not jump', () => {
    expect((bars()[0].nativeElement as HTMLElement).style.height).toBe(
      'calc(var(--ui-text-body) * 1.5)',
    );
  });

  it('makes a circle as tall as it is wide', () => {
    host.variant = 'circle';
    host.width = '2.5rem';
    fixture.detectChanges();
    const bar = bars()[0].nativeElement as HTMLElement;
    expect(bar.style.height).toBe('2.5rem');
    expect(bar.classList).toContain('rounded-full');
  });

  it('lets an explicit height override the variant default', () => {
    host.variant = 'block';
    host.height = '12rem';
    fixture.detectChanges();
    expect((bars()[0].nativeElement as HTMLElement).style.height).toBe('12rem');
  });

  it('never renders zero bars, however few lines are asked for', () => {
    host.lines = 0;
    fixture.detectChanges();
    expect(bars().length).toBe(1);
  });
});

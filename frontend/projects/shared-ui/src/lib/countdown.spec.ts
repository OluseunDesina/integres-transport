import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Countdown } from './countdown';

@Component({
  imports: [Countdown],
  template: `<ui-countdown [secondsRemaining]="seconds()" (expired)="expiredCount.set(expiredCount() + 1)" />`,
})
class HostComponent {
  readonly seconds = signal<number | null>(null);
  readonly expiredCount = signal(0);
}

describe('Countdown', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function liveRegion(): HTMLElement | null {
    return el().querySelector('[aria-live]');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('renders nothing when secondsRemaining is null', () => {
    fixture.detectChanges();
    expect(el().textContent?.trim()).toBe('');
  });

  it('renders the duration from seconds, not a timestamp', () => {
    host.seconds.set(125);
    fixture.detectChanges();
    expect(el().textContent).toContain('2:05');
  });

  it('ticks down once a second via the shared clock', () => {
    jasmine.clock().install();
    host.seconds.set(3);
    fixture.detectChanges();
    expect(el().textContent).toContain('0:03');

    jasmine.clock().tick(1000);
    fixture.detectChanges();
    expect(el().textContent).toContain('0:02');

    jasmine.clock().tick(1000);
    fixture.detectChanges();
    expect(el().textContent).toContain('0:01');
  });

  it('changes text and style under two minutes, not colour alone', () => {
    host.seconds.set(121);
    fixture.detectChanges();
    expect(el().textContent).toContain('Held for');
    expect(el().querySelector('.text-warning')).toBeNull();

    host.seconds.set(120);
    fixture.detectChanges();
    expect(el().textContent).toContain('Expiring soon');
    expect(el().querySelector('.text-warning')).not.toBeNull();
  });

  it('announces the live region only at coarse thresholds, not every tick', () => {
    jasmine.clock().install();
    host.seconds.set(302);
    fixture.detectChanges();
    expect(liveRegion()?.textContent?.trim()).toBe('');

    jasmine.clock().tick(1000); // 301 — not a threshold
    fixture.detectChanges();
    expect(liveRegion()?.textContent?.trim()).toBe('');

    jasmine.clock().tick(1000); // 300 — a threshold
    fixture.detectChanges();
    expect(liveRegion()?.textContent).toContain('5:00');

    const messageAt300 = liveRegion()?.textContent;
    jasmine.clock().tick(1000); // 299 — not a threshold again
    fixture.detectChanges();
    expect(liveRegion()?.textContent).toBe(messageAt300);
  });

  it('emits expired and stops ticking at zero, without asserting the hold is gone', () => {
    jasmine.clock().install();
    host.seconds.set(1);
    fixture.detectChanges();

    jasmine.clock().tick(1000);
    fixture.detectChanges();
    expect(host.expiredCount()).toBe(1);
    // Not "Hold expired" as a fact — the consumer's re-fetch decides that.
    expect(el().textContent).toContain('Hold expiring');

    jasmine.clock().tick(5000);
    fixture.detectChanges();
    expect(host.expiredCount()).toBe(1);
  });

  it('resets to a fresh value if the input changes after reaching zero', () => {
    jasmine.clock().install();
    host.seconds.set(1);
    fixture.detectChanges();
    jasmine.clock().tick(1000);
    fixture.detectChanges();

    host.seconds.set(60);
    fixture.detectChanges();
    expect(el().textContent).toContain('1:00');

    jasmine.clock().tick(1000);
    fixture.detectChanges();
    expect(el().textContent).toContain('0:59');
  });

  it('stops ticking once destroyed', () => {
    jasmine.clock().install();
    host.seconds.set(10);
    fixture.detectChanges();

    fixture.destroy();
    expect(() => jasmine.clock().tick(5000)).not.toThrow();
  });
});

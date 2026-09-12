import { TestBed } from '@angular/core/testing';

import { CountdownClock } from './countdown-clock';

describe('CountdownClock', () => {
  let visibleSpy: jasmine.Spy;
  let clock: CountdownClock;

  function setHidden(hidden: boolean): void {
    visibleSpy.and.returnValue(hidden);
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    visibleSpy = spyOnProperty(document, 'hidden').and.returnValue(false);
    clock = TestBed.inject(CountdownClock);
  });

  it('ticks every subscriber once a second', () => {
    jasmine.clock().install();
    try {
      const a = jasmine.createSpy('a');
      const b = jasmine.createSpy('b');
      clock.subscribe(a);
      clock.subscribe(b);

      jasmine.clock().tick(1000);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      jasmine.clock().tick(1000);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('stops ticking once every subscriber has unsubscribed', () => {
    jasmine.clock().install();
    try {
      const callback = jasmine.createSpy('callback');
      const unsubscribe = clock.subscribe(callback);

      jasmine.clock().tick(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      jasmine.clock().tick(3000);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('keeps ticking a second subscriber after a first one unsubscribes', () => {
    jasmine.clock().install();
    try {
      const a = jasmine.createSpy('a');
      const b = jasmine.createSpy('b');
      const unsubscribeA = clock.subscribe(a);
      clock.subscribe(b);

      unsubscribeA();
      jasmine.clock().tick(1000);
      expect(a).toHaveBeenCalledTimes(0);
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('pauses while the tab is hidden and resumes without a burst of catch-up ticks', () => {
    jasmine.clock().install();
    try {
      const callback = jasmine.createSpy('callback');
      clock.subscribe(callback);

      jasmine.clock().tick(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      setHidden(true);
      jasmine.clock().tick(5000);
      expect(callback).toHaveBeenCalledTimes(1);

      setHidden(false);
      jasmine.clock().tick(1000);
      expect(callback).toHaveBeenCalledTimes(2);
    } finally {
      jasmine.clock().uninstall();
    }
  });
});

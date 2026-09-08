import { fakeAsync, tick as flushTick } from '@angular/core/testing';

import { Poller } from './poller';

describe('Poller', () => {
  let visibleSpy: jasmine.Spy;

  function setHidden(hidden: boolean): void {
    visibleSpy.and.returnValue(hidden);
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    visibleSpy = spyOnProperty(document, 'hidden').and.returnValue(false);
  });

  it(
    'ticks immediately on start, then on the interval',
    fakeAsync(() => {
      const tick = jasmine.createSpy('tick').and.resolveTo();
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      expect(tick).toHaveBeenCalledTimes(1);

      flushTick(1000);
      expect(tick).toHaveBeenCalledTimes(2);

      flushTick(1000);
      expect(tick).toHaveBeenCalledTimes(3);

      poller.destroy();
    })
  );

  it(
    'does not stack a second tick while one is still in flight',
    fakeAsync(() => {
      let resolvePending!: () => void;
      const tick = jasmine
        .createSpy('tick')
        .and.callFake(() => new Promise<void>((resolve) => (resolvePending = resolve)));
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      expect(tick).toHaveBeenCalledTimes(1);

      // The interval elapses while the first tick is still pending — a
      // slow response must not queue a second request behind it.
      flushTick(5000);
      expect(tick).toHaveBeenCalledTimes(1);

      resolvePending();
      flushTick();
      flushTick(1000);
      expect(tick).toHaveBeenCalledTimes(2);

      poller.destroy();
    })
  );

  it(
    'stops scheduling once the tab is hidden',
    fakeAsync(() => {
      const tick = jasmine.createSpy('tick').and.resolveTo();
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      expect(tick).toHaveBeenCalledTimes(1);

      setHidden(true);
      flushTick(10_000);
      // No further ticks while hidden, however long the tab sits there.
      expect(tick).toHaveBeenCalledTimes(1);

      poller.destroy();
    })
  );

  it(
    'resumes with an immediate tick when the tab becomes visible again',
    fakeAsync(() => {
      const tick = jasmine.createSpy('tick').and.resolveTo();
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      setHidden(true);
      flushTick(10_000);
      expect(tick).toHaveBeenCalledTimes(1);

      setHidden(false);
      flushTick();
      // Resumes at once — it does not wait out the rest of a stale
      // interval before catching up.
      expect(tick).toHaveBeenCalledTimes(2);

      poller.destroy();
    })
  );

  it(
    'stops for good on destroy, surviving a later visibilitychange',
    fakeAsync(() => {
      const tick = jasmine.createSpy('tick').and.resolveTo();
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      poller.destroy();

      flushTick(10_000);
      expect(tick).toHaveBeenCalledTimes(1);

      // A leaked interval is invisible until it is a production problem —
      // assert directly that a visibility flip after destroy cannot
      // resurrect it.
      setHidden(false);
      flushTick(10_000);
      expect(tick).toHaveBeenCalledTimes(1);
    })
  );

  it(
    'applies a widened interval to scheduling made after the change',
    fakeAsync(() => {
      const tick = jasmine.createSpy('tick').and.resolveTo();
      const poller = new Poller(tick, 1000);

      poller.start();
      flushTick();
      // The first tick already armed its next timer at the old 1000ms
      // interval before this call — an in-flight timer's own delay
      // cannot be rewritten, only the one scheduled after it.
      poller.setIntervalMs(5000);

      flushTick(1000);
      expect(tick).toHaveBeenCalledTimes(2);

      flushTick(5000);
      expect(tick).toHaveBeenCalledTimes(3);

      poller.destroy();
    })
  );
});

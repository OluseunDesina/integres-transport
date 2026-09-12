import { TestBed } from '@angular/core/testing';

import { SeniorModeStore } from './senior-mode.store';

describe('SeniorModeStore', () => {
  let store: SeniorModeStore;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-senior');
    TestBed.configureTestingModule({});
    store = TestBed.inject(SeniorModeStore);
    TestBed.flushEffects();
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-senior');
  });

  it('defaults to off when nothing is persisted, and clears the root attribute', () => {
    expect(store.enabled()).toBeFalse();
    expect(document.documentElement.hasAttribute('data-senior')).toBeFalse();
  });

  it('set(true) persists, flips the signal, and sets data-senior="true" on the root', () => {
    store.set(true);
    TestBed.flushEffects();

    expect(store.enabled()).toBeTrue();
    expect(localStorage.getItem('integra.senior-mode')).toBe('true');
    expect(document.documentElement.getAttribute('data-senior')).toBe('true');
  });

  it('set(false) clears the root attribute again', () => {
    store.set(true);
    TestBed.flushEffects();
    store.set(false);
    TestBed.flushEffects();

    expect(store.enabled()).toBeFalse();
    expect(localStorage.getItem('integra.senior-mode')).toBe('false');
    expect(document.documentElement.hasAttribute('data-senior')).toBeFalse();
  });

  it('toggle() flips the current value', () => {
    store.toggle();
    TestBed.flushEffects();
    expect(store.enabled()).toBeTrue();

    store.toggle();
    TestBed.flushEffects();
    expect(store.enabled()).toBeFalse();
  });

  it('restores a persisted preference on construction, and re-applies the root attribute', () => {
    localStorage.setItem('integra.senior-mode', 'true');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(SeniorModeStore);
    TestBed.flushEffects();

    expect(restored.enabled()).toBeTrue();
    expect(document.documentElement.getAttribute('data-senior')).toBe('true');
  });

  it('ignores corrupt persisted data instead of throwing', () => {
    localStorage.setItem('integra.senior-mode', 'not-json');

    TestBed.resetTestingModule();
    expect(() => TestBed.configureTestingModule({})).not.toThrow();
    let restored!: SeniorModeStore;
    expect(() => (restored = TestBed.inject(SeniorModeStore))).not.toThrow();

    expect(restored.enabled()).toBeFalse();
  });
});

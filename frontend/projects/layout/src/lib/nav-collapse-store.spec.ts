import { TestBed } from '@angular/core/testing';

import { NavCollapseStore } from './nav-collapse-store';

describe('NavCollapseStore', () => {
  let store: NavCollapseStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    store = TestBed.inject(NavCollapseStore);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to expanded when nothing is persisted', () => {
    expect(store.collapsed()).toBeFalse();
  });

  it('toggle() flips the signal and persists to localStorage', () => {
    store.toggle();

    expect(store.collapsed()).toBeTrue();
    expect(localStorage.getItem('integra.nav.collapsed')).toBe('true');

    store.toggle();

    expect(store.collapsed()).toBeFalse();
    expect(localStorage.getItem('integra.nav.collapsed')).toBe('false');
  });

  it('restores a persisted collapsed preference on construction', () => {
    localStorage.setItem('integra.nav.collapsed', 'true');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(NavCollapseStore);

    expect(restored.collapsed()).toBeTrue();
  });

  it('ignores corrupt persisted data instead of throwing', () => {
    localStorage.setItem('integra.nav.collapsed', 'not-json');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(NavCollapseStore);

    expect(restored.collapsed()).toBeFalse();
  });
});

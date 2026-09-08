import { TestBed } from '@angular/core/testing';

import { TableDensityStore } from './table-density.store';

const STORAGE_KEY = 'integra:table-density';

describe('TableDensityStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function make(): TableDensityStore {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(TableDensityStore);
  }

  it('defaults to comfortable', () => {
    expect(make().density()).toBe('comfortable');
  });

  it('persists a change', () => {
    make().set('compact');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('compact');
  });

  it('reads a stored preference back on the next visit', () => {
    localStorage.setItem(STORAGE_KEY, 'compact');
    expect(make().density()).toBe('compact');
  });

  it('shares one preference across every list', () => {
    // The reason this is a root-provided store rather than a per-screen
    // signal: an operator who wants dense rows wants them everywhere.
    const store = make();
    store.set('compact');
    expect(TestBed.inject(TableDensityStore).density()).toBe('compact');
  });

  it('falls back to comfortable for an unrecognised stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'enormous');
    expect(make().density()).toBe('comfortable');
  });

  it('still honours a change for the session when storage throws', () => {
    // Private browsing and blocked site data both throw on setItem.
    const store = make();
    spyOn(localStorage, 'setItem').and.throwError('blocked');

    expect(() => store.set('compact')).not.toThrow();
    expect(store.density()).toBe('compact');
  });

  it('starts comfortable when reading storage throws', () => {
    spyOn(localStorage, 'getItem').and.throwError('blocked');
    expect(make().density()).toBe('comfortable');
  });
});

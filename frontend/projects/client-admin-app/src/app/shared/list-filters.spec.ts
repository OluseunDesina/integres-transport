import { ListFilters } from './list-filters';

describe('ListFilters', () => {
  let filters: ListFilters;

  beforeEach(() => (filters = new ListFilters()));

  it('starts with no filters and no chips', () => {
    expect(filters.chips()).toEqual([]);
    expect(filters.isFiltered()).toBeFalse();
    expect(filters.query()).toEqual({
      search: undefined,
      is_active: undefined,
    });
  });

  it('trims the search term on the way into the query', () => {
    filters.setSearch('  Ikeja  ');
    expect(filters.query().search).toBe('Ikeja');
  });

  it('keeps the raw value in the signal that feeds the input', () => {
    // Writing a trimmed value back would delete a trailing space the
    // moment a user typed one, and jump their cursor.
    filters.setSearch('Ikeja ');
    expect(filters.search()).toBe('Ikeja ');
  });

  it('sends no search param for whitespace only', () => {
    filters.setSearch('   ');
    expect(filters.query().search).toBeUndefined();
    expect(filters.chips()).toEqual([]);
  });

  it('maps the status filter to a boolean, and "" to no filter at all', () => {
    expect(filters.query().is_active).toBeUndefined();

    filters.setActiveFilter('true');
    expect(filters.query().is_active).toBeTrue();

    filters.setActiveFilter('false');
    expect(filters.query().is_active).toBeFalse();

    filters.setActiveFilter('');
    expect(filters.query().is_active).toBeUndefined();
  });

  it('ignores a status value it does not recognise', () => {
    filters.setActiveFilter('maybe');
    expect(filters.activeFilter()).toBe('');
  });

  it('renders a chip per active filter', () => {
    filters.setSearch('Ikeja');
    filters.setActiveFilter('false');

    expect(filters.chips()).toEqual([
      { id: 'search', label: 'Search', value: 'Ikeja' },
      { id: 'is_active', label: 'Status', value: 'Inactive' },
    ]);
    expect(filters.isFiltered()).toBeTrue();
  });

  it('removes one filter by its chip id, leaving the other', () => {
    filters.setSearch('Ikeja');
    filters.setActiveFilter('true');

    filters.remove('search');

    expect(filters.search()).toBe('');
    expect(filters.activeFilter()).toBe('true');
  });

  it('ignores an unknown chip id rather than clearing everything', () => {
    filters.setSearch('Ikeja');
    filters.remove('nonsense');
    expect(filters.search()).toBe('Ikeja');
  });

  it('clears everything', () => {
    filters.setSearch('Ikeja');
    filters.setActiveFilter('true');

    filters.clear();

    expect(filters.chips()).toEqual([]);
    expect(filters.query()).toEqual({
      search: undefined,
      is_active: undefined,
    });
  });

  // --- Screen-specific filters (slice 3b) ---

  describe('extra filters', () => {
    let withExtras: ListFilters;

    beforeEach(() => {
      withExtras = new ListFilters([
        { key: 'status', label: 'Status' },
        {
          key: 'route',
          label: 'Route',
          chipValue: (id) => (id === 'route-1' ? 'Ikeja Express' : id),
        },
      ]);
    });

    it('sends nothing for a filter that is unset', () => {
      expect(withExtras.query()['status']).toBeUndefined();
      expect(withExtras.chips()).toEqual([]);
    });

    it('sends a set filter and renders its chip', () => {
      withExtras.setExtra('status', 'cancelled');

      expect(withExtras.query()['status']).toBe('cancelled');
      expect(withExtras.chips()).toEqual([{ id: 'status', label: 'Status', value: 'cancelled' }]);
    });

    it('shows a readable chip value rather than the raw one', () => {
      // A route filter sends a UUID. Without this the chip would put a
      // UUID on screen, which tells an operator nothing.
      withExtras.setExtra('route', 'route-1');

      expect(withExtras.query()['route']).toBe('route-1');
      expect(withExtras.chips()[0].value).toBe('Ikeja Express');
    });

    it('falls back to the raw value when no formatter is given', () => {
      withExtras.setExtra('status', 'paid');
      expect(withExtras.chips()[0].value).toBe('paid');
    });

    it('reads a filter back for its own control', () => {
      withExtras.setExtra('status', 'paid');
      expect(withExtras.extra('status')).toBe('paid');
      expect(withExtras.extra('route')).toBe('');
    });

    it('removes one filter by its chip id', () => {
      withExtras.setExtra('status', 'paid');
      withExtras.setExtra('route', 'route-1');

      withExtras.remove('status');

      expect(withExtras.extra('status')).toBe('');
      expect(withExtras.extra('route')).toBe('route-1');
    });

    it('clears search, status and every screen filter together', () => {
      withExtras.setSearch('Ikeja');
      withExtras.setExtra('status', 'paid');
      withExtras.setExtra('route', 'route-1');

      withExtras.clear();

      expect(withExtras.chips()).toEqual([]);
      expect(withExtras.isFiltered()).toBeFalse();
    });

    it('ignores a filter the screen never declared', () => {
      withExtras.setExtra('nonsense', 'x');
      expect(withExtras.query()['nonsense']).toBeUndefined();
      expect(withExtras.chips()).toEqual([]);
    });

    it('leaves the search/is_active behaviour of a screen with no extras intact', () => {
      const plain = new ListFilters();
      plain.setSearch('Ikeja');
      plain.setActiveFilter('false');

      expect(plain.query()).toEqual({ search: 'Ikeja', is_active: false });
    });
  });
});

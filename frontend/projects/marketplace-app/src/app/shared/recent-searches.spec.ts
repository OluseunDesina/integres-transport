import { MAX_RECENT_SEARCHES, readRecentSearches, saveRecentSearch, searchDateFor } from './recent-searches';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

const search = (origin: string, destination: string, serviceDate = '2026-09-20') => ({
  origin,
  destination,
  serviceDate,
  tripClass: '',
});

describe('recent searches', () => {
  it('keeps the newest first, one per route, capped', () => {
    const storage = memoryStorage();
    saveRecentSearch(search('Ikeja', 'CMS'), storage);
    saveRecentSearch(search('Yaba', 'Lekki'), storage);
    saveRecentSearch(search('ikeja', 'cms', '2026-09-21'), storage);

    expect(readRecentSearches(storage)).toEqual([search('ikeja', 'cms', '2026-09-21'), search('Yaba', 'Lekki')]);

    for (let i = 0; i < 10; i++) {
      saveRecentSearch(search(`A${i}`, 'B'), storage);
    }
    expect(readRecentSearches(storage).length).toBe(MAX_RECENT_SEARCHES);
  });

  it('ignores corrupt or foreign data instead of throwing', () => {
    const storage = memoryStorage();
    storage.setItem('marketplace.recentSearches', '{not json');
    expect(readRecentSearches(storage)).toEqual([]);
    storage.setItem('marketplace.recentSearches', JSON.stringify([{ origin: 1 }, search('Ikeja', 'CMS')]));
    expect(readRecentSearches(storage)).toEqual([search('Ikeja', 'CMS')]);
  });

  it('survives storage that throws on write, and no storage at all', () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    expect(() => saveRecentSearch(search('Ikeja', 'CMS'), storage)).not.toThrow();
    expect(readRecentSearches(null)).toEqual([]);
  });

  it('rolls a past date forward to today', () => {
    expect(searchDateFor(search('Ikeja', 'CMS', '2026-09-01'), '2026-09-19')).toBe('2026-09-19');
    expect(searchDateFor(search('Ikeja', 'CMS', '2026-09-25'), '2026-09-19')).toBe('2026-09-25');
  });
});

import { TestBed } from '@angular/core/testing';
import { API_CLIENT } from '@api-client';

import { ExportStore } from './export.store';

/**
 * The workspace's first file download, so most of what is asserted here
 * is the plumbing that has no other test anywhere: `parseAs: 'blob'`,
 * reading an **error** body back out of a blob, and taking the filename
 * from `Content-Disposition`.
 */
describe('ExportStore', () => {
  let apiClient: { GET: jasmine.Spy };
  let store: ExportStore;
  let anchor: HTMLAnchorElement;
  let clicked: boolean;

  function headers(disposition?: string): Response {
    return {
      headers: { get: (name: string) => (name === 'content-disposition' ? disposition : null) },
    } as unknown as Response;
  }

  beforeEach(() => {
    apiClient = { GET: jasmine.createSpy('GET') };
    TestBed.configureTestingModule({
      providers: [{ provide: API_CLIENT, useValue: apiClient }],
    });
    store = TestBed.inject(ExportStore);

    clicked = false;
    anchor = document.createElement('a');
    spyOn(anchor, 'click').and.callFake(() => {
      clicked = true;
    });
    spyOn(document, 'createElement').and.returnValue(anchor);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:fake');
    spyOn(URL, 'revokeObjectURL');
  });

  it('asks for a blob, because the body is CSV and not JSON', async () => {
    apiClient.GET.and.resolveTo({ data: new Blob(['a,b\r\n']), response: headers() });

    await store.download('transactions', { business: 'biz-1', date_from: '2026-08-01' });

    expect(apiClient.GET).toHaveBeenCalledWith(
      '/api/v1/exports/{resource}/',
      jasmine.objectContaining({
        params: {
          path: { resource: 'transactions' },
          query: { business: 'biz-1', date_from: '2026-08-01' },
        },
        parseAs: 'blob',
      })
    );
  });

  it("saves the file under the server's own name", async () => {
    apiClient.GET.and.resolveTo({
      data: new Blob(['a,b\r\n']),
      response: headers('attachment; filename="integra-revenue-2026-08-01-to-2026-08-31.csv"'),
    });

    await store.download('revenue', {});

    expect(anchor.download).toBe('integra-revenue-2026-08-01-to-2026-08-31.csv');
    expect(clicked).toBeTrue();
    // Not revoking would pin every exported blob for the life of the tab.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('falls back to a sensible name when the header is missing', async () => {
    // Cross-origin, `Content-Disposition` is only readable because the
    // backend sets CORS_EXPOSE_HEADERS. If that ever regresses the file
    // still saves, under a name that says what it is.
    apiClient.GET.and.resolveTo({ data: new Blob(['a']), response: headers() });

    await store.download('bookings', {});

    expect(anchor.download).toBe('integra-bookings.csv');
  });

  describe('failures', () => {
    it('reads a field-keyed 400 back out of the blob body', async () => {
      // The error body is a blob too, because `parseAs` applies to both.
      // Without decoding it the useful half of every refusal is lost —
      // and these messages name the exact fix.
      const message = 'A day trend covers at most 92 days; this range is 97.';
      apiClient.GET.and.resolveTo({
        error: new Blob([JSON.stringify({ granularity: [message] })]),
        response: headers(),
      });

      await store.download('revenue', {});

      expect(store.error()).toBe(message);
      expect(clicked).toBeFalse();
    });

    it('reads a plain detail too', async () => {
      apiClient.GET.and.resolveTo({
        error: new Blob([JSON.stringify({ detail: 'This export would contain 61,204 rows.' })]),
        response: headers(),
      });

      await store.download('transactions', {});

      expect(store.error()).toBe('This export would contain 61,204 rows.');
    });

    it('says something useful when the body is not JSON at all', async () => {
      apiClient.GET.and.resolveTo({ error: new Blob(['<html>502</html>']), response: headers() });

      await store.download('transactions', {});

      expect(store.error()).toBe('Could not download the export.');
    });

    it('survives a rejected request rather than spinning forever', async () => {
      apiClient.GET.and.rejectWith(new Error('offline'));

      await store.download('transactions', {});

      expect(store.pending()).toBeNull();
      expect(store.error()).toContain('Could not download');
    });
  });

  it('reports which resource is in flight, so one button spins and not all of them', async () => {
    let resolve!: (value: unknown) => void;
    apiClient.GET.and.returnValue(new Promise((r) => (resolve = r)));

    const pending = store.download('route-revenue', {});
    expect(store.isPending('route-revenue')).toBeTrue();
    expect(store.isPending('revenue')).toBeFalse();

    resolve({ data: new Blob(['a']), response: headers() });
    await pending;
    expect(store.isPending('route-revenue')).toBeFalse();
  });
});

import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';

/** The resources `GET /exports/{resource}/` serves. Typed off the
 * generated schema's own path-parameter union, so a typo is a compile
 * error rather than a runtime 404. */
export type ExportResource =
  | 'transactions'
  | 'bookings'
  | 'revenue'
  | 'revenue-trend'
  | 'route-revenue'
  | 'trip-class-revenue'
  | 'trip-performance'
  // Spec 18 slice 1. The only resource bounded by a **trip** rather
  // than a period — see `ExportQuery.trip` below.
  | 'manifest';

export interface ExportQuery {
  business?: string;
  route?: string;
  /** Required by the `manifest` resource and ignored by every other
   * one. The server answers a manifest export with no trip with a 400
   * naming the parameter, rather than an empty file. */
  trip?: string;
  trip_class?: string;
  date_from?: string;
  date_to?: string;
  status?: string;
  booking_status?: string;
  channel?: string;
  granularity?: 'day' | 'week' | 'month';
}

const FILENAME_PATTERN = /filename="([^"]+)"/;

/**
 * The whole of this workspace's file-download story, in one place.
 *
 * ## Through the typed client, never a bare `fetch`
 *
 * The endpoint is in the generated `schema.ts` specifically so this call
 * can go through `API_CLIENT` and inherit `authMiddleware` — the bearer
 * token *and* the transparent 401 refresh-and-replay. A hand-written
 * `fetch` with its own `Authorization` header would re-create the exact
 * stale-token bug `docs/specs/13-session-resilience.md` records, and it
 * is the obvious shortcut, which is why this says so.
 *
 * ## Three things that are not obvious
 *
 * - **`parseAs: 'blob'`.** openapi-fetch defaults to `json` and would
 *   call `.json()` on a CSV body.
 * - **The error body is a blob too.** A 400 (bad range, over the row
 *   cap) or a 403 arrives as `error: Blob`, so recovering the `detail`
 *   the operator needs means reading it back as text and parsing it.
 *   Without this the useful half of every refusal is lost.
 * - **The filename comes from `Content-Disposition`**, which the browser
 *   only exposes cross-origin because the backend sets
 *   `CORS_EXPOSE_HEADERS`. A local fallback covers the case where it is
 *   missing rather than saving a file called `download`.
 */
@Injectable({ providedIn: 'root' })
export class ExportStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<{ pending: ExportResource | null; error: string | null }>({
    pending: null,
    error: null,
  });

  readonly pending = computed(() => this.state().pending);
  readonly error = computed(() => this.state().error);

  isPending(resource: ExportResource): boolean {
    return this.state().pending === resource;
  }

  clearError(): void {
    this.state.update((s) => ({ ...s, error: null }));
  }

  async download(resource: ExportResource, query: ExportQuery): Promise<void> {
    this.state.set({ pending: resource, error: null });
    try {
      const { data, error, response } = await this.api.GET('/api/v1/exports/{resource}/', {
        params: { path: { resource }, query },
        parseAs: 'blob',
      });

      if (!data) {
        this.state.set({ pending: null, error: await toErrorMessage(error) });
        return;
      }

      saveBlob(data as Blob, filenameFrom(response, resource));
      this.state.set({ pending: null, error: null });
    } catch {
      // A network failure, or a browser that refused the save. Either
      // way the operator gets a sentence rather than a button that
      // silently stopped spinning.
      this.state.set({ pending: null, error: 'Could not download the export. Try again.' });
    }
  }
}

/**
 * The server's own name for the file, which is the one that states the
 * resource and the period it actually covers.
 */
function filenameFrom(response: Response, resource: ExportResource): string {
  const header = response.headers.get('content-disposition') ?? '';
  return FILENAME_PATTERN.exec(header)?.[1] ?? `integra-${resource}.csv`;
}

async function toErrorMessage(error: unknown): Promise<string> {
  const body = error instanceof Blob ? await readJson(error) : error;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    // `detail` first, then any field-keyed message — the analytics
    // filters answer 400 with `{"date_from": [...]}`, and that message
    // names the fix, so it has to reach the operator verbatim.
    for (const value of [record['detail'], ...Object.values(record)]) {
      if (typeof value === 'string' && value) {
        return value;
      }
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) {
        return value[0];
      }
    }
  }
  return 'Could not download the export.';
}

async function readJson(blob: Blob): Promise<unknown> {
  try {
    return JSON.parse(await blob.text());
  } catch {
    return null;
  }
}

/**
 * Hand the browser a file.
 *
 * An anchor with `download`, clicked and revoked — the only way to name
 * a file from a response the page fetched itself. `revokeObjectURL`
 * matters: a console session that exports a dozen times would otherwise
 * pin every one of those blobs in memory for the life of the tab.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

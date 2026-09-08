import { Injectable, computed, inject, signal } from '@angular/core';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';

import { toErrorMessage } from './analytics-envelope.store';

export type TripLiveEnvelope = components['schemas']['TripLiveEnvelope'];

const FALLBACK_MESSAGE = 'Failed to load live vehicle positions.';

/**
 * How many delta (`?since=`) polls run between full snapshots.
 *
 * `docs/specs/20-live-operations.md`'s own slice 2 note names the gap
 * this closes: "?since= then narrows a real 200 to the trips that
 * actually moved... a trip completing between polls isn't separately
 * tombstoned — left for slice 3's polling client to reconcile via
 * periodic full refresh." A delta response only ever adds or updates
 * rows, so a trip that finished and dropped off `/trips/live/`
 * entirely would otherwise sit in this store forever. A full poll (no
 * `?since=`) replaces the whole map instead of merging into it, which
 * is what actually drops it.
 *
 * `ASSUMPTION:` every 6th poll — at the default 12s interval, a
 * completed trip lingers at most ~72s past its last real update, which
 * is well inside the staleness an operator already reads off the
 * position itself.
 */
const FULL_REFRESH_EVERY = 6;

interface LiveOperationsState {
  envelopesById: Map<string, TripLiveEnvelope>;
  etag: string | null;
  /** The cursor sent as the next request's `?since=` — the server's own
   * clock (`server_time` in the response body), never the browser's,
   * so client/server clock skew cannot silently drop an update. See
   * `poll()`'s own comment on why this is a body field and not the
   * `Date` response header. */
  since: string | null;
  pollsSinceFullRefresh: number;
  pollIntervalSeconds: number;
  /** True until the very first response — success or failure —
   * lands. Distinguishes "no data yet" from "settled, and empty". */
  initialLoad: boolean;
  /** A load failure with **no** data on screen yet — replaces the
   * board, the same rule every other envelope store in this app
   * follows. */
  error: string | null;
  /** A poll failure **after** the board already has data — surfaced
   * above the board without blanking it, the recorded rule for a
   * transient failure (docs/frontend-patterns.md §3). */
  pollError: string | null;
}

/**
 * `GET /trips/live/` — docs/specs/20-live-operations.md slice 3.
 *
 * Not a `ListStore`: the response is a poll target with its own
 * `ETag`/`?since=` protocol, not a page of a static collection. Not an
 * `AnalyticsEnvelopeStore` either — that base re-fetches a whole
 * envelope from scratch on every `load()`, which is wrong here twice
 * over: a `304` must leave the board untouched, and a delta response
 * must **merge** into it rather than replace it.
 *
 * `envelopesById` is a `Map`, not `results` kept as an array, so a
 * delta update can find and replace one trip's row without disturbing
 * the position of any other — an operator scanning the board would
 * otherwise see rows reshuffle on every poll for no reason.
 */
@Injectable({ providedIn: 'root' })
export class LiveOperationsStore {
  private readonly api = inject(API_CLIENT);

  private readonly state = signal<LiveOperationsState>({
    envelopesById: new Map(),
    etag: null,
    since: null,
    pollsSinceFullRefresh: 0,
    pollIntervalSeconds: 12,
    initialLoad: true,
    error: null,
    pollError: null,
  });

  readonly trips = computed(() => Array.from(this.state().envelopesById.values()));
  readonly loading = computed(() => this.state().initialLoad);
  readonly error = computed(() => this.state().error);
  readonly pollError = computed(() => this.state().pollError);
  readonly isEmpty = computed(
    () => !this.state().initialLoad && !this.state().error && this.trips().length === 0
  );
  readonly pollIntervalSeconds = computed(() => this.state().pollIntervalSeconds);

  /** Drives spec 20's mandatory, non-subtle simulated-data warning: "Not
   * a subtle badge. An operations console that cannot be trusted to say
   * whether its data is real is worse than no console." */
  readonly hasSimulatedData = computed(() =>
    this.trips().some((envelope) => envelope.position?.source === 'simulated')
  );

  async poll(): Promise<void> {
    const s = this.state();
    const isFull = s.since === null || s.pollsSinceFullRefresh >= FULL_REFRESH_EVERY;

    const { data, error, response } = await this.api.GET('/api/v1/trips/live/', {
      params: { query: isFull ? undefined : { since: s.since ?? undefined } },
      headers: s.etag ? { 'If-None-Match': s.etag } : undefined,
    });

    if (response?.status === 304) {
      // Nothing changed — the whole board, membership included, is
      // provably identical. `since` is deliberately left un-advanced:
      // "still nothing new since T" next poll is exactly as correct as
      // advancing it would have been, and simpler to reason about.
      this.state.update((prev) => ({ ...prev, initialLoad: false, pollError: null }));
      return;
    }

    if (!data) {
      const message = toErrorMessage(error, FALLBACK_MESSAGE);
      this.state.update((prev) => ({
        ...prev,
        initialLoad: false,
        error: prev.envelopesById.size === 0 ? message : prev.error,
        pollError: prev.envelopesById.size > 0 ? message : null,
      }));
      return;
    }

    const etag = response?.headers.get('etag') ?? s.etag;
    this.state.update((prev) => {
      const envelopesById = isFull ? new Map<string, TripLiveEnvelope>() : new Map(prev.envelopesById);
      for (const envelope of data.results) {
        envelopesById.set(envelope.trip.id, envelope);
      }
      return {
        envelopesById,
        etag,
        since: data.server_time,
        pollsSinceFullRefresh: isFull ? 0 : prev.pollsSinceFullRefresh + 1,
        pollIntervalSeconds: data.poll_interval_seconds,
        initialLoad: false,
        error: null,
        pollError: null,
      };
    });
  }
}

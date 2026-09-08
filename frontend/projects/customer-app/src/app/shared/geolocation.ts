import { Injectable } from '@angular/core';

/**
 * `latitude`/`longitude` as the browser reports them, or a named reason
 * why there are none.
 *
 * A refusal is not an error. docs/specs/17-incidents.md is explicit
 * that "a report with no location is normal, not degraded" — the
 * caller states the reason plainly and carries on submitting.
 */
export type LocationResult =
  | { readonly ok: true; readonly latitude: string; readonly longitude: string }
  | { readonly ok: false; readonly reason: 'unsupported' | 'denied' | 'unavailable' };

/** Matches the backend's `DecimalField(max_digits=9, decimal_places=6)`.
 * A raw `position.coords.latitude` is a float with up to fifteen
 * significant digits, and DRF answers a value that long with a 400 on a
 * field the passenger cannot see or correct. */
const PRECISION = 6;

/**
 * The one place this app touches `navigator.geolocation`.
 *
 * A service rather than a call inside the component so its spec can
 * drive every branch — including the two that are unreachable in a
 * headless browser (a real permission prompt, and a device with no
 * geolocation at all).
 *
 * **Nothing here ever infers a position.** There is no IP lookup and no
 * last-known-value cache: the spec requires coordinates be recorded
 * exactly as supplied by the browser, because an incident's location is
 * evidence about where a fault is, and a guess is worse than a blank.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  async current(): Promise<LocationResult> {
    const geolocation = this.geolocation();
    if (!geolocation) {
      return { ok: false, reason: 'unsupported' };
    }

    return new Promise<LocationResult>((resolve) => {
      geolocation.getCurrentPosition(
        (position) =>
          resolve({
            ok: true,
            latitude: position.coords.latitude.toFixed(PRECISION),
            longitude: position.coords.longitude.toFixed(PRECISION),
          }),
        (error) =>
          resolve({
            ok: false,
            // `PERMISSION_DENIED` is the only one worth wording
            // differently: it is the passenger's own decision and asking
            // again is pointless, whereas a timeout or a position
            // failure might work on a second try.
            reason: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable',
          }),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
      );
    });
  }

  /** The seam the spec overrides. `navigator.geolocation` is absent
   * outright on some browsers rather than present-and-failing, so this
   * is an existence check, not a try/catch. */
  protected geolocation(): Geolocation | null {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator
      ? navigator.geolocation
      : null;
  }
}

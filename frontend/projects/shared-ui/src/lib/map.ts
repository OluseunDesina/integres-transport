import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { LatLngExpression, LatLngTuple, LayerGroup, Map as LeafletMap, Marker } from 'leaflet';

import type { StatusPillTone } from './status-pill';

/**
 * One vehicle's marker — `docs/specs/20-live-operations.md`'s own field
 * list: "vehicle, last stop, next stop, ETA, staleness".
 *
 * Every text field here is **pre-formatted by the caller**. This
 * component does not know the app's locale, timezone or "12 min ago"
 * rounding rules any more than `ui-chart` knows how to format money —
 * see that component's `valueFormatter` input for the same division of
 * labour. A `null`/`undefined` field renders as "Unknown" rather than a
 * blank cell, so the accessible table never reads as a rendering
 * failure.
 */
export interface MapMarker {
  id: string;
  /** Names the marker on the map and in the accessible table — usually
   * a vehicle registration or the route it is running. */
  label: string;
  latitude: number;
  longitude: number;
  /** Degrees clockwise from north. `null`/`undefined` when unknown,
   * which draws the marker unrotated rather than guessing a heading. */
  heading?: number | null;
  /** Colours the marker the same way `ui-status-pill` colours a row —
   * neutral by default. */
  tone?: StatusPillTone;
  lastStop?: string | null;
  nextStop?: string | null;
  etaLabel?: string | null;
  stalenessLabel?: string | null;
  /**
   * Spec 20's mandatory, non-subtle simulated-data treatment: "Not a
   * subtle badge. An operations console that cannot be trusted to say
   * whether its data is real is worse than no console." Draws a dashed
   * ring around the marker rather than a small corner badge, and is
   * named as "Simulated" in the accessible table's own column so the
   * same fact reaches a screen-reader user.
   */
  simulated?: boolean;
}

const UNKNOWN = 'Unknown';

/** One CSS colour per tone, from this app's own token layer so a
 * white-labelled tenant's markers follow their brand — the same reason
 * `ui-chart`'s palette is `var(--color-brand-*)` rather than a literal
 * hex. Tone colours are semantic (status), not brand, so only
 * `neutral` reaches for the brand token; the other three stay fixed
 * regardless of tenant. */
const TONE_COLOR: Record<StatusPillTone, string> = {
  neutral: 'var(--color-ink-500)',
  positive: 'var(--color-success)',
  warning: 'var(--color-warning)',
  negative: 'var(--color-danger)',
};

const DEFAULT_CENTER: LatLngExpression = [6.5244, 3.3792]; // Lagos — this deployment's first market
const DEFAULT_ZOOM = 12;

/**
 * The one place this workspace draws a map — Leaflet with OpenStreetMap
 * tiles, per `docs/specs/20-live-operations.md`'s own `ASSUMPTION`
 * (`Mapbox`/Google Maps both need an account and an API key, which is a
 * procurement decision, not an implementation one). Wrapped here so a
 * keyed provider can replace the tile source, or Leaflet itself, by
 * editing one component.
 *
 * **Markers are `L.divIcon`s built from this app's own tokens, not
 * Leaflet's default raster pins.** Two reasons, not one:
 *
 * 1. **Brand colour.** A tenant's marker tone has to track
 *    `BrandThemeService`'s runtime override of `--color-brand-*`, the
 *    same reason `ui-chart` renders SVG rather than canvas — a raster
 *    icon baked at build time cannot do that.
 * 2. **No default-icon asset problem.** Leaflet's own default marker
 *    image path resolution breaks under most bundlers (it expects to
 *    find its PNGs relative to a script tag Angular's build does not
 *    emit) and every fix is a workaround for images this component
 *    never needed anyway.
 *
 * **The non-map textual equivalent is not optional.** A map is opaque
 * to assistive technology — the same rule spec 16 states for
 * `ui-chart` — so every marker is also a row in a visually-hidden
 * table, carrying the same vehicle/last stop/next stop/ETA/staleness
 * facts the spec names.
 */
@Component({
  selector: 'ui-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (isEmpty()) {
      <p
        style="font-size: var(--ui-text-body)"
        class="flex items-center justify-center rounded-md border border-dashed border-control text-center text-muted"
        [style.height]="height()"
      >
        {{ emptyMessage() }}
      </p>
    } @else {
      <div #mapEl aria-hidden="true" class="rounded-md" [style.height]="height()"></div>
    }

    <!--
      The accessible equivalent. Visually hidden, never display:none —
      it must stay in the accessibility tree regardless of whether the
      map itself rendered.
    -->
    <table class="sr-only">
      <caption>
        {{ title() }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Vehicle</th>
          <th scope="col">Last stop</th>
          <th scope="col">Next stop</th>
          <th scope="col">ETA</th>
          <th scope="col">Last update</th>
          <th scope="col">Data source</th>
        </tr>
      </thead>
      <tbody>
        @for (marker of markers(); track marker.id) {
          <tr>
            <th scope="row">{{ marker.label }}</th>
            <td>{{ marker.lastStop ?? unknown }}</td>
            <td>{{ marker.nextStop ?? unknown }}</td>
            <td>{{ marker.etaLabel ?? unknown }}</td>
            <td>{{ marker.stalenessLabel ?? unknown }}</td>
            <td>{{ marker.simulated ? 'Simulated' : 'Device' }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class UiMap implements OnDestroy {
  readonly markers = input<MapMarker[]>([]);
  readonly title = input.required<string>();
  readonly height = input('20rem');
  readonly emptyMessage = input('No live positions to show.');
  /** Highlighting an already-plotted marker, driven by the caller's own
   * selected row — panning to a marker with no position of its own
   * would invent a location, so a selection outside `markers()` is
   * simply not shown. */
  readonly selectedId = input<string | null>(null);
  readonly markerSelected = output<string>();

  protected readonly unknown = UNKNOWN;
  protected readonly isEmpty = computed(() => this.markers().length === 0);

  private readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');
  private leafletMap: LeafletMap | null = null;
  private layerGroup: LayerGroup | null = null;
  private readonly markersById = new Map<string, Marker>();
  /** Leaflet resolves from module cache after the first `import()`, but
   * this avoids even that microtask hop on every subsequent poll. */
  private leafletModule: typeof import('leaflet') | null = null;
  /** Frames the whole fleet once, on the first non-empty render — see
   * `renderMarkers`'s own comment for why it never re-fits after that. */
  private hasFitBounds = false;
  private destroyed = false;

  constructor() {
    effect(() => {
      const el = this.mapEl();
      if (el && !this.leafletMap) {
        void this.createMap(el.nativeElement);
      }
    });
    effect(() => {
      const markers = this.markers();
      if (this.layerGroup) {
        this.syncMarkers(markers);
      }
    });
    effect(() => {
      const id = this.selectedId();
      const marker = id ? this.markersById.get(id) : undefined;
      marker?.openPopup();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.leafletMap?.remove();
    this.leafletMap = null;
  }

  /** Leaflet is loaded dynamically rather than imported at the top of
   * the file — this is `@shared-ui`'s only consumer of it, and a
   * static import would put its ~40kB in every bundle that imports
   * anything from this library, including screens with no map. */
  private async createMap(container: HTMLDivElement): Promise<void> {
    const L = await this.loadLeaflet();
    if (this.destroyed) {
      return;
    }
    // `keyboard: false`: the container itself carries `aria-hidden`
    // (see the template) — everything the map shows has a non-map
    // equivalent in the accessible table below it, so nothing inside
    // this subtree should be reachable by keyboard either. Without
    // this, Leaflet gives the container its own `tabindex="0"` for
    // arrow-key panning, which axe correctly flags as a focusable
    // descendant of an aria-hidden element.
    const map = L.map(container, { attributionControl: true, keyboard: false }).setView(
      DEFAULT_CENTER,
      DEFAULT_ZOOM
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    this.leafletMap = map;
    this.layerGroup = L.layerGroup().addTo(map);
    this.syncMarkers(this.markers());
    // The zoom control's two buttons and the attribution link are
    // real `<a>` elements Leaflet builds itself — there is no
    // per-control "keyboard" option for either, unlike the map and its
    // markers. Stripped of tab focus here rather than removed: a mouse
    // or touch user still has full zoom control and can still follow
    // the attribution link, only keyboard tab order skips them, which
    // is what an aria-hidden ancestor already implies for anything
    // genuinely reachable inside it.
    for (const el of container.querySelectorAll<HTMLElement>('a, button, [tabindex]')) {
      el.setAttribute('tabindex', '-1');
    }
  }

  private syncMarkers(markers: MapMarker[]): void {
    void this.renderMarkers(markers);
  }

  /** Leaflet ships as a UMD/CJS bundle, and Karma's build target
   * resolves its dynamic `import()` to a plain namespace object with no
   * usable `default` — unlike the app builds, which go through
   * esbuild's CJS interop and get one. Falling back to `.default` when
   * present, and to the module itself otherwise, works under both. */
  private async loadLeaflet(): Promise<typeof import('leaflet')> {
    if (!this.leafletModule) {
      const imported = (await import('leaflet')) as unknown as {
        default?: typeof import('leaflet');
      } & typeof import('leaflet');
      this.leafletModule = imported.default ?? imported;
    }
    return this.leafletModule;
  }

  private async renderMarkers(markers: MapMarker[]): Promise<void> {
    const L = await this.loadLeaflet();
    const group = this.layerGroup;
    if (!group || this.destroyed) {
      return;
    }
    group.clearLayers();
    this.markersById.clear();

    const bounds: LatLngTuple[] = [];
    for (const marker of markers) {
      const position: LatLngTuple = [marker.latitude, marker.longitude];
      bounds.push(position);
      const icon = L.divIcon({
        className: 'ui-map-marker',
        html: this.markerHtml(marker),
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      // `keyboard: false` — same reason the map itself disables it:
      // without it Leaflet gives every marker `tabindex="0"` and
      // `role="button"`, another focusable descendant of the
      // `aria-hidden` container.
      const leafletMarker = L.marker(position, {
        icon,
        title: marker.label,
        keyboard: false,
      }).bindPopup(this.popupHtml(marker));
      leafletMarker.on('click', () => this.markerSelected.emit(marker.id));
      leafletMarker.addTo(group);
      this.markersById.set(marker.id, leafletMarker);
    }

    // Frames the whole fleet on first paint, once. Re-fitting on every
    // subsequent poll would fight an operator who has since panned or
    // zoomed in on one vehicle.
    if (bounds.length > 0 && this.leafletMap && !this.hasFitBounds) {
      this.leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
      this.hasFitBounds = true;
    }
  }

  private markerHtml(marker: MapMarker): string {
    const color = TONE_COLOR[marker.tone ?? 'neutral'];
    const rotation = marker.heading ?? 0;
    const dashed = marker.simulated
      ? 'border: 2px dashed var(--color-warning);'
      : 'border: 2px solid white;';
    return `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:${color};${dashed}transform:rotate(${rotation}deg);box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>`;
  }

  private popupHtml(marker: MapMarker): string {
    const parts = [
      `<strong>${escapeHtml(marker.label)}</strong>`,
      `${escapeHtml(marker.lastStop ?? UNKNOWN)} → ${escapeHtml(marker.nextStop ?? UNKNOWN)}`,
      `ETA: ${escapeHtml(marker.etaLabel ?? UNKNOWN)}`,
      `Updated: ${escapeHtml(marker.stalenessLabel ?? UNKNOWN)}`,
    ];
    if (marker.simulated) {
      // Explicit colors, not Leaflet's popup defaults: measured live at
      // 2.71:1 (fails WCAG AA's 4.5:1) with whatever the browser's
      // default `<em>`/popup styling actually resolves to here — the
      // static markup itself carried no color at all. This pairing
      // (--color-warning on --color-warning-surface) is the same one
      // `ui-alert`'s own `warning` variant uses, measured at 5.02:1 in
      // color.spec.ts.
      parts.push(
        '<em style="color:var(--color-warning);background:var(--color-warning-surface);padding:0 4px;border-radius:2px;">Simulated data</em>'
      );
    }
    return parts.join('<br>');
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

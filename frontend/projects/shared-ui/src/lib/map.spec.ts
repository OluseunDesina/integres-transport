import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { UiMap, type MapMarker } from './map';

const MARKER: MapMarker = {
  id: 'trip-1',
  label: 'LAG-221-XY',
  latitude: 6.5244,
  longitude: 3.3792,
  lastStop: 'Ojota',
  nextStop: 'Maryland',
  etaLabel: '14:32 (est.)',
  stalenessLabel: '12s ago',
};

@Component({
  imports: [UiMap],
  template: `
    <ui-map
      [markers]="markers()"
      [title]="title()"
      [selectedId]="selectedId()"
      (markerSelected)="selected.set($event)"
    />
  `,
})
class HostComponent {
  readonly markers = signal<MapMarker[]>([MARKER]);
  readonly title = signal('Live vehicle positions');
  readonly selectedId = signal<string | null>(null);
  readonly selected = signal<string | null>(null);
}

describe('UiMap', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  afterEach(() => {
    if (fixture.nativeElement.isConnected) {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function table(): HTMLTableElement {
    return el().querySelector('table')!;
  }

  describe('the accessible equivalent', () => {
    it('renders a captioned, visually-hidden table naming every marker field', () => {
      fixture.detectChanges();

      const rendered = table();
      expect(rendered.querySelector('caption')?.textContent?.trim()).toBe(
        'Live vehicle positions'
      );
      expect(rendered.classList.contains('sr-only')).toBeTrue();

      const headers = Array.from(rendered.querySelectorAll('thead th')).map((th) =>
        th.textContent?.trim()
      );
      expect(headers).toEqual([
        'Vehicle',
        'Last stop',
        'Next stop',
        'ETA',
        'Last update',
        'Data source',
      ]);

      const row = rendered.querySelector('tbody tr')!;
      const cells = Array.from(row.querySelectorAll('th, td')).map((c) => c.textContent?.trim());
      expect(cells).toEqual(['LAG-221-XY', 'Ojota', 'Maryland', '14:32 (est.)', '12s ago', 'Device']);
    });

    it('falls back to "Unknown" for a missing field, never a blank cell', () => {
      host.markers.set([{ id: 'trip-2', label: 'LAG-330-ZZ', latitude: 1, longitude: 1 }]);
      fixture.detectChanges();

      const row = table().querySelector('tbody tr')!;
      const cells = Array.from(row.querySelectorAll('th, td')).map((c) => c.textContent?.trim());
      expect(cells).toEqual(['LAG-330-ZZ', 'Unknown', 'Unknown', 'Unknown', 'Unknown', 'Device']);
    });

    it('names simulated data in its own column', () => {
      host.markers.set([{ ...MARKER, simulated: true }]);
      fixture.detectChanges();

      const row = table().querySelector('tbody tr')!;
      expect(row.textContent).toContain('Simulated');
    });

    it('renders no data rows, but keeps the table, when there are no markers', () => {
      host.markers.set([]);
      fixture.detectChanges();

      expect(table().querySelectorAll('tbody tr').length).toBe(0);
    });
  });

  describe('the empty state', () => {
    it('shows a message and no map container when there are no markers', () => {
      host.markers.set([]);
      fixture.detectChanges();

      expect(el().textContent).toContain('No live positions to show.');
      expect(el().querySelector('[aria-hidden="true"]')).toBeNull();
    });
  });

  describe('the map container', () => {
    it('renders a hidden map container when there are markers', () => {
      fixture.detectChanges();
      const mapEl = el().querySelector('[aria-hidden="true"]');
      expect(mapEl).not.toBeNull();
    });

    /**
     * Leaflet itself loads as a lazy chunk (see `map.ts`'s own comment
     * on why) — a real, separate script fetch that `fixture.whenStable`
     * does not reliably wait out. Polling for the marker to appear is
     * what every other spec in this workspace does for a genuinely
     * async render (`ManifestStore`'s own tests included); the
     * alternative is asserting nothing about Leaflet at all, which
     * would leave `map.ts`'s actual DOM output — the one thing the
     * accessible-table tests above cannot cover — untested.
     */
    async function waitForMarker(): Promise<HTMLElement | null> {
      for (let attempt = 0; attempt < 40; attempt++) {
        fixture.detectChanges();
        const marker = el().querySelector<HTMLElement>('.leaflet-marker-icon');
        if (marker) {
          return marker;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }

    it('initialises Leaflet and plots one marker per row', async () => {
      document.body.appendChild(fixture.nativeElement);
      fixture.detectChanges();

      const marker = await waitForMarker();
      expect(marker).not.toBeNull();
    });

    it('emits markerSelected when a marker is clicked', async () => {
      document.body.appendChild(fixture.nativeElement);
      fixture.detectChanges();

      const marker = await waitForMarker();
      marker?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(host.selected()).toBe('trip-1');
    });
  });
});

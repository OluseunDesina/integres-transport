import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Chart, type ChartSeries, type ChartType } from './chart';

@Component({
  imports: [Chart],
  template: `
    <ui-chart
      [type]="type()"
      [series]="series()"
      [title]="title()"
      [labelHeading]="labelHeading()"
      [valueFormatter]="formatter"
    />
  `,
})
class HostComponent {
  readonly type = signal<ChartType>('line');
  readonly title = signal('Revenue trend');
  readonly labelHeading = signal('Date');
  readonly series = signal<ChartSeries[]>([
    {
      name: 'NGN',
      points: [
        { label: '2026-08-01', value: 100 },
        { label: '2026-08-02', value: 250 },
      ],
    },
  ]);
  formatter = (value: number) => `NGN ${value}`;
}

describe('Chart', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function table(): HTMLTableElement | null {
    return el().querySelector('table');
  }

  describe('the accessible equivalent', () => {
    // docs/specs/16-operational-analytics.md's test plan asks for this
    // explicitly, and asks for it "on the DOM, not on the canvas".

    it('renders a data table for a line chart, captioned with the title', () => {
      fixture.detectChanges();

      const rendered = table();
      expect(rendered).not.toBeNull();
      expect(rendered!.querySelector('caption')?.textContent?.trim()).toBe('Revenue trend');
      expect(rendered!.classList.contains('sr-only')).toBeTrue();
    });

    it('names the category column and each series in the header row', () => {
      host.series.set([
        { name: 'NGN', points: [{ label: 'Mon', value: 1 }] },
        { name: 'BWP', points: [{ label: 'Mon', value: 2 }] },
      ]);
      fixture.detectChanges();

      const headers = Array.from(table()!.querySelectorAll('thead th')).map((th) =>
        th.textContent?.trim()
      );
      expect(headers).toEqual(['Date', 'NGN', 'BWP']);
    });

    it('carries every point through the formatter', () => {
      fixture.detectChanges();

      const rows = Array.from(table()!.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.children).map((cell) => cell.textContent?.trim())
      );
      expect(rows).toEqual([
        ['2026-08-01', 'NGN 100'],
        ['2026-08-02', 'NGN 250'],
      ]);
    });

    it('spells out a gap rather than leaving the cell blank', () => {
      // An empty cell read aloud is indistinguishable from a rendering
      // failure, and a `0` there would be a lie — see ChartPoint.value.
      host.series.set([
        {
          name: 'NGN',
          points: [
            { label: 'Mon', value: 10 },
            { label: 'Tue', value: null },
          ],
        },
      ]);
      fixture.detectChanges();

      expect(table()!.textContent).toContain('No data');
      expect(table()!.textContent).not.toContain('NGN 0');
    });

    it('hides the drawing itself from assistive technology', () => {
      fixture.detectChanges();
      expect(el().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders one for a bar chart too', () => {
      host.type.set('bar');
      fixture.detectChanges();
      expect(table()!.textContent).toContain('NGN 250');
    });

    it('renders one for a doughnut, carrying the share as well as the amount', () => {
      host.type.set('doughnut');
      host.series.set([
        {
          name: 'Amount',
          points: [
            { label: 'card', value: 75 },
            { label: 'wallet', value: 25 },
          ],
        },
      ]);
      fixture.detectChanges();

      const headers = Array.from(table()!.querySelectorAll('thead th')).map((th) =>
        th.textContent?.trim()
      );
      expect(headers).toEqual(['Date', 'Amount', 'Share']);
      const rows = Array.from(table()!.querySelectorAll('tbody tr')).map((tr) =>
        Array.from(tr.children).map((cell) => cell.textContent?.trim())
      );
      expect(rows).toEqual([
        ['card', 'NGN 75', '75%'],
        ['wallet', 'NGN 25', '25%'],
      ]);
    });
  });

  describe('gaps', () => {
    it('breaks the line at a null rather than bridging across it', () => {
      host.series.set([
        {
          name: 'NGN',
          points: [
            { label: 'Mon', value: 10 },
            { label: 'Tue', value: null },
            { label: 'Wed', value: 30 },
          ],
        },
      ]);
      fixture.detectChanges();

      // Two polylines, not one — a single one would draw straight through
      // Tuesday and assert a value nobody reported.
      expect(el().querySelectorAll('polyline').length).toBe(2);
    });

    it('marks a lone surviving point with a round-capped dot, not an ellipse', () => {
      // A `<circle>` here rendered as a wide smear, because the plot is
      // stretched non-uniformly and that distorts geometry. Caught in
      // the iteration-1 screenshots, not by any assertion.
      host.series.set([
        {
          name: 'NGN',
          points: [
            { label: 'Mon', value: null },
            { label: 'Tue', value: 30 },
            { label: 'Wed', value: null },
          ],
        },
      ]);
      fixture.detectChanges();

      const dot = el().querySelector('line.ui-chart-dot');
      expect(dot).not.toBeNull();
      expect(dot!.getAttribute('stroke-linecap')).toBe('round');
      expect(dot!.getAttribute('vector-effect')).toBe('non-scaling-stroke');
      // Zero-length: a cap is the whole mark.
      expect(dot!.getAttribute('x1')).toBe(dot!.getAttribute('x2'));
      expect(dot!.getAttribute('y1')).toBe(dot!.getAttribute('y2'));
      expect(el().querySelectorAll('circle').length).toBe(0);
    });

    it('omits a bar for a gap instead of drawing a zero-height one', () => {
      host.type.set('bar');
      host.series.set([
        {
          name: 'NGN',
          points: [
            { label: 'Mon', value: 10 },
            { label: 'Tue', value: null },
          ],
        },
      ]);
      fixture.detectChanges();

      expect(el().querySelectorAll('rect').length).toBe(1);
    });
  });

  describe('the empty state', () => {
    it('renders a message, and no chart or table, when every point is a gap', () => {
      host.series.set([
        { name: 'NGN', points: [{ label: 'Mon', value: null }] },
      ]);
      fixture.detectChanges();

      expect(el().textContent).toContain('No data for this period.');
      expect(el().querySelector('svg')).toBeNull();
      expect(table()).toBeNull();
    });

    it('treats an all-zero series as data, not as empty', () => {
      // "Nobody paid" and "no Business existed" are different facts, and
      // this is the component-level half of that distinction.
      host.series.set([{ name: 'NGN', points: [{ label: 'Mon', value: 0 }] }]);
      fixture.detectChanges();

      expect(el().querySelector('svg')).not.toBeNull();
      expect(table()!.textContent).toContain('NGN 0');
    });
  });

  describe('the plot', () => {
    it('anchors the value axis at zero so days stay comparable', () => {
      host.series.set([
        {
          name: 'NGN',
          points: [
            { label: 'Mon', value: 100 },
            { label: 'Tue', value: 200 },
          ],
        },
      ]);
      fixture.detectChanges();

      const [first, second] = el()
        .querySelector('polyline')!
        .getAttribute('points')!
        .split(' ')
        .map((pair) => Number(pair.split(',')[1]));

      // 100 of a 0–200 domain is the midline between the floor (100) and
      // the maximum. A min-anchored axis would put it on the floor and
      // make a 2× day look like an infinite one.
      expect(100 - first).toBeCloseTo(first - second, 5);
      // …and the maximum keeps headroom rather than sitting on the top
      // edge, where a bar outline or a point marker gets clipped in half.
      expect(second).toBeGreaterThan(0);
      expect(second).toBeLessThan(10);
    });

    it('labels the axis maximum through the formatter', () => {
      fixture.detectChanges();
      expect(el().textContent).toContain('NGN 250');
    });

    it('shows the first and last categories under the plot', () => {
      fixture.detectChanges();
      const axis = el().querySelector('.mt-1');
      expect(axis?.textContent).toContain('2026-08-01');
      expect(axis?.textContent).toContain('2026-08-02');
    });

    it('draws a legend naming each series when there is more than one', () => {
      // Colour alone must never be the differentiator.
      host.series.set([
        { name: 'NGN', points: [{ label: 'Mon', value: 1 }] },
        { name: 'BWP', points: [{ label: 'Mon', value: 2 }] },
      ]);
      fixture.detectChanges();

      const legend = el().querySelector('ul');
      expect(legend?.textContent).toContain('NGN');
      expect(legend?.textContent).toContain('BWP');
    });

    it('draws no legend for a single series, which needs no key', () => {
      fixture.detectChanges();
      expect(el().querySelector('ul')).toBeNull();
    });
  });

  describe('colours', () => {
    it('takes them from the brand token, so a white-labelled tenant matches', () => {
      // The reason this component renders SVG: a canvas fillStyle cannot
      // hold `var(--color-brand-600)`, and would have to re-resolve it
      // whenever BrandThemeService changes the tenant's ramp.
      fixture.detectChanges();
      expect(el().querySelector('polyline')?.getAttribute('stroke')).toBe(
        'var(--color-brand-600)'
      );
    });

    it('lets a caller override one', () => {
      host.series.set([
        { name: 'NGN', points: [{ label: 'Mon', value: 1 }], color: 'var(--color-success)' },
      ]);
      fixture.detectChanges();
      expect(el().querySelector('polyline')?.getAttribute('stroke')).toBe(
        'var(--color-success)'
      );
    });
  });
});

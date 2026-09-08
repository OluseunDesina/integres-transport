import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One point on an axis, or one slice of a doughnut. */
export interface ChartPoint {
  /** The x-axis category — a date, a route name, a channel. */
  label: string;
  /**
   * `null` is a **gap, never a zero**.
   *
   * `docs/specs/16-operational-analytics.md` makes this a shape rule on
   * the API side too: the trend endpoints emit only buckets that have
   * data, precisely so "no revenue on Tuesday" and "this Business did
   * not exist on Tuesday" cannot render identically. A line chart that
   * substituted 0 for a missing bucket would invent the first from the
   * second, which is the whole failure this spec exists to avoid.
   */
  value: number | null;
  /**
   * This slice's colour, for a **doughnut** only.
   *
   * The palette indexes slices by position, which is right when they
   * are peer categories (payment methods, say). It is wrong when they
   * are a part and its remainder: `success` green landing on "Empty"
   * made a trip that sold nothing render as a solid green ring, which
   * reads as *full* at a glance. A caller that knows which slice means
   * "the good half" says so.
   */
  color?: string;
}

export interface ChartSeries {
  /** Announced in the accessible table's column header and the legend. */
  name: string;
  points: ChartPoint[];
  /** Any CSS colour. Defaults to this component's token palette by index. */
  color?: string;
}

export type ChartType = 'line' | 'bar' | 'doughnut';

/**
 * The palette, in order, drawn from spec 14's token layer rather than
 * hardcoded hexes.
 *
 * `--color-brand-*` is **overridden at runtime** by
 * `BrandThemeService` from the tenant's own colour, so a white-labelled
 * operator's charts follow their brand with no work here — which is
 * exactly what spec 16 asks for, and is the reason this component
 * renders SVG rather than canvas (see the class docstring).
 */
const PALETTE = [
  'var(--color-brand-600)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-brand-300)',
  'var(--color-ink-500)',
  'var(--color-brand-900)',
] as const;

/** The plot's internal coordinate space. Stretched to fit by the
 * viewBox, so these numbers are ratios, not pixels. */
const VB_W = 100;
const VB_H = 100;
/**
 * Headroom above the highest value, in plot units.
 *
 * Without it the maximum sits exactly on the top edge, and anything with
 * width — a bar's outline, a lone point's round marker — is clipped in
 * half by the viewBox. Both were visible in this spec's iteration-1 and
 * iteration-2 captures.
 */
const TOP_PAD = 6;
/** Doughnut geometry: r chosen so the circumference is exactly 100,
 * which makes every `stroke-dasharray` a percentage directly. */
const DOUGHNUT_R = 15.9155;

interface PlottedPoint {
  x: number;
  y: number;
  value: number;
  label: string;
}

interface PlottedSeries {
  name: string;
  color: string;
  /** Split at every gap, so a `null` breaks the line instead of
   * bridging across it. */
  segments: PlottedPoint[][];
  points: PlottedPoint[];
}

interface PlottedBar {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  label: string;
  seriesName: string;
  value: number;
}

interface PlottedSlice {
  color: string;
  label: string;
  value: number;
  percent: number;
  dashArray: string;
  dashOffset: number;
}

/**
 * Line, bar and doughnut charts, and **an accessible data table beside
 * every one of them**.
 *
 * ## Why SVG, and not chart.js
 *
 * `docs/specs/16-operational-analytics.md` named `chart.js`/`ng2-charts`
 * behind this component, with the stated goal that the dependency stay
 * contained and swappable. Building it without one satisfies that goal
 * more completely, and two things about *this* system made the choice
 * concrete rather than a preference:
 *
 * 1. **Tenant brand colour.** Chart colours are required to come from
 *    spec 14's tokens so a white-labelled operator's charts match their
 *    brand — and `BrandThemeService` sets `--color-brand-*` on the
 *    document at runtime, per Client. A canvas cannot take
 *    `var(--color-brand-600)` as a `fillStyle`; it needs the token
 *    resolved to a literal with `getComputedStyle` at draw time and
 *    re-resolved whenever the brand changes. That is a silent-staleness
 *    trap of the kind this repo has already been bitten by several
 *    times. In SVG, `stroke="var(--color-brand-600)"` simply tracks the
 *    variable, including a mid-session change, for free.
 * 2. **Accessibility.** A canvas is opaque to assistive technology, so
 *    the spec already requires a parallel data table. That makes the
 *    drawing itself purely decorative — and a decorative drawing is not
 *    worth a runtime dependency, a Karma canvas harness, or ~200kB in
 *    the bundle.
 *
 * The containment intent is unchanged: this file is still the only
 * place any chart is drawn, and swapping it for a library later means
 * rewriting one component against the same inputs.
 *
 * ## The accessible equivalent is not optional
 *
 * The `<svg>` is `aria-hidden`, and every chart renders a
 * visually-hidden `<table>` carrying the same numbers, captioned with
 * the chart's title. This is asserted on the DOM by this component's
 * own spec, per the spec's test plan — a screen-reader user gets the
 * data, not a shrug.
 *
 * Colour is never the only carrier either: the legend prints each
 * series' name beside its swatch, and the table names it in a column
 * header.
 *
 * ## No text inside the plot
 *
 * The plot stretches to its container (`preserveAspectRatio="none"`,
 * with `vector-effect="non-scaling-stroke"` so strokes stay honest),
 * which would distort any glyph drawn inside it. Axis labels are
 * therefore real HTML around the SVG, where they also inherit the
 * app's type tokens and stay selectable.
 */
@Component({
  selector: 'ui-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (isEmpty()) {
      <p class="py-8 text-center text-sm text-muted">{{ emptyMessage() }}</p>
    } @else {
      @if (type() === 'doughnut') {
        <div class="flex flex-wrap items-center gap-4">
          <svg
            aria-hidden="true"
            [attr.viewBox]="'0 0 ' + doughnutSize + ' ' + doughnutSize"
            [style.width]="height()"
            [style.height]="height()"
            class="shrink-0"
          >
            <circle
              [attr.cx]="doughnutCenter"
              [attr.cy]="doughnutCenter"
              [attr.r]="doughnutRadius"
              fill="none"
              stroke="var(--color-surface-sunken)"
              stroke-width="5"
            />
            @for (slice of slices(); track slice.label) {
              <circle
                [attr.cx]="doughnutCenter"
                [attr.cy]="doughnutCenter"
                [attr.r]="doughnutRadius"
                fill="none"
                [attr.stroke]="slice.color"
                stroke-width="5"
                [attr.stroke-dasharray]="slice.dashArray"
                [attr.stroke-dashoffset]="slice.dashOffset"
                [attr.transform]="'rotate(-90 ' + doughnutCenter + ' ' + doughnutCenter + ')'"
              />
            }
          </svg>
          <ul class="flex min-w-40 flex-col gap-1.5 text-sm">
            @for (slice of slices(); track slice.label) {
              <li class="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  class="size-2.5 shrink-0 rounded-full"
                  [style.background-color]="slice.color"
                ></span>
                <span class="text-default">{{ slice.label }}</span>
                <span class="ml-auto pl-3 font-medium text-strong">{{
                  format(slice.value, slice.label)
                }}</span>
                <span class="w-10 text-right text-xs text-muted">{{ percent(slice) }}</span>
              </li>
            }
          </ul>
        </div>
      } @else {
        @if (plotted().length > 1) {
          <ul class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            @for (series of plotted(); track series.name) {
              <li class="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  class="size-2.5 shrink-0 rounded-full"
                  [style.background-color]="series.color"
                ></span>
                <span class="text-muted">{{ series.name }}</span>
              </li>
            }
          </ul>
        }
        <div>
          <!--
            The axis maximum, as HTML: see "No text inside the plot".
            Above the plot rather than overlaid on it — absolutely
            positioned, it sat on top of the highest bar and the topmost
            data point, which is exactly the value it is naming.
          -->
          <div class="mb-1 flex justify-end text-xs text-muted">{{ maxLabel() }}</div>
          <svg
            aria-hidden="true"
            [attr.viewBox]="'0 0 ' + vbWidth + ' ' + vbHeight"
            preserveAspectRatio="none"
            class="w-full"
            [style.height]="height()"
          >
            @for (line of gridLines(); track line) {
              <line
                x1="0"
                [attr.y1]="line"
                [attr.x2]="vbWidth"
                [attr.y2]="line"
                stroke="var(--color-border)"
                stroke-width="1"
                vector-effect="non-scaling-stroke"
              />
            }

            @if (type() === 'line') {
              @for (series of plotted(); track series.name) {
                @for (segment of series.segments; track $index) {
                  <polyline
                    [attr.points]="pointsAttr(segment)"
                    fill="none"
                    [attr.stroke]="series.color"
                    stroke-width="2"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                    vector-effect="non-scaling-stroke"
                  />
                  <!--
                    A single-point segment has no line to draw, so it
                    would render as nothing at all. The marker is what
                    makes one isolated day visible.

                    It is a zero-length line with a round cap, not an
                    SVG circle. The plot is stretched non-uniformly
                    (preserveAspectRatio none), and that distorts
                    geometry: a radius-2 circle came out as a wide, flat
                    ellipse — visible in this spec's own iteration-1
                    screenshots, where a lone day rendered as a smear.
                    A non-scaling-stroke vector-effect exempts stroke
                    width from that scaling, so a round cap on a
                    zero-length path draws a true circle in screen units
                    whatever the container's aspect ratio.
                  -->
                  @if (segment.length === 1) {
                    <line
                      class="ui-chart-dot"
                      [attr.x1]="segment[0].x"
                      [attr.y1]="segment[0].y"
                      [attr.x2]="segment[0].x"
                      [attr.y2]="segment[0].y"
                      [attr.stroke]="series.color"
                      stroke-width="6"
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    />
                  }
                }
              }
            } @else {
              @for (bar of bars(); track bar.seriesName + '|' + bar.label) {
                <rect
                  [attr.x]="bar.x"
                  [attr.y]="bar.y"
                  [attr.width]="bar.width"
                  [attr.height]="bar.height"
                  [attr.fill]="bar.color"
                />
              }
            }
          </svg>
          @if (axisLabels(); as axis) {
            <div class="mt-1 flex justify-between text-xs text-muted">
              <span>{{ axis.first }}</span>
              @if (axis.last !== axis.first) {
                <span>{{ axis.last }}</span>
              }
            </div>
          }
        </div>
      }

      <!--
        The accessible equivalent. Visually hidden, never display:none —
        it has to stay in the accessibility tree.
      -->
      <table class="sr-only">
        <caption>
          {{ title() }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ labelHeading() }}</th>
            @for (series of tableSeries(); track series.name) {
              <th scope="col">{{ series.name }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of tableRows(); track row.label) {
            <tr>
              <th scope="row">{{ row.label }}</th>
              @for (cell of row.cells; track $index) {
                <td>{{ cell }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class Chart {
  readonly type = input.required<ChartType>();
  readonly series = input.required<ChartSeries[]>();
  /**
   * Names the data. Rendered as the accessible table's `<caption>`, so
   * a screen-reader user landing in the table knows what it describes.
   * It is **not** drawn visibly — the caller's own section heading is
   * the visible title, and two headings for one chart is noise.
   */
  readonly title = input.required<string>();
  /** The accessible table's first column header — "Date", "Route". */
  readonly labelHeading = input('Category');
  /** Formats every value shown to a human, in the legend and the table.
   * Money must arrive already formatted by `formatMoney`. */
  readonly valueFormatter = input<(value: number, label: string) => string>((value) =>
    String(value)
  );
  readonly height = input('12rem');
  readonly emptyMessage = input('No data for this period.');

  protected readonly vbWidth = VB_W;
  protected readonly vbHeight = VB_H;
  protected readonly doughnutSize = 42;
  protected readonly doughnutCenter = 21;
  protected readonly doughnutRadius = DOUGHNUT_R;

  protected format(value: number, label: string): string {
    return this.valueFormatter()(value, label);
  }

  /** The slice's share, to a whole percent. Shown in the legend beside
   * the amount because "which of these is the big one" is the question a
   * doughnut is read to answer, and eyeballing arc length is not an
   * answer a screen-reader user can get at all. */
  protected percent(slice: PlottedSlice): string {
    return `${Math.round(slice.percent)}%`;
  }

  /** Every series, with a resolved colour and its gaps dropped. */
  private readonly resolved = computed(() =>
    this.series().map((series, index) => ({
      name: series.name,
      color: series.color ?? PALETTE[index % PALETTE.length],
      points: series.points,
    }))
  );

  protected readonly isEmpty = computed(() =>
    this.resolved().every((series) => series.points.every((point) => point.value === null))
  );

  /** The category axis, in the order the first series presents it, with
   * any category only later series carry appended. */
  private readonly categories = computed(() => {
    const seen: string[] = [];
    for (const series of this.resolved()) {
      for (const point of series.points) {
        if (!seen.includes(point.label)) {
          seen.push(point.label);
        }
      }
    }
    return seen;
  });

  /**
   * The value axis runs 0 → max, not min → max.
   *
   * A revenue trend whose axis starts at its own minimum exaggerates
   * every wobble into a cliff; anchoring at zero is what makes two days
   * comparable by eye. Negative values (none of spec 16's series has
   * any, but a future one might) extend the floor rather than being
   * clipped.
   */
  private readonly domain = computed(() => {
    const values = this.resolved().flatMap((series) =>
      series.points
        .map((point) => point.value)
        .filter((value): value is number => value !== null)
    );
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    // A flat all-zero series would divide by zero and render as a line
    // along the top; give it a floor so it draws along the bottom.
    return { lo, hi: hi === lo ? lo + 1 : hi };
  });

  protected readonly maxLabel = computed(() => {
    const { hi } = this.domain();
    return this.format(hi, '');
  });

  private y(value: number): number {
    const { lo, hi } = this.domain();
    return VB_H - ((value - lo) / (hi - lo)) * (VB_H - TOP_PAD);
  }

  /**
   * Five lines at even fractions of the **value** range, so the top one
   * is the maximum rather than an arbitrary ceiling above it. That is
   * what lets the axis label beside the chart name a line the reader can
   * actually see.
   */
  protected readonly gridLines = computed(() => {
    const { lo, hi } = this.domain();
    return [0, 1, 2, 3, 4].map((step) => this.y(lo + ((hi - lo) * step) / 4));
  });

  protected readonly plotted = computed<PlottedSeries[]>(() => {
    const categories = this.categories();
    // A single category has no span to spread across, so it sits in the
    // middle rather than at x=0 with nothing beside it.
    const step = categories.length > 1 ? VB_W / (categories.length - 1) : 0;

    return this.resolved().map((series) => {
      const byLabel = new Map(series.points.map((point) => [point.label, point.value]));
      const segments: PlottedPoint[][] = [];
      const points: PlottedPoint[] = [];
      let current: PlottedPoint[] = [];

      categories.forEach((label, index) => {
        const value = byLabel.get(label) ?? null;
        if (value === null) {
          if (current.length > 0) {
            segments.push(current);
            current = [];
          }
          return;
        }
        const point = {
          x: categories.length > 1 ? index * step : VB_W / 2,
          y: this.y(value),
          value,
          label,
        };
        current.push(point);
        points.push(point);
      });
      if (current.length > 0) {
        segments.push(current);
      }
      return { name: series.name, color: series.color, segments, points };
    });
  });

  protected pointsAttr(segment: PlottedPoint[]): string {
    return segment.map((point) => `${point.x},${point.y}`).join(' ');
  }

  protected readonly bars = computed<PlottedBar[]>(() => {
    const categories = this.categories();
    const series = this.plotted();
    if (categories.length === 0 || series.length === 0) {
      return [];
    }
    // A tenth of each slot goes to the gap between groups, so adjacent
    // categories stay visually separable at any count.
    const slot = VB_W / categories.length;
    const groupWidth = slot * 0.8;
    const barWidth = groupWidth / series.length;
    const baseline = this.y(Math.max(0, this.domain().lo));

    const out: PlottedBar[] = [];
    series.forEach((s, seriesIndex) => {
      const byLabel = new Map(s.points.map((point) => [point.label, point]));
      categories.forEach((label, index) => {
        const point = byLabel.get(label);
        if (!point) {
          return;
        }
        const top = Math.min(point.y, baseline);
        out.push({
          x: index * slot + slot * 0.1 + seriesIndex * barWidth,
          y: top,
          width: barWidth,
          // A non-zero value must never render as an invisible sliver —
          // a 0.4-unit floor keeps the smallest bar on a busy chart
          // present rather than implying no data.
          height: Math.max(Math.abs(baseline - point.y), 0.4),
          color: s.color,
          label,
          seriesName: s.name,
          value: point.value,
        });
      });
    });
    return out;
  });

  protected readonly slices = computed<PlottedSlice[]>(() => {
    const first = this.resolved()[0];
    if (!first) {
      return [];
    }
    const present = first.points.filter(
      (point): point is { label: string; value: number; color?: string } =>
        point.value !== null
    );
    const total = present.reduce((sum, point) => sum + point.value, 0);
    let offset = 0;
    return present.map((point, index) => {
      const percent = total > 0 ? (point.value / total) * 100 : 0;
      const slice: PlottedSlice = {
        // Per slice, not per series: a doughnut's one series *is* the
        // categories, so the palette indexes the slices — unless the
        // point names its own, for the part-and-remainder case.
        color: point.color ?? PALETTE[index % PALETTE.length],
        label: point.label,
        value: point.value,
        percent,
        dashArray: `${percent} ${100 - percent}`,
        // SVG dashes run clockwise from the offset; a negative running
        // total is what walks each slice to the end of the last.
        dashOffset: -offset,
      };
      offset += percent;
      return slice;
    });
  });

  protected readonly axisLabels = computed(() => {
    const categories = this.categories();
    if (categories.length === 0) {
      return null;
    }
    return { first: categories[0], last: categories[categories.length - 1] };
  });

  protected readonly tableSeries = computed(() =>
    this.type() === 'doughnut'
      ? // "Share" matches what the legend prints, so the two surfaces
        // carry the same two facts rather than the table carrying less.
        [{ name: this.resolved()[0]?.name ?? 'Value' }, { name: 'Share' }]
      : this.resolved().map((series) => ({ name: series.name }))
  );

  protected readonly tableRows = computed(() => {
    if (this.type() === 'doughnut') {
      return this.slices().map((slice) => ({
        label: slice.label,
        cells: [this.format(slice.value, slice.label), this.percent(slice)],
      }));
    }
    const series = this.resolved();
    return this.categories().map((label) => ({
      label,
      cells: series.map((s) => {
        const point = s.points.find((p) => p.label === label);
        // Spelled out, not left blank: an empty cell is indistinguishable
        // from a rendering failure when read aloud.
        return point && point.value !== null ? this.format(point.value, label) : 'No data';
      }),
    }));
  });
}

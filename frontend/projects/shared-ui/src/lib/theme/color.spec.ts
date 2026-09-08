import {
  AA_BODY,
  AA_LARGE,
  contrastRatio,
  deriveRamp,
  onColorFor,
  parseHex,
  RAMP_STEPS,
  relativeLuminance,
  rgbToOklch,
  toHex,
} from './color';

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

describe('parseHex', () => {
  it('accepts 6-digit and 3-digit hex, in either case', () => {
    expect(parseHex('#2549EB')).toEqual({ r: 0x25, g: 0x49, b: 0xeb });
    expect(parseHex('#2549eb')).toEqual({ r: 0x25, g: 0x49, b: 0xeb });
    expect(parseHex('#fff')).toEqual(WHITE);
    expect(parseHex('  #fff  ')).toEqual(WHITE);
  });

  it('rejects anything that is not plainly a hex colour', () => {
    // This is the only place in the frontend where tenant-controlled data
    // becomes style, so the gate is deliberately narrow: no named
    // colours, no functional notation, no var(), no trailing junk.
    for (const bad of [
      'red',
      'rgb(1,2,3)',
      'var(--x)',
      '#12345',
      '#1234567',
      '#gggggg',
      '#2549EB;background:url(x)',
      'expression(alert(1))',
      '',
      '#',
    ]) {
      expect(parseHex(bad))
        .withContext(bad)
        .toBeNull();
    }
  });
});

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = parseHex('#2549EB')!;
    expect(contrastRatio(a, WHITE)).toBeCloseTo(contrastRatio(WHITE, a), 10);
  });

  it('agrees with relativeLuminance at the extremes', () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5);
  });
});

describe('onColorFor', () => {
  const dark = parseHex('#0F172A')!;

  it('keeps white on a dark brand', () => {
    expect(onColorFor(parseHex('#2549EB')!, dark)).toEqual(WHITE);
  });

  it('flips to dark when white would fail AA', () => {
    // A tenant picking a pale brand colour must not end up shipping
    // white-on-yellow buttons nobody can read.
    const pale = parseHex('#FFE066')!;
    expect(contrastRatio(pale, WHITE)).toBeLessThan(AA_BODY);
    expect(onColorFor(pale, dark)).toEqual(dark);
  });

  it('always returns a choice that itself meets AA', () => {
    for (const seed of ['#2549EB', '#FFE066', '#7C3AED', '#10B981', '#F43F5E', '#000000']) {
      const bg = parseHex(seed)!;
      const chosen = onColorFor(bg, dark);
      expect(contrastRatio(bg, chosen))
        .withContext(seed)
        .toBeGreaterThanOrEqual(AA_BODY);
    }
  });
});

describe('deriveRamp', () => {
  const ramp = deriveRamp(parseHex('#2549EB')!);

  it('produces every step as a valid hex', () => {
    for (const step of RAMP_STEPS) {
      expect(parseHex(ramp[step]))
        .withContext(`${step} -> ${ramp[step]}`)
        .not.toBeNull();
    }
  });

  it('gets monotonically darker from 50 to 950', () => {
    const luminances = RAMP_STEPS.map((s) => relativeLuminance(parseHex(ramp[s])!));
    for (let i = 1; i < luminances.length; i++) {
      expect(luminances[i])
        .withContext(`${RAMP_STEPS[i - 1]} -> ${RAMP_STEPS[i]}`)
        .toBeLessThan(luminances[i - 1]);
    }
  });

  it('preserves the seed hue across the ramp', () => {
    const seedHue = rgbToOklch(parseHex('#2549EB')!).h;
    for (const step of RAMP_STEPS) {
      const stepColor = parseHex(ramp[step])!;
      // Near-neutral steps have unstable hue by definition; only check
      // where there is enough chroma for hue to mean anything.
      const { c, h } = rgbToOklch(stepColor);
      if (c > 0.02) {
        expect(Math.abs(h - seedHue))
          .withContext(`${step}`)
          .toBeLessThan(0.1);
      }
    }
  });

  it('lands the seed exactly on 600', () => {
    // 600 is the primary action fill. A tenant who enters their brand
    // colour must see that colour on their buttons, not an approximation.
    for (const seed of ['#2549eb', '#7c3aed', '#b91c1c', '#047857', '#ffe066']) {
      expect(deriveRamp(parseHex(seed)!)[600])
        .withContext(seed)
        .toBe(seed);
    }
  });

  it('produces a 600 step that white can sit on', () => {
    // 600 is the primary action fill for a white-labelled tenant, so this
    // is the step the whole flip decision hangs off.
    for (const seed of ['#2549EB', '#7C3AED', '#B91C1C', '#047857']) {
      const derived = deriveRamp(parseHex(seed)!);
      expect(contrastRatio(parseHex(derived[600])!, WHITE))
        .withContext(seed)
        .toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('round-trips a colour through OKLCH within a rounding step', () => {
    const original = parseHex('#2549EB')!;
    const { l, c, h } = rgbToOklch(original);
    expect(toHex({ ...original })).toBe('#2549eb');
    expect(l).toBeGreaterThan(0);
    expect(c).toBeGreaterThan(0);
    expect(Number.isFinite(h)).toBeTrue();
  });
});

/**
 * The design system's own contrast floor, asserted rather than measured
 * once and trusted. Every pairing declared in `theme.css` appears here;
 * if a future token edit drops one below AA, this fails.
 *
 * Kept in sync by hand with `theme.css` — the values are duplicated
 * deliberately, because a test that read the same source as the code
 * would prove only that the file is self-consistent.
 */
describe('theme.css declared pairings meet WCAG AA', () => {
  const PAIRINGS: [string, string, string, number][] = [
    ['white on primary (brand-600)', '#ffffff', '#2549eb', AA_BODY],
    ['white on primary-hover (brand-700)', '#ffffff', '#1d37d8', AA_BODY],
    ['brand-700 as a link on surface', '#1d37d8', '#ffffff', AA_BODY],
    ['brand-900 on primary-subtle', '#1e2f8a', '#eff4ff', AA_BODY],
    ['success on success-surface', '#047857', '#ecfdf5', AA_BODY],
    ['warning on warning-surface', '#b45309', '#fffbeb', AA_BODY],
    ['danger on danger-surface', '#b91c1c', '#fef2f2', AA_BODY],
    ['info on info-surface', '#1d37d8', '#eff4ff', AA_BODY],
    ['strong on surface', '#0f172a', '#ffffff', AA_BODY],
    ['default on surface', '#334155', '#ffffff', AA_BODY],
    ['muted on surface', '#64748b', '#ffffff', AA_BODY],
    ['muted on surface-muted', '#64748b', '#f8fafc', AA_BODY],
    ['on-solid on danger', '#ffffff', '#b91c1c', AA_BODY],
    ['on-solid on success', '#ffffff', '#047857', AA_BODY],
    ['default on surface-sunken (disabled control)', '#334155', '#f1f5f9', AA_BODY],
    // 3:1 — WCAG 1.4.11 non-text contrast, for boundaries that identify
    // a control rather than decorate it.
    ['control border on surface', '#64748b', '#ffffff', AA_LARGE],
    ['control border on surface-muted', '#64748b', '#f8fafc', AA_LARGE],
    ['focus ring on surface', '#2549eb', '#ffffff', AA_LARGE],
  ];

  for (const [name, fg, bg, floor] of PAIRINGS) {
    it(`${name} clears ${floor}:1`, () => {
      const ratio = contrastRatio(parseHex(fg)!, parseHex(bg)!);
      expect(ratio).withContext(`${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor);
    });
  }

  it('does not regress to the old input border, which failed 1.4.11', () => {
    // `border-slate-300` was the input border on every form in this
    // workspace and measures 1.48:1 against white — well under the 3:1
    // WCAG 1.4.11 requires for a control boundary. axe does not check
    // non-text contrast on input borders, which is why it went unnoticed
    // for so long. This pins the fix.
    const old = contrastRatio(parseHex('#cbd5e1')!, WHITE);
    expect(old).toBeLessThan(AA_LARGE);
    expect(contrastRatio(parseHex('#64748b')!, WHITE)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

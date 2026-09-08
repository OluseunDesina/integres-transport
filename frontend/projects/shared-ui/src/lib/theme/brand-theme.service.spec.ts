import { TestBed } from '@angular/core/testing';

import { BrandThemeService } from './brand-theme.service';
import { contrastRatio, parseHex, AA_BODY } from './color';

describe('BrandThemeService', () => {
  let service: BrandThemeService;

  function property(name: string): string {
    return document.documentElement.style.getPropertyValue(name).trim();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BrandThemeService);
    service.reset();
  });

  afterEach(() => service.reset());

  it('applies the tenant colour as the 600 step', () => {
    service.apply({ primary: '#7c3aed' });

    expect(property('--color-brand-600')).toBe('#7c3aed');
  });

  it('derives the whole ramp, not just the one supplied step', () => {
    service.apply({ primary: '#7c3aed' });

    for (const step of [50, 100, 200, 300, 400, 500, 700, 800, 900, 950]) {
      expect(property(`--color-brand-${step}`))
        .withContext(`${step}`)
        .toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps white on a dark brand', () => {
    service.apply({ primary: '#2549eb' });

    expect(property('--color-on-primary')).toBe('#ffffff');
  });

  it('flips the on-primary colour when white would be unreadable', () => {
    // The failure this exists to prevent: a tenant picks a pale brand and
    // ships white-on-yellow buttons.
    service.apply({ primary: '#ffe066' });

    const onPrimary = property('--color-on-primary');
    expect(onPrimary).not.toBe('#ffffff');
    expect(contrastRatio(parseHex('#ffe066')!, parseHex(onPrimary)!)).toBeGreaterThanOrEqual(
      AA_BODY
    );
  });

  it('ignores anything that is not plainly a hex colour', () => {
    for (const bad of ['red', 'rgb(1,2,3)', 'var(--x)', '#12345', 'url(javascript:1)', '']) {
      service.reset();
      service.apply({ primary: bad });
      expect(property('--color-brand-600'))
        .withContext(bad)
        .toBe('');
    }
  });

  it('does nothing when there is no branding at all', () => {
    service.apply(null);
    service.apply(undefined);
    service.apply({});

    expect(property('--color-brand-600')).toBe('');
  });

  it('reset() restores the default identity', () => {
    service.apply({ primary: '#7c3aed' });
    service.reset();

    expect(property('--color-brand-600')).toBe('');
    expect(property('--color-on-primary')).toBe('');
  });

  it('is idempotent — re-applying replaces rather than accumulates', () => {
    service.apply({ primary: '#7c3aed' });
    service.apply({ primary: '#047857' });

    expect(property('--color-brand-600')).toBe('#047857');
  });
});
